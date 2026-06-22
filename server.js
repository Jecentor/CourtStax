// CourtStax backend — plain Node.js, no external dependencies.
// Run with: node server.js
// Serves the frontend from /public AND a JSON API under /api/*.
//
// Multi-tenant: every club gets its own isolated session, identified by a
// short code (e.g. "K7QX2P"). A club in Manila and a club in Toronto can
// both use the same deployed server without ever seeing each other's data.
// All sessions persist to one data.json so a server restart doesn't lose them.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- session model ----------
function freshSession(clubName) {
  return {
    clubName: clubName || "Open Play",
    createdAt: Date.now(),
    round: 1,
    courtsCount: 2,
    courts: [
      { id: 1, players: [], startedAt: null },
      { id: 2, players: [], startedAt: null },
    ],
    queue: [],
    players: {}, // id -> player object
    pairHistory: {}, // "id1|id2" sorted -> count
    oppHistory: {},
    duprSettings: {
      clubId: "",
      apiKey: "",
      configured: false,
      lastSyncAt: null,
      lastSyncResult: null, // { ok: bool, message: string }
    },
  };
}

// all sessions live here, keyed by club code, e.g. sessions["K7QX2P"]
let sessions = loadSessions();

function loadSessions() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const loaded = JSON.parse(raw);
    // tolerate older single-session data.json files from before multi-tenancy
    if (loaded && loaded.players && !loaded.sessions) {
      return { LEGACY1: { ...freshSession("Open Play"), ...loaded } };
    }
    return loaded.sessions || {};
  } catch (e) {
    return {};
  }
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify({ sessions }, null, 2), (err) => {
      if (err) console.error("Failed to save state:", err);
    });
  }, 150);
}

// ---------- club code generation ----------
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion
function generateCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");
  } while (sessions[code]); // re-roll on the astronomically unlikely collision
  return code;
}

// ---------- helpers ----------
function uid() {
  return crypto.randomBytes(5).toString("hex");
}

function pairKey(a, b) {
  return [a, b].sort().join("|");
}

function makePlayer(name, skill) {
  return {
    id: uid(),
    name,
    skill,
    declaredSkill: skill,
    status: "ready", // ready | resting | leaving | injured
    checkedInAt: Date.now(),
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    sitOutStreak: 0,
    lastPlayedRound: 0,
    winStreak: 0,
    flags: 0,
    duprId: "",
    duprConnected: false,
  };
}

// fairness sort: longest sit-out streak first, then fewest games played, then earliest check-in
function sortedQueue(s, ids) {
  return [...ids].sort((a, b) => {
    const pa = s.players[a], pb = s.players[b];
    if (!pa || !pb) return 0;
    if (pb.sitOutStreak !== pa.sitOutStreak) return pb.sitOutStreak - pa.sitOutStreak;
    if (pa.gamesPlayed !== pb.gamesPlayed) return pa.gamesPlayed - pb.gamesPlayed;
    return pa.checkedInAt - pb.checkedInAt;
  });
}

// pick the best 2v2 split of 4 players: balances skill, avoids repeat partners/opponents
function bestSplit(s, four) {
  const [w, x, y, z] = four;
  const partitions = [
    { a: [w, x], b: [y, z] },
    { a: [w, y], b: [x, z] },
    { a: [w, z], b: [x, y] },
  ];
  const skillOf = (id) => (s.players[id] || { skill: 3 }).skill;

  let best = null, bestScore = Infinity;
  for (const part of partitions) {
    const skillDiff = Math.abs(
      (skillOf(part.a[0]) + skillOf(part.a[1])) - (skillOf(part.b[0]) + skillOf(part.b[1]))
    );
    const partnerPenalty =
      (s.pairHistory[pairKey(...part.a)] || 0) + (s.pairHistory[pairKey(...part.b)] || 0);
    const oppPenalty = part.a.reduce(
      (acc, pa) => acc + part.b.reduce((acc2, pb) => acc2 + (s.oppHistory[pairKey(pa, pb)] || 0), 0),
      0
    );
    const score = skillDiff * 2 + partnerPenalty * 3 + oppPenalty * 1;
    if (score < bestScore) { bestScore = score; best = part; }
  }
  return best;
}

function recordPairings(s, part) {
  s.pairHistory[pairKey(...part.a)] = (s.pairHistory[pairKey(...part.a)] || 0) + 1;
  s.pairHistory[pairKey(...part.b)] = (s.pairHistory[pairKey(...part.b)] || 0) + 1;
  part.a.forEach((pa) =>
    part.b.forEach((pb) => {
      const k = pairKey(pa, pb);
      s.oppHistory[k] = (s.oppHistory[k] || 0) + 1;
    })
  );
}

function syncCourtsCount(s, count) {
  const next = [...s.courts];
  while (next.length < count) next.push({ id: next.length + 1, players: [], startedAt: null });
  while (next.length > count) {
    const removed = next.pop();
    if (removed.players.length) s.queue.push(...removed.players);
  }
  s.courts = next;
  s.courtsCount = count;
}

function bumpSitoutsIfAnyCourtFull(s) {
  const anyFull = s.courts.some((c) => c.players.length === 4);
  if (anyFull && s.queue.length) {
    s.queue.forEach((id) => {
      const p = s.players[id];
      if (p) p.sitOutStreak += 1;
    });
  }
}

// ---------- action handlers ----------
// every action receives (s, payload) where s is THIS session's state only —
// actions never touch any other club's data.
const actions = {
  checkin(s, { name, skill }) {
    if (!name || !name.trim()) throw new Error("Name required");
    const p = makePlayer(name.trim(), parseFloat(skill) || 3.0);
    s.players[p.id] = p;
    s.queue.push(p.id);
  },

  setStatus(s, { id, status }) {
    const p = s.players[id];
    if (!p) throw new Error("Player not found");
    p.status = status;
    s.queue = s.queue.filter((pid) => pid !== id);
    if (status === "ready") s.queue.push(id);
  },

  removePlayer(s, { id }) {
    delete s.players[id];
    s.queue = s.queue.filter((pid) => pid !== id);
    s.courts.forEach((c) => { c.players = c.players.filter((pid) => pid !== id); });
  },

  connectDupr(s, { id, duprId }) {
    const p = s.players[id];
    if (!p) throw new Error("Player not found");
    p.duprId = duprId || "";
    p.duprConnected = !!(duprId && duprId.trim());
  },

  setDuprSettings(s, { clubId, apiKey }) {
    s.duprSettings.clubId = (clubId || "").trim();
    s.duprSettings.apiKey = (apiKey || "").trim();
    s.duprSettings.configured = !!(s.duprSettings.clubId && s.duprSettings.apiKey);
  },

  // ---- DUPR sync -----------------------------------------------------
  // THIS IS A DELIBERATE STUB, NOT A REAL INTEGRATION.
  // DUPR's match-results API is only available to approved partners, and
  // calling it requires:
  //   1. An approved partner/club account from DUPR (apply at dashboard.dupr.com
  //      or via their partner program — manual approval, not self-serve).
  //   2. Real API credentials (club ID + API key) issued by DUPR after approval.
  //   3. DUPR's actual endpoint URLs and request/response schema, only shared
  //      with approved partners — we don't have access to that documentation.
  //
  // Once a club has real credentials and DUPR's API docs, replace the body of
  // this function with an actual fetch() call to their match-results
  // endpoint, sending each completed game's two team rosters + winner.
  syncDupr(s) {
    if (!s.duprSettings.configured) {
      throw new Error("Add a DUPR Club ID and API key in DUPR Settings first.");
    }
    const result = {
      ok: false,
      message:
        "DUPR sync is not yet live — this app doesn't have real DUPR API access. " +
        "Apply for DUPR's partner program to get real credentials and API docs, " +
        "then this button can be wired to their actual endpoint.",
    };
    s.duprSettings.lastSyncAt = Date.now();
    s.duprSettings.lastSyncResult = result;
    return result;
  },

  setCourtsCount(s, { count }) {
    syncCourtsCount(s, Math.max(1, Math.min(12, parseInt(count, 10) || 1)));
  },

  setClubName(s, { clubName }) {
    if (!clubName || !clubName.trim()) throw new Error("Club name required");
    s.clubName = clubName.trim().slice(0, 60);
  },

  fillCourt(s, { courtId }) {
    const ordered = sortedQueue(s, s.queue);
    if (ordered.length < 4) throw new Error("Not enough players waiting");
    const four = ordered.slice(0, 4);
    s.queue = s.queue.filter((id) => !four.includes(id));

    const split = bestSplit(s, four);
    const arranged = [...split.a, ...split.b];

    const court = s.courts.find((c) => c.id === courtId);
    if (!court) throw new Error("Court not found");
    court.players = arranged;
    court.startedAt = Date.now();

    four.forEach((id) => {
      const p = s.players[id];
      if (p) { p.sitOutStreak = 0; p.lastPlayedRound = s.round; }
    });

    recordPairings(s, split);
    bumpSitoutsIfAnyCourtFull(s);
  },

  recordWinner(s, { courtId, side }) {
    const court = s.courts.find((c) => c.id === courtId);
    if (!court || court.players.length < 4) throw new Error("Court is not full");
    const [p1, p2, p3, p4] = court.players;

    court.players.forEach((id) => {
      const p = s.players[id];
      if (!p) return;
      const onA = id === p1 || id === p2;
      const won = side === "A" ? onA : !onA;
      p.gamesPlayed += 1;
      if (won) { p.wins += 1; p.winStreak += 1; } else { p.losses += 1; p.winStreak = 0; }
      if (p.winStreak === 3) p.flags += 1;
    });

    s.queue.push(...court.players);
    court.players = [];
    court.startedAt = null;
    s.round += 1;
    bumpSitoutsIfAnyCourtFull(s);
  },
};

// ---------- HTTP server ----------
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
};

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(PUBLIC_DIR, decodeURIComponent(filePath.split("?")[0]));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS so the frontend can be hosted separately from the API if needed
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url.split("?")[0];

  // ---- create a brand new club session ----
  // POST /api/session  { clubName }  -> { code, ...sessionState }
  if (url === "/api/session" && req.method === "POST") {
    try {
      const { clubName } = await readBody(req);
      const code = generateCode();
      sessions[code] = freshSession(clubName);
      persist();
      return send(res, 200, { code, ...sessions[code] });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // ---- fetch a specific club's live state ----
  // GET /api/session/:code/state
  let m = url.match(/^\/api\/session\/([A-Z0-9]+)\/state$/);
  if (m && req.method === "GET") {
    const code = m[1];
    const s = sessions[code];
    if (!s) return send(res, 404, { error: "No club session found for that code." });
    return send(res, 200, { code, ...s });
  }

  // ---- run an action against a specific club's session ----
  // POST /api/session/:code/action/:actionName
  m = url.match(/^\/api\/session\/([A-Z0-9]+)\/action\/([a-zA-Z]+)$/);
  if (m && req.method === "POST") {
    const code = m[1], actionName = m[2];
    const s = sessions[code];
    if (!s) return send(res, 404, { error: "No club session found for that code." });
    const fn = actions[actionName];
    if (!fn) return send(res, 404, { error: "Unknown action" });

    try {
      const payload = await readBody(req);
      fn(s, payload);
      persist();
      return send(res, 200, { code, ...s });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // everything else: static files (the frontend)
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`CourtStax server running at http://localhost:${PORT}`);
  console.log(`Other devices on the same Wi-Fi can use http://<your-computer's-IP>:${PORT}`);
});

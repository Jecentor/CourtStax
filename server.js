// CourtStax backend — plain Node.js, no external dependencies.
// Run with: node server.js
// Serves the frontend from /public AND a JSON API under /api/*.
// State is persisted to data.json so a server restart doesn't lose a session.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- persistence ----------
function freshState() {
  return {
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
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return freshState();
  }
}

let saveTimer = null;
function saveState() {
  // debounce writes slightly so rapid actions don't thrash the disk
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error("Failed to save state:", err);
    });
  }, 150);
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
function sortedQueue(ids) {
  return [...ids].sort((a, b) => {
    const pa = state.players[a], pb = state.players[b];
    if (!pa || !pb) return 0;
    if (pb.sitOutStreak !== pa.sitOutStreak) return pb.sitOutStreak - pa.sitOutStreak;
    if (pa.gamesPlayed !== pb.gamesPlayed) return pa.gamesPlayed - pb.gamesPlayed;
    return pa.checkedInAt - pb.checkedInAt;
  });
}

// pick the best 2v2 split of 4 players: balances skill, avoids repeat partners/opponents
function bestSplit(four) {
  const [w, x, y, z] = four;
  const partitions = [
    { a: [w, x], b: [y, z] },
    { a: [w, y], b: [x, z] },
    { a: [w, z], b: [x, y] },
  ];
  const skillOf = (id) => (state.players[id] || { skill: 3 }).skill;

  let best = null, bestScore = Infinity;
  for (const part of partitions) {
    const skillDiff = Math.abs(
      (skillOf(part.a[0]) + skillOf(part.a[1])) - (skillOf(part.b[0]) + skillOf(part.b[1]))
    );
    const partnerPenalty =
      (state.pairHistory[pairKey(...part.a)] || 0) + (state.pairHistory[pairKey(...part.b)] || 0);
    const oppPenalty = part.a.reduce(
      (s, pa) => s + part.b.reduce((s2, pb) => s2 + (state.oppHistory[pairKey(pa, pb)] || 0), 0),
      0
    );
    const score = skillDiff * 2 + partnerPenalty * 3 + oppPenalty * 1;
    if (score < bestScore) { bestScore = score; best = part; }
  }
  return best;
}

function recordPairings(part) {
  state.pairHistory[pairKey(...part.a)] = (state.pairHistory[pairKey(...part.a)] || 0) + 1;
  state.pairHistory[pairKey(...part.b)] = (state.pairHistory[pairKey(...part.b)] || 0) + 1;
  part.a.forEach((pa) =>
    part.b.forEach((pb) => {
      const k = pairKey(pa, pb);
      state.oppHistory[k] = (state.oppHistory[k] || 0) + 1;
    })
  );
}

function syncCourtsCount(count) {
  const next = [...state.courts];
  while (next.length < count) next.push({ id: next.length + 1, players: [], startedAt: null });
  while (next.length > count) {
    const removed = next.pop();
    if (removed.players.length) state.queue.push(...removed.players);
  }
  state.courts = next;
  state.courtsCount = count;
}

function bumpSitoutsIfAnyCourtFull() {
  const anyFull = state.courts.some((c) => c.players.length === 4);
  if (anyFull && state.queue.length) {
    state.queue.forEach((id) => {
      const p = state.players[id];
      if (p) p.sitOutStreak += 1;
    });
  }
}

// ---------- action handlers ----------
const actions = {
  checkin({ name, skill }) {
    if (!name || !name.trim()) throw new Error("Name required");
    const p = makePlayer(name.trim(), parseFloat(skill) || 3.0);
    state.players[p.id] = p;
    state.queue.push(p.id);
  },

  setStatus({ id, status }) {
    const p = state.players[id];
    if (!p) throw new Error("Player not found");
    p.status = status;
    state.queue = state.queue.filter((pid) => pid !== id);
    if (status === "ready") state.queue.push(id);
  },

  removePlayer({ id }) {
    delete state.players[id];
    state.queue = state.queue.filter((pid) => pid !== id);
    state.courts.forEach((c) => { c.players = c.players.filter((pid) => pid !== id); });
  },

  connectDupr({ id, duprId }) {
    const p = state.players[id];
    if (!p) throw new Error("Player not found");
    p.duprId = duprId || "";
    p.duprConnected = !!(duprId && duprId.trim());
  },

  setCourtsCount({ count }) {
    syncCourtsCount(Math.max(1, Math.min(12, parseInt(count, 10) || 1)));
  },

  fillCourt({ courtId }) {
    const ordered = sortedQueue(state.queue);
    if (ordered.length < 4) throw new Error("Not enough players waiting");
    const four = ordered.slice(0, 4);
    state.queue = state.queue.filter((id) => !four.includes(id));

    const split = bestSplit(four);
    const arranged = [...split.a, ...split.b];

    const court = state.courts.find((c) => c.id === courtId);
    if (!court) throw new Error("Court not found");
    court.players = arranged;
    court.startedAt = Date.now();

    four.forEach((id) => {
      const p = state.players[id];
      if (p) { p.sitOutStreak = 0; p.lastPlayedRound = state.round; }
    });

    recordPairings(split);
    bumpSitoutsIfAnyCourtFull();
  },

  recordWinner({ courtId, side }) {
    const court = state.courts.find((c) => c.id === courtId);
    if (!court || court.players.length < 4) throw new Error("Court is not full");
    const [p1, p2, p3, p4] = court.players;

    court.players.forEach((id) => {
      const p = state.players[id];
      if (!p) return;
      const onA = id === p1 || id === p2;
      const won = side === "A" ? onA : !onA;
      p.gamesPlayed += 1;
      if (won) { p.wins += 1; p.winStreak += 1; } else { p.losses += 1; p.winStreak = 0; }
      if (p.winStreak === 3) p.flags += 1;
    });

    state.queue.push(...court.players);
    court.players = [];
    court.startedAt = null;
    state.round += 1;
    bumpSitoutsIfAnyCourtFull();
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

const server = http.createServer((req, res) => {
  // CORS so the frontend can be hosted separately from the API if needed
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/api/state" && req.method === "GET") {
    return send(res, 200, state);
  }

  const actionMatch = req.url.match(/^\/api\/action\/([a-zA-Z]+)$/);
  if (actionMatch && req.method === "POST") {
    const actionName = actionMatch[1];
    const fn = actions[actionName];
    if (!fn) return send(res, 404, { error: "Unknown action" });

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        fn(payload);
        saveState();
        send(res, 200, state);
      } catch (e) {
        send(res, 400, { error: e.message });
      }
    });
    return;
  }

  if (req.url === "/api/reset" && req.method === "POST") {
    state = freshState();
    saveState();
    return send(res, 200, state);
  }

  // everything else: static files (the frontend)
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`CourtStax server running at http://localhost:${PORT}`);
  console.log(`Other devices on the same Wi-Fi can use http://<your-computer's-IP>:${PORT}`);
});

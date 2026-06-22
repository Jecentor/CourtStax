# CourtStax — backend-connected version

This adds a real shared backend so multiple phones/devices see the *same* live
session, which the single-file demo could not do. No build step, no paid
services required.

## What changed from the demo

- `server.js` — a plain Node.js server (zero npm installs needed). Holds the
  session in memory, persists it to `data.json` on every change, and serves
  the frontend.
- `public/index.html` — the same UI as before, but it no longer keeps state in
  the browser. It polls `GET /api/state` every 1.5s and sends actions to
  `POST /api/action/<name>`, so every device looking at it sees the same
  queue, courts, and scores.
- Matchup optimization (skill balance, partner/opponent variety) and queue
  fairness logic both moved server-side, so they apply consistently no matter
  which device triggers an action.

## Run it locally

```
cd courtstax-backend
node server.js
```

Then open `http://localhost:3000` in a browser. That's it — no `npm install`,
since the server only uses Node's built-in modules.

## Test it with multiple "devices" on your Wi-Fi

1. Find your computer's local IP (e.g. `192.168.1.42`) — on Mac/Linux:
   `ifconfig | grep inet`; on Windows: `ipconfig`.
2. Make sure your firewall allows incoming connections on port 3000.
3. On your phone (same Wi-Fi network), open `http://192.168.1.42:3000`.
4. Now your phone and your laptop are looking at the *same* live session —
   check someone in on one device, and it shows up on the other within ~1.5s.
5. The "Generate QR" button's code now actually works for this: scan it from
   a phone on the same network and it'll open straight into the live
   turn-order board.

This is enough to **beta test at a single real open-play session**, as long
as everyone's phone is on the same Wi-Fi as the computer running the server.

## Deploy to Render (recommended — built for this kind of app)

This project includes a `render.yaml` so deployment is mostly automatic.

1. Push this folder to a GitHub repo (Render deploys from a Git repo).
2. Go to https://render.com → New → Blueprint → connect your repo.
3. Render reads `render.yaml` automatically: it will create a free web
   service running `node server.js`.

   **Note on data persistence:** Render's free tier doesn't support
   persistent disks at all (that's a paid-tier feature). This means
   `data.json` lives only on the service's temporary filesystem — it
   survives fine while the service is running, but resets whenever Render
   restarts the service (which it does automatically after ~15 minutes of
   inactivity, or on a redeploy). For beta testing this is usually fine:
   worst case, you re-check people in if a restart happens mid-session.

   **If you want session data to survive restarts:** upgrade the service to
   a paid instance type in the Render dashboard (starts around $7/mo), then
   add a disk back yourself: Render dashboard → your service → Disks → Add
   Disk → mount path `/data` → and set an environment variable `DATA_DIR=/data`
   in the dashboard's Environment tab. No code changes needed — `server.js`
   already checks for `DATA_DIR` and uses it when present.
4. Once deployed, Render gives you a public URL like
   `https://courtstax.onrender.com` — that works from any phone, any network,
   no Wi-Fi requirement.
5. The "Generate QR" button will now produce a QR code that works for real,
   from anywhere — not just your local Wi-Fi.

Note: Render's free tier spins the server down after inactivity and takes a
few seconds to wake back up on the next request — fine for testing, worth
upgrading to a paid instance before a real event if that pause would be
disruptive.

### Alternatives
Railway and Fly.io both also run long-lived Node servers like this one with
no code changes — if you'd rather use one of those, the same `server.js`
works as-is; you'd just skip `render.yaml` and follow that platform's own
deploy flow (`railway up` or `fly launch`, respectively).

## What's still NOT ready for a public/internet-wide beta

- **No authentication** — anyone who can reach the server can do anything
  (check players in, record scores, remove people). Fine for one trusted
  organizer at a single session; not fine once it's public.
- **No real DUPR integration** — the "Connect DUPR" field just stores text.
  Actually syncing ratings requires applying for DUPR's official partner API.
- **Single JSON file storage** — fine for one club's one-night session. Not
  built for many simultaneous clubs/sessions — that needs a real database
  (Postgres, SQLite-per-session, etc.) and a concept of separate "sessions"
  with their own URL/code.
- **No HTTPS** — needed before this touches the public internet.
- **Polling, not push** — updates take up to 1.5s to appear on other devices.
  Fine for this use case, but a future version could use WebSockets for
  instant updates.

## Suggested next steps, in order

1. Beta test locally on Wi-Fi first (cheapest way to catch UX issues fast).
2. Deploy to Render using the steps above so it works over the real internet.
3. If that goes well: add a simple session code/PIN so multiple clubs could
   each run their own session on one deployed server.
4. Only after that: look into DUPR's partner program if real rating sync
   matters to your users.

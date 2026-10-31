# Squeekroom

A cozy side-view pixel room with a hamster on a wheel, and the hamster is real: the wheel spins at Squeektoshi's live rpm while he runs and he naps in the burrow when he doesn't. Every settled Squeek block generates watts for every room, whether you are online or not, and watts buy cosmetics: furniture, wall decor, wallpaper, flooring, skins, room materials, and wheel and bed upgrades (the only items that change how much you earn). While he naps, every room earns a slower trickle from its bed. Nothing in the game asks the hamster to do anything; the one interactive bonus is for keeping the page open. It rewards watching, never running. Reach 250,000 lifetime watts over 7 active days and you can claim a free commemorative certificate (a PNG and its JSON, no chain, no wallet). No login, an anonymous token in `localStorage` is your room.

Zero dependencies. Node 18+.

## Run

```bash
node squeekroom/server.js
```

Open http://localhost:8788. Live mode reads `SqueekCore.state()` on Sepolia every 10 s through public RPC (`ethereum-sepolia-rpc.publicnode.com`, falling back to `1rpc.io/sepolia`) and pays every room for each new settled `blockHeight`. The room server is born at the height seen on first boot; nobody earns for blocks before that, or before they joined. The live wheel reading (running/napping, speed, rpm) is fetched by the browser from `api.squeekchain.com`, which sits behind a Cloudflare challenge that blocks many hosting providers' IPs; the server also tries it, and the page falls back to the server's copy, then to "napping".

Env: `PORT` (default 8788), `DATA_DIR`, `CORE_ADDRESS` (default `0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44`), `SEPOLIA_RPC` (comma-separated), `SQUEEK_API`.

Demo mode adds a strip of buttons (+1 block, +10, +1 day, grant 50k W, run a scripted 4-minute night) so you can watch the economy without waiting for the hamster:

```bash
node squeekroom/server.js --demo
```

Before going live, delete the demo state so every room restarts from the real height:

```bash
rm -f squeekroom/data/state.json
```

Tests (accrual math, buy rules, placement, heartbeat, certificate eligibility, bed income, config/state split):

```bash
node --test squeekroom/test/
```

`/dev-sprites.html` shows every sprite, animation and skin at 4x on a checkerboard.

## Deploy

All rooms live in one JSON file, so the host needs a persistent disk mounted at `DATA_DIR`.

- **Render**: `render.yaml` is included. In the Render dashboard, New → Blueprint → pick this repo. It ships on the free plan, which has no disk: `state.json` resets on every restart. For durable rooms switch to `plan: starter` and uncomment the `DATA_DIR` + `disk` block (1 GB at `/var/data`).
- **Railway**: New Project → Deploy from GitHub → this repo (`railway.json` + `Dockerfile` are picked up). Then add a Volume mounted at `/data`.
- **Fly.io**: `fly launch` (Dockerfile detected), `fly volumes create data`, mount at `/data`.
- **Any VPS / Docker**: `docker build -t squeekroom . && docker run -p 8788:8788 -v squeekroom_data:/data squeekroom`

## How it works

- `server.js`: polls the chain, credits every room, keeps `data/state.json` (atomic tmp + rename, at most one write a second), serves the page and a small JSON API.
  - `GET /api/config` the static rules, fetched once per page load: `balance`, `room` grid, `catalog`, `demo`, `core`, `api`.
  - `GET /api/state?token=…` the dynamic data the page polls every 5 s: height, chain, live reading, `idle` (asleep by the chain: bed income is flowing), and `me` (created on first visit with a 400 W welcome grant).
  - `POST /api/buy {token, itemId}` price checked on the server. Wheel, bed and room-material upgrades each go strictly in order (one copy each; buying sets `wheelTier` / `bedTier` / `roomTier`); wallpaper, flooring and skins are single-copy; placeables are unlimited. Errors: `unknown_item`, `poor` (+ `need`), `wrong_tier`, `already_owned`.
  - `POST /api/place {token, itemId, x, y, flip}`, `/api/move {token, pid, x, y, flip}`, `/api/remove {token, pid}` every placement is re-validated: zone, bounds, overlap, and the reserved wheel (floor cols 3–6) and burrow (16–18).
  - `POST /api/skin {token, skinId}`, `POST /api/style {token, wallpaper?, floor?}` equip something you own.
  - `POST /api/nick {token, nick}` your room's name (20 chars).
  - `POST /api/heartbeat {token}` the page sends this while it is visible; rate-limited to one stamp per 20 s.
  - `POST /api/claim-commemorative {token}` see below. Errors: `not_eligible` (+ `lifetimeWatts`, `activeDays`, `needLifetimeWatts`, `needActiveDays`).
  - `POST /api/dev/advance {n}`, `/api/dev/grant {token, watts, lifetime?, activeDays?}`, `/api/dev/night {}`, `/api/dev/sleep {}` (winds the chain's sleep clock back 11 minutes so he counts as asleep and beds start earning) demo only.
- Accrual, run for every room whenever the settled height advances (and on catch-up after downtime):

  ```
  earned = round(Δblocks × BASE_WATTS_PER_BLOCK × WHEEL_MULT_PCT[tier]/100 × bonus/100)
  bonus  = LIVE_BONUS_PCT if a heartbeat landed in the last HEARTBEAT_WINDOW_MS, else 100
  ```

  `activeDays` goes up once per UTC day that earned anything. At tier 0 a typical day (~1,078 blocks) is ~10,780 W.
- Bed income: the server judges sleep by the chain, not the status feed: he is asleep when the settled height has not advanced for `IDLE_AFTER_MS` (and, live, the chain was read in the last 2 minutes). Each poll (~10 s) while he sleeps credits every room, online or not, for the real time since the previous poll (at most `BED_TICK_MAX_MS`; nothing for server downtime) at `BED_RATE_PER_MIN × BED_MULT_PCT[bedTier]/100 × bonus/100`, with fractions of a watt carried exactly (`bedFrac`). It counts toward lifetime watts and active days like the wheel.
- `BALANCE` in `server.js` holds every knob: `BASE_WATTS_PER_BLOCK` (10), `WHEEL_MULT_PCT` ([100, 125, 160, 200, 260, 350] for tiers 0–5), `LIVE_BONUS_PCT` (120), `HEARTBEAT_WINDOW_MS` (90 s), `HEARTBEAT_MIN_INTERVAL_MS` (20 s), `WELCOME_WATTS` (400), `CERT_LIFETIME_WATTS` (250,000), `CERT_ACTIVE_DAYS` (7), `IDLE_AFTER_MS` (10 min), `BED_RATE_PER_MIN` (1.5), `BED_MULT_PCT` ([100, 125, 160, 200, 260, 350] for bed tiers 0–5), `BED_TICK_MAX_MS` (60 s). Prices live in `CATALOG` right below it.
- Anti-cheat: the client never sends an amount; the chain height is the only clock and the server computes every watt. Prices, ownership, tier order and placements are checked server-side, and numeric inputs must be integers. The heartbeat is the only farmable input, capped at +20%; bed income is timed by the server for every room alike.
- `public/`: `index.html` (strip, shop, inventory, certificate overlay), `sprites.js` (row-string pixel art in the shared 16-colour palette, `drawSprite()`, skin remaps, live sprites for the clock, window sky and wall TV), `game.js` (state, 320×192 canvas renderer, placement, shop, certificate).

### The commemorative certificate

Claiming is idempotent: the first claim assigns the next global serial and stores a snapshot (`serial`, `seed = sha256(token + claimHeight + serial)`, `tokenFingerprint`, nick, dates, block range, lifetime watts, active days, wheel tier, skin, items owned, and the room layout). Every later claim returns the same JSON. The browser draws a 640×960 PNG from that JSON alone: a seeded pixel frame (corner flourishes, border motif, accent colours), the room re-rendered through the same painters as the live room with the hamster mid-run, and a stats plaque in the 3×5 pixel font. Everything that animates in the room (wheel angle, run frame, window sky, clock hands, the TV) is frozen to values derived from the seed and claim date, so the same JSON always draws the same pixels. Save PNG, Save JSON, and Share (where the browser supports it).

### Limits

Each room is ~1–2 KB, and the whole state is rewritten as one JSON file. That's fine to roughly 10,000 rooms; the server refuses new rooms past `MAX_PLAYERS` (50,000). If it ever gets heavy, prune rooms nobody has opened in months (`lastSeen`) and that hold no certificate, or move `players` to SQLite keyed by token; nothing else in the server cares where a room is stored.

## Ideas for v2

- Leaderboard of rooms: most lifetime watts, oldest wheel, a weekly featured room.
- Stream HUD view: a chrome-free page showing one featured room for the livestream.
- Seasonal items that are only in the shop for a few weeks.
- Foil items for record nights: anything bought during a speed record or milestone from `/v1/events` gets a shimmer.

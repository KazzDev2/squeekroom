# Squeek Den

A cozy 2.5D isometric pixel room with a hamster on a wheel, and the hamster is real: the wheel spins at Squeektoshi's live rpm while he runs and he sleeps in your bed when he doesn't. Every settled Squeek block generates watts for every room, whether you are online or not; while he sleeps, every room earns about half the awake rate from its bed. Watts buy furniture, wall decor, wallpaper, flooring, skins, and three upgrade ladders: wheel (running income), bed (sleeping income) and room material (raid defense). While the hamster RUNS, raids are open: wager watts against any richer room on the electricity leaderboard — win and you loot them, lose and your stake burns. Nothing in the game asks the hamster to do anything; it rewards watching, never running. Reach 500,000 lifetime watts over 7 active days and you can claim a free commemorative certificate (a PNG and its JSON). No login needed — an anonymous token in `localStorage` is your room; optionally link a burner wallet (one gasless signature) to claim a username on the leaderboard.

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
  - `POST /api/place {token, itemId, x, y, flip}`, `/api/move {token, pid, x, y, flip}`, `/api/remove {token, pid}` every placement is re-validated: zone, bounds, overlap, and the reserved burrow (floor cols 16–18).
  - `POST /api/fixture {token, which: "wheel"|"bed", i, j, flip?}` stands the wheel or the bed on floor tile (i, j): anywhere on screen (against the walls too), off furniture, and at least 2 tiles from the other one.
  - `POST /api/skin {token, skinId}`, `POST /api/style {token, wallpaper?, floor?}` equip something you own.
  - `POST /api/nick {token, nick}` your room's name (20 chars).
  - `POST /api/heartbeat {token}` the page sends this while it is visible; rate-limited to one stamp per 20 s.
  - `POST /api/claim-commemorative {token}` see below. Errors: `not_eligible` (+ `lifetimeWatts`, `activeDays`, `needLifetimeWatts`, `needActiveDays`).
  - `POST /api/raid {token, target, stake, mult}` see Raids below. `GET /api/leaderboard?token=…` watts-ranked rooms with per-viewer `raidable`/`revenge` flags (10 s cache).
  - `POST /api/wallet/nonce {token}` → a single-use 10-minute sign-in message (it tells you to use a burner); `POST /api/wallet/verify {token, address, signature}` verifies the EIP-191 personal_sign server-side (pure-JS keccak + secp256k1 in `lib/ethsig.js`, zero deps) and binds the address (one room per wallet); `POST /api/wallet/username {token, username}` wallet-gated, `[A-Za-z0-9_]{3,16}`, unique. Verified names show on the leaderboard and raid feed with a check.
  - `POST /api/dev/advance {n}`, `/api/dev/grant {token, watts, lifetime?, activeDays?}`, `/api/dev/night {}`, `/api/dev/sleep {}` (winds the chain's sleep clock back 11 minutes so he counts as asleep and beds start earning) demo only.
- Accrual, run for every room whenever the settled height advances (and on catch-up after downtime):

  ```
  earned = round(Δblocks × BASE_WATTS_PER_BLOCK × WHEEL_MULT_PCT[tier]/100 × bonus/100 × speedPct/100)
  bonus  = LIVE_BONUS_PCT if a heartbeat landed in the last HEARTBEAT_WINDOW_MS, else 100
  ```

  `activeDays` goes up once per UTC day that earned anything. At tier 0 a typical day (~1,078 blocks) is ~10,780 W before the speed bonus.
- Speed bonus: when he runs fast, the wheel pays more, judged by the chain alone (never the status feed). The server keeps an in-memory ring of `{time, height}` samples (one per advance and one per poll, never saved), and `speedPct = clamp(round(100 × blocks/min over the last SPEED.WINDOW_MS ÷ baseline), 100, SPEED.MAX_PCT)`. The baseline is `SPEED.BASE_BPM` live; in replay it is the schedule's own mean cadence across its runs, so a run's slow edges pay 100% and its fast middle up to 150%. With less than `SPEED.WARMUP_MS` of history (a restart, or a live chain read that failed) it is 100, so catch-up after downtime never pays a windfall. Bed income ignores it. `/api/state` carries `speedPct`; the page shows `⚡ +N%` next to the watching badge while it is above 100.
- Bed income: the server judges sleep by the live status reading while it is fresh (under 2 minutes old): he is asleep once it has not said ACTIVE for 20 s. With no fresh reading it falls back to the chain: asleep when the settled height has not advanced for `IDLE_AFTER_MS` (and, live, the chain was read in the last 2 minutes). Bed income, the raid window and the hamster on screen all follow this one answer. Each poll (~10 s) while he sleeps credits every room, online or not, for the real time since the previous poll (at most `BED_TICK_MAX_MS`; nothing for server downtime) at `BASE_WATTS_PER_BLOCK × speed baseline (blocks/min) × BED_AWAKE_PCT/100 × BED_MULT_PCT[bedTier]/100 × bonus/100` (37.2 W/min at tier 0 in replay at 3×, 20 W/min live), with fractions of a watt carried exactly (`bedFrac`). It counts toward lifetime watts and active days like the wheel.
- `BALANCE` in `server.js` holds every knob: `BASE_WATTS_PER_BLOCK` (10), `WHEEL_MULT_PCT` ([100, 125, 160, 200] for tiers 0–3), `LIVE_BONUS_PCT` (120), `HEARTBEAT_WINDOW_MS` (90 s), `HEARTBEAT_MIN_INTERVAL_MS` (20 s), `WELCOME_WATTS` (10,000), `CERT_LIFETIME_WATTS` (500,000), `CERT_ACTIVE_DAYS` (7), `IDLE_AFTER_MS` (90 s), `BED_AWAKE_PCT` (50), `BED_MULT_PCT` ([100, 125, 160, 200, 260, 350] for bed tiers 0–5), `BED_TICK_MAX_MS` (60 s), `SPEED` (`WINDOW_MS` 10 min, `BASE_BPM` 4, `MAX_PCT` 150, `WARMUP_MS` 2 min). Prices live in `CATALOG` right below it.
- Anti-cheat: the client never sends an amount; the chain height is the only clock and the server computes every watt. Prices, ownership, tier order and placements are checked server-side, and numeric inputs must be integers. The heartbeat is the only farmable input, capped at +20%; bed income is timed by the server for every room alike.
- `public/`: `index.html` (strip, shop, inventory, certificate overlay), `sprites.js` (row-string pixel art in the shared 16-colour palette, `drawSprite()`, skin remaps, live sprites for the clock, window sky and wall TV), `game.js` (state, 320×192 canvas renderer, placement, shop, certificate).

### The commemorative certificate

Claiming is idempotent: the first claim assigns the next global serial and stores a snapshot (`serial`, `seed = sha256(token + claimHeight + serial)`, `tokenFingerprint`, nick, dates, block range, lifetime watts, active days, wheel tier, skin, items owned, and the room layout). Every later claim returns the same JSON. The browser draws a 640×960 PNG from that JSON alone: a seeded pixel frame (corner flourishes, border motif, accent colours), the room re-rendered through the same painters as the live room with the hamster mid-run, and a stats plaque in the 3×5 pixel font. Everything that animates in the room (wheel angle, run frame, window sky, clock hands, the TV) is frozen to values derived from the seed and claim date, so the same JSON always draws the same pixels. Save PNG, Save JSON, and Share (where the browser supports it).

### Limits

Each room is ~1–2 KB, and the whole state is rewritten as one JSON file. That's fine to roughly 10,000 rooms; the server refuses new rooms past `MAX_PLAYERS` (50,000). If it ever gets heavy, prune rooms nobody has opened in months (`lastSeen`) and that hold no certificate, or move `players` to SQLite keyed by token; nothing else in the server cares where a room is stored.

## Raids ("chaos mode")

Raids are open all the time, whether he runs or sleeps. Each player gets 10 raids per UTC day; a room can be raided any number of times.

- Wager: stake `S` at 1.5×, 2×, 3×, 5× or 10×. The raid screen shows the odds and the loot range, never the EV.
- Stake bounds: at least `max(50, 5% of your balance)`, so every raid matters; at most your balance, and at most `cap / (M−1)`, the stake whose loot still fits under the target's loot cap. Past that point the cap would eat the win while the loss kept growing, so the game doesn't offer it. Against a small target the high multipliers can be out of reach.
- Win chance: `clamp((110%/M) × (1 − defense) × tilt, 2%, 90%)`, where defense is the target's room material (wood 0% → silver 15%; gold and diamond are looks only) and tilt is `(theirWatts/yourWatts)^0.25` clamped 0.75–1.75. **Punching up** (the target holds at least your watts) lifts it to at least `1/M`.
- Win: loot is exactly `(M−1)×S` (rounded up), taken from the defender, capped at 25% of their balance, so no single raid can empty a room. 5% of wins crit: the game pays the attacker half the loot again on top, minted rather than taken from the defender (counted in `state.minted`). The raid screen shows the chosen multiplier's win chance big and one win amount; pressing Raid opens nine holes, and whacking one rolls the raid on the server (the hole doesn't change the odds). Lose: you lose the stake and all of it burns; the defender gets nothing (a share would let alt dens wager their welcome watts into a main).
- Earned-watts floor: a den can raid, and be raided, only once its lifetime earnings (wheel + bed, never the welcome grant or loot) reach `RAID.MIN_EARNED` (5,000 W). Fresh dens can't be farmed by a main and can't feed one.
- You can only raid rooms holding ≥ 70% of your watts (punching down is impossible, which protects new rooms), except one revenge raid within 24 h of being hit.
- EV (never shown in the game): attacker EV is `S × (p×M×1.025 − 1)`, about `1.10×(1−d)×tilt − 1`. Punching up is never −EV (at the floor it is about +2.5% × (M−1)/M), so the top of the leaderboard is everyone's best target. Peer raids into strong rooms and revenge on poorer rooms can be −EV. Being raided is −EV at every tier. `test/economy.test.js` checks both across every tier, multiplier and stake shape.
- Zero minting: every raid is a pure transfer plus burn. Unspent watts are raid bait — upgrades are the bank.

## Boosts, the Raid Shield, lucky crates, golden blocks

All numbers live in `BALANCE.BOOSTS`, `SHIELD`, `CRATES` and `GOLDEN` and reach the page through `/api/config`. Timers are server-side expiry timestamps saved with the den, so they survive restarts.

**For now nothing in the Boosts tab is for sale** (`BALANCE.BOOSTS_FOR_SALE: false`): boosts and shield tokens come only from lucky crates, and a watts purchase gets `not_for_sale`. Set it to `true` to sell them at the prices below.

- Boosts (shop tab "Boosts", `POST /api/boost {kind, from: "watts" | "item"}`): Double Wheel (2,000 W, 2× wheel watts for 1 h), Deep Sleep (3,000 W, +50% bed income for 8 h), Lucky Whisker (1,500 W, +10 points on the next raid, still capped at 90%), Wager Insurance (1,000 W, the next failed raid refunds half the wager). One of each kind at a time; buying burns the price. Active ones show as chips in the HUD.
- Raid Shield (`POST /api/shield {from: "watts" | "token"}`): 3 h of immunity for `max(500, 3% of the balance)`, burned, once per UTC day. While it is up the den can't raid (turtle mode). Shielded dens show 🛡 on the leaderboard and can't be targeted; a raid on one is refused without using a raid. A successful raid against a den gives it a free 10-minute bruise shield that doesn't block its own raids; buying a shield replaces it.
- Lucky crates (`POST /api/crate {id}`): on each settled block every den that is watching (the same heartbeat as the +20% bonus) has a 1% chance of a crate, at most 5 a UTC day and 3 unopened. The contents are rolled when it drops and stay on the server until it is opened: 60% 200–800 W (balance only, not lifetime), 25% a boost, 10% a shield token, 5% crate-only decor (one already owned or already waiting becomes 800 W). It keys off settled blocks and watching only, never off making him run.
- Golden blocks: a height is golden when `sha256("squeekden-golden|" + height)` says so (about 1 in 150, the same on every boot). It pays 10× wheel watts to every den watching when it settles. `/api/state` carries the newest one as `golden`; the page shows a toast and sparks.

## Decor wave and colourways

- About twenty cheap new pieces (300–2,000 W), so decorating doesn't wait on income: wall decals in `public/sprites_v3_wall_*.js`, floor items (flat + `iso_` art) in `public/sprites_v3_floor_*.js`, plus two pricey anchors (Fish Tank 22,000 W, Hamster Hammock 14,000 W).
- Crate-only decor (`crate: true` in the catalog: Golden Sunflower, Lucky Lantern, Four-Leaf Clover Jar, Shooting Star) is never sold or listed in the shop: players find it in lucky crates (and then it sits in their things like anything else).
- Colourways are catalog entries with `remap: [[from, to], ...]` palette pairs over their base item's art (`colorOf`), so there is no duplicated sprite code. The client turns the pairs into the 16-entry map `drawSprite` already takes.
- The shop tabs run Decor, Rugs, Walls & Floors, Skins, Wheel, Bed, Den (Decor is where a new den starts), each sorted cheapest first. Boosts and shield tokens aren't in the shop at all: they come from lucky crates and wait in Your things.

## v4: names first, visits, bigger fixtures, a guide

- A den exists only once it has a username. `/api/state` never creates one: a fresh token gets `needsName` and the page shows a preview den that earns nothing, through the tutorial (which a new visitor can't skip) to the name step. `POST /api/username` creates the den (`createDen`: name valid and free, then the server cap and the per-address new-den limit). A one-time migration (`state.migrations.anonPurge1`) deleted every den without a username and kept them in `state.anon-purge.bak.json`.
- Visiting: `GET /api/den?id=<publicId>` and `/api/den/random` (rate-limited per address) return a den's look (style, furniture, fixtures, tiers, skin, a raised shield) and its public name and watts, never its crates, items, boosts, wallet or token, plus the viewer's raid flags (`viewerFlags`, the same as the leaderboard's). The page draws the visited den read-only; the leaderboard has a Visit button per row and Random den, and raid-feed names visit.
- The wheel covers 3 floor tiles and the bed 2, along their facing (`fixtureTiles`); old saves are repaired on load (`repairFixtures`), furniture never moves.
- `public/guide.html` explains the game in a few short sections; every number on it comes from `/api/config`.

## Burrow Drop

`public/drop.html`, opened from the Burrow badge under the raids box. POST /api/drop {aim, wager} rolls on the server with the den's real watts (`BALANCE.DROP`; wager 500 W up to your balance) and answers with a seed; the page replays the same path with `public/drop_sim.js`, the deterministic physics both sides share. Chambers, seeds, crate watts and duplicate prizes all scale with the wager (`DropSim.PAY`). Every board (server-decided, kept in `p.drop.board`) shows one drop-only prize (catalog `drop: true` + `rarity`, art in `sprites_drop.js`); rarer ones appear less often and sit in harder spots, and a bigger wager grows the target (`DropSim.prizeRadius`, tops out at 10,000 W), so it never re-rolls the board. The Bounty (`state.drop.stash` in the code) is one shared pot with no cap: it starts at 3,000 W, grows 5% of every wager and pays all of it to whoever lands in the middle slot, whatever they wagered. The board's look follows the hamster: garden while he runs, moonlit while he sleeps, cozy with no fresh reading, crystal on golden boards.

## Sound

`public/sound.js`: effects are synthesized live with WebAudio; the music is two CC0 (public domain) tracks from OpenGameArt, in `public/music/`: "Chill lofi inspired" by omfgdude in the den and "Pixel Sprinter" (loop) by Zane Little Music in Burrow Drop. Sound starts on the first click; the speaker button cycles music + effects, effects only, off. A browser that can't play a track's format gets effects only.

## Ideas for v3

- WalletConnect QR (mobile wallets) via a Reown projectId.
- Stream HUD view: a chrome-free page showing one featured room for the livestream.
- Seasonal items that are only in the shop for a few weeks.
- Foil items for record nights: anything bought during a speed record or milestone from `/v1/events` gets a shimmer.

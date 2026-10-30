// Squeekroom: a cozy pixel room with a hamster on a wheel. The wheel is the real Squeektoshi:
// every settled Squeek block generates watts for EVERY player, online or not (true idle).
// Watts buy cosmetics; wheel upgrades are the only items that raise generation.
// Zero dependencies. Node 18+ (uses global fetch).
//
//   node server.js            live mode: settled height from SqueekCore.state() on Sepolia
//   node server.js --demo     adds POST /api/dev/{advance,grant,night} so you can fake blocks
//
// Env: PORT (default 8788), SQUEEK_API (default https://api.squeekchain.com/v1),
//      DATA_DIR (where state.json lives; mount a persistent disk here in production),
//      CORE_ADDRESS, SEPOLIA_RPC (comma-separated)

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 8788);
const API = process.env.SQUEEK_API || "https://api.squeekchain.com/v1";
const DEMO = process.argv.includes("--demo") || process.env.SQUEEK_DEMO === "1";
// Settled block height comes straight from the SqueekCore proxy on Sepolia (state()), so the
// server works even where api.squeekchain.com sits behind a Cloudflare challenge (most cloud IPs).
const CORE = process.env.CORE_ADDRESS || "0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44";
const RPCS = (process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com,https://1rpc.io/sepolia").split(",").map((s) => s.trim()).filter(Boolean);
const STATE_SELECTOR = "0xc19d93fb"; // state()
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "state.json");
const PUBLIC = path.join(__dirname, "public");
const POLL_MS = 10_000;
const SAVE_DEBOUNCE_MS = 1000;
const MAX_PLAYERS = 50_000;
const DEMO_BASE_HEIGHT = 4135; // used when demo mode has no chain reading yet
const DEMO_MAX_ADVANCE = 2000;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

// ---------- balance (all tuning lives here) ----------
const BALANCE = {
  BASE_WATTS_PER_BLOCK: 10,
  WHEEL_MULT_PCT: [100, 125, 160, 200, 260, 350], // tier 0..5
  LIVE_BONUS_PCT: 120,
  HEARTBEAT_WINDOW_MS: 90_000,
  HEARTBEAT_MIN_INTERVAL_MS: 20_000,
  WELCOME_WATTS: 400,
  CERT_LIFETIME_WATTS: 250_000,
  CERT_ACTIVE_DAYS: 7,
};

// ---------- room grid ----------
// 20 x 12 cells of 16 px (logical canvas 320 x 192). Wall decor lives on rows 2..7 (2-D grid).
// Floor furniture stands on the floor line (row 11, y = 176) and occupies whole columns (1-D).
// Rugs are a flat layer on the floor strip and only collide with other rugs.
const ROOM = {
  COLS: 20,
  ROWS: 12,
  CELL: 16,
  FLOOR_ROW: 11,
  WALL_TOP: 2,
  WALL_BOTTOM: 7,
  RESERVED: { wheel: [3, 6], burrow: [16, 18] }, // inclusive floor-column ranges
};
const RESERVED_COLS = new Set();
for (const [a, b] of Object.values(ROOM.RESERVED)) for (let c = a; c <= b; c++) RESERVED_COLS.add(c);

// ---------- catalog ----------
// {id, name, cat, price, w, h, zone, sprite, tier?, multPct?, animated?}
// w/h are in cells; zone is "floor" | "wall" | "rug" for placeables, null otherwise.
const style = (id, name, cat, price) => ({ id, name, cat, price, w: 0, h: 0, zone: null, sprite: id });
const wheel = (tier, name, price) => ({ id: `wheel_t${tier}`, name, cat: "wheel", price, w: 0, h: 0, zone: null, sprite: `wheel_t${tier}`, tier, multPct: BALANCE.WHEEL_MULT_PCT[tier] });
const place = (id, name, cat, price, w, h, zone, animated) => ({ id, name, cat, price, w, h, zone, sprite: id, ...(animated ? { animated: true } : {}) });

const CATALOG = [
  // wheel upgrades (strictly in order; the only items that change generation)
  wheel(1, "Oiled Bearings", 5_000),
  wheel(2, "Copper Dynamo", 18_000),
  wheel(3, "Flywheel Hub", 50_000),
  wheel(4, "Superconductor Rim", 140_000),
  wheel(5, "Squeektoshi Prime Wheel", 400_000),
  // wallpaper (equip one)
  style("wp_plain", "Plain Cream", "wallpaper", 0),
  style("wp_polka", "Polka Dots", "wallpaper", 1_200),
  style("wp_forest", "Forest Mural", "wallpaper", 4_500),
  style("wp_circuit", "Circuit Board", "wallpaper", 9_000),
  style("wp_night_sky", "Night Sky", "wallpaper", 15_000),
  // flooring (equip one)
  style("fl_pine", "Pine Planks", "floor", 0),
  style("fl_checker", "Checker Tile", "floor", 1_200),
  style("fl_pebble", "Pebble Stone", "floor", 4_000),
  style("fl_cloud", "Cloud Carpet", "floor", 12_000),
  // rugs (flat layer, collide only with rugs)
  place("rug_rag", "Round Rag Rug", "rug", 800, 2, 1, "rug"),
  place("rug_cheese", "Cheese Wedge Rug", "rug", 2_500, 3, 1, "rug"),
  place("rug_persian", "Pixel Persian", "rug", 7_000, 4, 1, "rug"),
  // floor furniture
  place("fur_seed_bowl", "Seed Bowl", "furniture", 600, 1, 1, "floor"),
  place("fur_cactus", "Cactus Pot", "furniture", 1_500, 1, 2, "floor"),
  place("fur_bookshelf", "Tiny Bookshelf", "furniture", 1_800, 2, 2, "floor"),
  place("fur_teacup_bed", "Teacup Bed", "furniture", 3_500, 2, 1, "floor"),
  place("fur_sofa", "Mini Sofa", "furniture", 6_000, 3, 2, "floor"),
  place("fur_lava_lamp", "Lava Lamp", "furniture", 8_000, 1, 2, "floor", true),
  place("fur_arcade", "Arcade Cabinet", "furniture", 14_000, 2, 3, "floor", true),
  place("fur_grandfather_clock", "Grandfather Clock", "furniture", 20_000, 1, 4, "floor", true),
  place("fur_jukebox", "Jukebox", "furniture", 25_000, 2, 3, "floor", true),
  place("fur_trophy_case", "Trophy Case", "furniture", 40_000, 2, 3, "floor"),
  place("fur_golden_statue", "Golden Seed Statue", "furniture", 75_000, 2, 3, "floor"),
  // wall decor (rows 2..7)
  place("wall_pennant", "Pennant", "wall", 700, 1, 1, "wall"),
  place("wall_photo", "Family Photo", "wall", 900, 1, 1, "wall"),
  place("wall_shelf", "Book Shelf", "wall", 2_200, 2, 1, "wall"),
  place("wall_window", "Window", "wall", 5_000, 2, 2, "wall", true),
  place("wall_neon", "Neon SQUEEK Sign", "wall", 10_000, 3, 1, "wall", true),
  place("wall_cuckoo", "Cuckoo Clock", "wall", 12_000, 1, 2, "wall"),
  place("wall_tv", "Wall TV", "wall", 18_000, 2, 2, "wall", true),
  place("wall_plaque", "Speed Record Plaque", "wall", 30_000, 2, 1, "wall"),
  // hamster skins (palette remaps of one sprite set)
  style("skin_classic", "Classic", "skin", 0),
  style("skin_albino", "Albino", "skin", 10_000),
  style("skin_caramel", "Caramel", "skin", 12_000),
  style("skin_panda", "Panda", "skin", 15_000),
  style("skin_shadow", "Shadow", "skin", 25_000),
  style("skin_golden", "Golden", "skin", 60_000),
];
const CATALOG_BY_ID = new Map(CATALOG.map((i) => [i.id, i]));
const SINGLE_COPY = new Set(["wallpaper", "floor", "skin"]);
const DEFAULTS = { skin: "skin_classic", wallpaper: "wp_plain", floor: "fl_pine" };

// ---------- players ----------
function newPlayer(height, now = Date.now()) {
  return {
    nick: "anon",
    createdAt: new Date(now).toISOString(),
    lastSeen: now,
    joinHeight: height == null ? null : height,
    watts: BALANCE.WELCOME_WATTS, // welcome grant (not counted as generated)
    lifetimeWatts: 0, // generated by the wheel only
    wheelTier: 0,
    skin: DEFAULTS.skin,
    wallpaper: DEFAULTS.wallpaper,
    floor: DEFAULTS.floor,
    owned: { [DEFAULTS.skin]: 1, [DEFAULTS.wallpaper]: 1, [DEFAULTS.floor]: 1 },
    placed: [],
    lastHeartbeat: 0,
    activeDays: 0,
    lastActiveDay: null,
    commemorative: null,
  };
}
function getPlayer(st, token) {
  return typeof token === "string" && TOKEN_RE.test(token) && Object.hasOwn(st.players, token) ? st.players[token] : null;
}

// ---------- economy (pure-ish: explicit args, no globals) ----------
function liveBonusPct(player, now = Date.now()) {
  return player.lastHeartbeat > 0 && now - player.lastHeartbeat <= BALANCE.HEARTBEAT_WINDOW_MS ? BALANCE.LIVE_BONUS_PCT : 100;
}
function wattsFor(delta, tier, bonusPct) {
  const mult = BALANCE.WHEEL_MULT_PCT[tier] ?? BALANCE.WHEEL_MULT_PCT[0];
  return Math.round((delta * BALANCE.BASE_WATTS_PER_BLOCK * mult * bonusPct) / 10_000);
}
// Credit `delta` settled blocks to one player. Returns watts earned (integer).
function accrue(player, delta, now = Date.now()) {
  if (!Number.isInteger(delta) || delta <= 0) return 0;
  const earned = wattsFor(delta, player.wheelTier | 0, liveBonusPct(player, now));
  if (earned <= 0) return 0;
  player.watts += earned;
  player.lifetimeWatts += earned;
  const day = new Date(now).toISOString().slice(0, 10); // UTC day
  if (player.lastActiveDay !== day) {
    player.activeDays += 1;
    player.lastActiveDay = day;
  }
  return earned;
}
// Credit every player for blocks lastAccruedHeight..newHeight. Also catches up server downtime.
// A player never earns for blocks settled before they joined.
function accrueAll(st, newHeight, now = Date.now()) {
  if (st.lastAccruedHeight == null) {
    st.lastAccruedHeight = newHeight;
    return 0;
  }
  if (newHeight <= st.lastAccruedHeight) return 0;
  let total = 0;
  for (const p of Object.values(st.players)) {
    const since = p.joinHeight == null ? st.lastAccruedHeight : Math.max(st.lastAccruedHeight, p.joinHeight);
    if (newHeight > since) total += accrue(p, newHeight - since, now);
  }
  st.lastAccruedHeight = newHeight;
  return total;
}

function canBuy(player, itemId) {
  const item = typeof itemId === "string" ? CATALOG_BY_ID.get(itemId) : undefined;
  if (!item) return { ok: false, error: "unknown_item" };
  if (item.cat === "wheel") {
    if (item.tier <= player.wheelTier) return { ok: false, error: "already_owned" };
    if (item.tier !== player.wheelTier + 1) return { ok: false, error: "wrong_tier" };
  } else if (SINGLE_COPY.has(item.cat) && (player.owned[item.id] || 0) > 0) {
    return { ok: false, error: "already_owned" };
  }
  if (player.watts < item.price) return { ok: false, error: "poor", need: item.price - player.watts };
  return { ok: true, item };
}
function applyBuy(player, itemId) {
  const c = canBuy(player, itemId);
  if (!c.ok) return c;
  const item = c.item;
  player.watts -= item.price;
  player.owned[item.id] = (player.owned[item.id] || 0) + 1;
  if (item.cat === "wheel") player.wheelTier = item.tier;
  return { ok: true, item };
}

const fail = (error) => ({ ok: false, error });
const spanHits = (ax, aw, bx, bw) => ax < bx + bw && bx < ax + aw;
// Validate putting one copy of itemId at cell (x, y). For floor/rug items x is the left column
// and y is normalised to the floor row; for wall items (x, y) is the top-left cell.
// ignorePid: the placement being moved (excluded from overlap + ownership counts).
function validatePlacement(player, itemId, x, y, ignorePid = null) {
  const item = typeof itemId === "string" ? CATALOG_BY_ID.get(itemId) : undefined;
  if (!item) return fail("unknown_item");
  if (!item.zone) return fail("not_placeable");
  if (!Number.isInteger(x) || !Number.isInteger(y)) return fail("bad_coords");
  const others = (player.placed || []).filter((p) => p.pid !== ignorePid);
  const placedCount = others.filter((p) => p.item === item.id).length;
  if (placedCount >= ((player.owned && player.owned[item.id]) || 0)) return fail("unowned");
  if (x < 0 || x + item.w > ROOM.COLS || y < 0 || y >= ROOM.ROWS) return fail("out_of_bounds");

  if (item.zone === "wall") {
    if (y < ROOM.WALL_TOP || y + item.h - 1 > ROOM.WALL_BOTTOM) return fail("out_of_bounds");
    for (const o of others) {
      const oi = CATALOG_BY_ID.get(o.item);
      if (oi && oi.zone === "wall" && spanHits(x, item.w, o.x, oi.w) && spanHits(y, item.h, o.y, oi.h)) return fail("overlap");
    }
    return { ok: true, item, x, y };
  }

  // floor furniture and rugs: 1-D over the 20 floor columns
  for (let c = x; c < x + item.w; c++) if (RESERVED_COLS.has(c)) return fail("reserved");
  for (const o of others) {
    const oi = CATALOG_BY_ID.get(o.item);
    if (oi && oi.zone === item.zone && spanHits(x, item.w, o.x, oi.w)) return fail("overlap");
  }
  return { ok: true, item, x, y: ROOM.FLOOR_ROW };
}

// Rate-limited "I'm watching" stamp. Early calls do not stamp (and cannot extend the window).
function heartbeat(player, now = Date.now()) {
  const since = now - (player.lastHeartbeat || 0);
  if (player.lastHeartbeat > 0 && since < BALANCE.HEARTBEAT_MIN_INTERVAL_MS) {
    const bonusPct = liveBonusPct(player, now);
    return { ok: true, stamped: false, watching: bonusPct > 100, bonusPct, nextMs: Math.max(0, BALANCE.HEARTBEAT_MIN_INTERVAL_MS - since) };
  }
  player.lastHeartbeat = now;
  player.lastSeen = now;
  return { ok: true, stamped: true, watching: true, bonusPct: BALANCE.LIVE_BONUS_PCT, nextMs: BALANCE.HEARTBEAT_MIN_INTERVAL_MS };
}

function certEligible(player) {
  return player.lifetimeWatts >= BALANCE.CERT_LIFETIME_WATTS && player.activeDays >= BALANCE.CERT_ACTIVE_DAYS;
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Idempotent: a re-claim returns the stored certificate unchanged.
function claimCommemorative(st, token, now = Date.now()) {
  const p = getPlayer(st, token);
  if (!p) return { ok: false, error: "unknown_player" };
  if (p.commemorative) return { ok: true, already: true, cert: p.commemorative };
  if (!certEligible(p)) {
    return { ok: false, error: "not_eligible", lifetimeWatts: p.lifetimeWatts, activeDays: p.activeDays, needLifetimeWatts: BALANCE.CERT_LIFETIME_WATTS, needActiveDays: BALANCE.CERT_ACTIVE_DAYS };
  }
  st.certSerial = (st.certSerial || 0) + 1;
  const serial = st.certSerial; // first certificate is #1
  const claimHeight = st.height;
  p.commemorative = {
    version: 1,
    type: "squeekroom-commemorative",
    serial,
    seed: sha256(token + String(claimHeight) + String(serial)),
    tokenFingerprint: sha256(token).slice(0, 12),
    nick: p.nick,
    claimedAt: new Date(now).toISOString(),
    joinHeight: p.joinHeight,
    claimHeight,
    lifetimeWatts: p.lifetimeWatts,
    activeDays: p.activeDays,
    wheelTier: p.wheelTier,
    skin: p.skin,
    itemsOwned: { ...p.owned },
    room: { wallpaper: p.wallpaper, floor: p.floor, placed: p.placed.map(({ item, x, y, flip }) => ({ item, x, y, flip })) },
  };
  return { ok: true, already: false, cert: p.commemorative };
}

// ---------- state ----------
let state = {
  startHeight: null, // chain block height when the room server was born
  height: null, // settled Squeek block height (12 confirmations)
  lastAccruedHeight: null, // every player has been credited through this height
  chain: null, // last SqueekCore.state() read
  hamster: null, // live reading (from the API, when reachable; faked in demo)
  lastError: null,
  apiError: null,
  born: null,
  certSerial: 0,
  players: {},
};

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    state = { ...state, ...JSON.parse(raw) };
  } catch {}
  if (!state.players || typeof state.players !== "object") state.players = {};
  if (state.lastAccruedHeight == null && state.height != null) state.lastAccruedHeight = state.height;
}
// Coalesced, atomic save: at most one write per SAVE_DEBOUNCE_MS (a steady stream of changes
// cannot starve it), written to a tmp file then renamed over state.json.
let saveTimer = null;
function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DATA_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      writeNow();
    } catch (e) {
      console.error("save failed:", e.message || e);
    }
  }, SAVE_DEBOUNCE_MS);
}

// Height advanced: credit everyone. First reading only sets the baseline.
function advanceTo(h, now = Date.now()) {
  if (state.startHeight == null) {
    state.startHeight = h;
    state.height = h;
    state.lastAccruedHeight = h;
    state.born = new Date(now).toISOString();
    for (const p of Object.values(state.players)) if (p.joinHeight == null) p.joinHeight = h;
    return;
  }
  if (h <= state.height) return;
  state.height = h;
  accrueAll(state, h, now);
}

// ---------- chain poller ----------
// SqueekCore.state() returns a static tuple: 8 x 32-byte words.
// [0] settledThroughRound [1] cumulativeWork [2] cumulativeBlockUnits [3] blockHeight
// [4] blockProgress (of 1e9) [5] workPerThousandBlocks [6] authorizationNonce [7] paused
async function readCoreState() {
  let lastErr = null;
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: CORE, data: STATE_SELECTOR }, "latest"] }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (!j.result || j.result.length < 2 + 64 * 8) throw new Error(j.error ? j.error.message : "empty result");
      const hex = j.result.slice(2);
      const w = [];
      for (let i = 0; i < 8; i++) w.push(BigInt("0x" + hex.slice(i * 64, i * 64 + 64)));
      return {
        settledThroughRound: Number(w[0]),
        cumulativeWork: Number(w[1]),
        blockHeight: Number(w[3]),
        blockProgress: Number(w[4]),
        workPerThousandBlocks: Number(w[5]),
        paused: w[7] !== 0n,
        rpc,
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no rpc");
}

async function poll() {
  // 1. Settled height from the contract (authoritative for the economy).
  //    In demo mode the chain only seeds the starting height; after that /api/dev/* drives it.
  try {
    const c = await readCoreState();
    if (DEMO) {
      if (state.height == null && c.blockHeight > 0) advanceTo(c.blockHeight);
      state.chain = { ...c, blockHeight: state.height, rpc: "demo" };
    } else {
      state.chain = c;
      if (c.blockHeight > 0) advanceTo(c.blockHeight);
    }
    state.lastError = null;
  } catch (e) {
    state.lastError = `rpc: ${String(e.message || e)}`;
  }
  // 2. Live hamster reading. Demo mode fakes it (and lets a fake run go back to sleep).
  if (DEMO) {
    const h = state.hamster;
    if (!night && (!h || (h.coreStatus === "ACTIVE" && Date.now() - Date.parse(h.updatedAt) > 30_000))) setDemoHamster("IDLE");
  } else {
    // Optional; the browser also fetches it directly, which passes Cloudflare where a
    // datacenter IP may not.
    try {
      const r = await fetch(`${API}/status`, {
        headers: { accept: "application/json", "user-agent": "Squeekroom/0.1 (+https://github.com/KazzDev2/squeekroom)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const s = await r.json();
      const m = s.measurement || {};
      state.hamster = {
        coreStatus: m.coreStatus || "UNKNOWN",
        freshness: m.freshness || "unknown",
        speedMmPerSecond: Number(m.speedMmPerSecond || 0),
        rpmMilli: Number(m.rpmMilli || 0),
        distanceMm: Number(m.distanceMm || 0),
        observedAt: m.observedAt || null,
        updatedAt: new Date().toISOString(),
      };
      state.apiError = null;
    } catch (e) {
      state.apiError = String(e.message || e);
    }
  }
  save();
}

// ---------- demo helpers ----------
let night = null; // { startedAt, endsAt, timer }
function setDemoHamster(status) {
  const active = status === "ACTIVE";
  const speed = active ? 900 + Math.round(Math.random() * 600) : 0;
  const now = new Date().toISOString();
  state.hamster = {
    coreStatus: status,
    freshness: "online",
    speedMmPerSecond: speed,
    rpmMilli: Math.round((speed / (Math.PI * 200)) * 60_000), // ~200 mm wheel
    distanceMm: ((state.hamster && state.hamster.distanceMm) || 0) + speed * 4,
    observedAt: now,
    updatedAt: now,
    demo: true,
  };
}
function demoBlocks(n) {
  if (state.height == null) advanceTo(DEMO_BASE_HEIGHT);
  advanceTo(state.height + n);
  state.chain = { ...(state.chain || {}), blockHeight: state.height, blockProgress: Math.floor(Math.random() * 1e9), updatedAt: new Date().toISOString(), rpc: "demo" };
}
// Scripted ~4-minute night: 8 x [ACTIVE 20 s, one block every 4 s; IDLE 10 s].
function startNight() {
  const CYCLES = 8, ACTIVE_S = 20, IDLE_S = 10, BLOCK_EVERY_S = 4;
  const cycleS = ACTIVE_S + IDLE_S;
  let t = 0;
  night = { startedAt: Date.now(), endsAt: Date.now() + CYCLES * cycleS * 1000, timer: null };
  const tick = () => {
    if (t >= CYCLES * cycleS) {
      clearInterval(night.timer);
      night = null;
      setDemoHamster("IDLE");
      save();
      return;
    }
    const phase = t % cycleS;
    if (phase < ACTIVE_S) {
      setDemoHamster("ACTIVE");
      if (phase % BLOCK_EVERY_S === BLOCK_EVERY_S - 1) demoBlocks(1);
    } else if (phase === ACTIVE_S) setDemoHamster("IDLE");
    t++;
    save();
  };
  tick();
  night.timer = setInterval(tick, 1000);
  return { durationMs: CYCLES * cycleS * 1000, blocks: CYCLES * (ACTIVE_S / BLOCK_EVERY_S) };
}

// ---------- helpers ----------
const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);
function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 64_000) reject(new Error("too big"));
    });
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}
function publicPlayer(p, now = Date.now()) {
  const bonusPct = liveBonusPct(p, now);
  return {
    nick: p.nick,
    createdAt: p.createdAt,
    joinHeight: p.joinHeight,
    watts: p.watts,
    lifetimeWatts: p.lifetimeWatts,
    wheelTier: p.wheelTier,
    multPct: BALANCE.WHEEL_MULT_PCT[p.wheelTier],
    skin: p.skin,
    wallpaper: p.wallpaper,
    floor: p.floor,
    owned: p.owned,
    placed: p.placed,
    activeDays: p.activeDays,
    watching: bonusPct > 100,
    bonusPct,
    nextHeartbeatMs: p.lastHeartbeat > 0 ? Math.max(0, BALANCE.HEARTBEAT_MIN_INTERVAL_MS - (now - p.lastHeartbeat)) : 0,
    certEligible: certEligible(p),
    commemorative: p.commemorative,
  };
}
let playerCount = 0;
function snapshot(token) {
  const now = Date.now();
  let me = null;
  let meError = null;
  if (typeof token === "string" && TOKEN_RE.test(token)) {
    let p = getPlayer(state, token);
    if (!p) {
      if (playerCount >= MAX_PLAYERS) meError = "server_full";
      else {
        p = state.players[token] = newPlayer(state.height, now);
        playerCount++;
      }
    }
    if (p) {
      p.lastSeen = now;
      me = publicPlayer(p, now);
      save();
    }
  } else if (token) meError = "bad_token";
  return {
    startHeight: state.startHeight,
    height: state.height,
    lastAccruedHeight: state.lastAccruedHeight,
    born: state.born,
    demo: DEMO,
    night: night ? { startedAt: night.startedAt, endsAt: night.endsAt } : null,
    chain: state.chain || null,
    core: CORE,
    api: API,
    hamster: state.hamster,
    lastError: state.lastError,
    apiError: state.apiError || null,
    players: playerCount,
    certsIssued: state.certSerial,
    serverTime: now,
    balance: BALANCE,
    room: ROOM,
    catalog: CATALOG,
    me,
    meError,
  };
}

// ---------- routes ----------
// Each POST handler gets (body, player) and returns [status, body]. Player is required unless noted.
const err = (code, error, extra = {}) => [code, { error, ...extra }];
const okMe = (p, extra = {}) => [200, { ok: true, ...extra, me: publicPlayer(p) }];
const POST_ROUTES = {
  "/api/nick": (b, p) => {
    p.nick = clean(b.nick, 20) || "anon";
    return okMe(p);
  },
  "/api/buy": (b, p) => {
    const r = applyBuy(p, b.itemId);
    if (!r.ok) return err(400, r.error, r.need != null ? { need: r.need } : {});
    return okMe(p, { item: r.item.id });
  },
  "/api/place": (b, p) => {
    const v = validatePlacement(p, b.itemId, b.x, b.y);
    if (!v.ok) return err(400, v.error);
    const entry = { pid: crypto.randomBytes(4).toString("hex"), item: v.item.id, x: v.x, y: v.y, flip: b.flip === true };
    p.placed.push(entry);
    return okMe(p, { placed: entry });
  },
  "/api/move": (b, p) => {
    const e = typeof b.pid === "string" ? p.placed.find((q) => q.pid === b.pid) : null;
    if (!e) return err(404, "unknown_pid");
    const v = validatePlacement(p, e.item, b.x, b.y, e.pid);
    if (!v.ok) return err(400, v.error);
    e.x = v.x;
    e.y = v.y;
    if (typeof b.flip === "boolean") e.flip = b.flip;
    return okMe(p, { placed: e });
  },
  "/api/remove": (b, p) => {
    const i = typeof b.pid === "string" ? p.placed.findIndex((q) => q.pid === b.pid) : -1;
    if (i < 0) return err(404, "unknown_pid");
    p.placed.splice(i, 1);
    return okMe(p);
  },
  "/api/skin": (b, p) => {
    const item = typeof b.skinId === "string" ? CATALOG_BY_ID.get(b.skinId) : null;
    if (!item || item.cat !== "skin") return err(400, "unknown_item");
    if (!p.owned[item.id]) return err(400, "unowned");
    p.skin = item.id;
    return okMe(p);
  },
  "/api/style": (b, p) => {
    const picks = [];
    for (const cat of ["wallpaper", "floor"]) {
      if (b[cat] == null) continue;
      const item = typeof b[cat] === "string" ? CATALOG_BY_ID.get(b[cat]) : null;
      if (!item || item.cat !== cat) return err(400, "unknown_item");
      if (!p.owned[item.id]) return err(400, "unowned");
      picks.push([cat, item.id]);
    }
    if (!picks.length) return err(400, "bad_style");
    for (const [cat, id] of picks) p[cat] = id;
    return okMe(p);
  },
  "/api/heartbeat": (b, p) => {
    const r = heartbeat(p);
    return [200, r];
  },
  "/api/claim-commemorative": (b, p, token) => {
    const r = claimCommemorative(state, token);
    if (!r.ok) return err(400, r.error, r);
    return [200, r];
  },
};
const DEV_ROUTES = {
  "/api/dev/advance": (b) => {
    const n = b.n == null ? 1 : b.n;
    if (!Number.isInteger(n)) return err(400, "bad_n");
    setDemoHamster("ACTIVE");
    demoBlocks(Math.max(1, Math.min(DEMO_MAX_ADVANCE, n)));
    return [200, { ok: true, height: state.height }];
  },
  "/api/dev/grant": (b) => {
    const p = getPlayer(state, b.token);
    if (!p) return err(404, "unknown_player");
    const watts = b.watts == null ? 50_000 : b.watts;
    if (!Number.isInteger(watts) || watts < 1 || watts > 10_000_000) return err(400, "bad_watts");
    if (b.activeDays != null && (!Number.isInteger(b.activeDays) || b.activeDays < 0 || b.activeDays > 3650)) return err(400, "bad_active_days");
    p.watts += watts;
    if (b.lifetime === true) p.lifetimeWatts += watts; // demo-only shortcut toward the certificate
    if (b.activeDays != null) p.activeDays = b.activeDays;
    return okMe(p);
  },
  "/api/dev/night": () => {
    if (night) return err(409, "night_running", { endsAt: night.endsAt });
    return [200, { ok: true, ...startNight() }];
  },
};

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, snapshot(url.searchParams.get("token")));
    }
    const devRoute = DEMO ? DEV_ROUTES[url.pathname] : undefined;
    const route = Object.hasOwn(POST_ROUTES, url.pathname) ? POST_ROUTES[url.pathname] : devRoute;
    if (route && req.method === "POST") {
      let b;
      try {
        b = await readBody(req);
      } catch {
        return json(res, 400, { error: "bad_json" });
      }
      if (!b || typeof b !== "object" || Array.isArray(b)) return json(res, 400, { error: "bad_json" });
      let out;
      if (devRoute) out = devRoute(b);
      else {
        const token = clean(b.token, 64);
        if (!TOKEN_RE.test(token)) return json(res, 400, { error: "bad_token" });
        const p = getPlayer(state, token);
        if (!p) return json(res, 404, { error: "unknown_player" });
        out = route(b, p, token);
      }
      save();
      return json(res, out[0], out[1]);
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not_found" });

    // static
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
    fs.readFile(full, (e, data) => {
      if (e) return json(res, 404, { error: "not_found" });
      res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}

function listen() {
  const server = http.createServer(handle);
  server.listen(PORT, () => {
    console.log(`Squeekroom on http://localhost:${PORT}  (${DEMO ? "DEMO mode: POST /api/dev/advance|grant|night" : "live mode"})`);
  });
  const flush = () => {
    try {
      writeNow();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
}

module.exports = { BALANCE, CATALOG, accrue, canBuy, validatePlacement, certEligible };
// Extra helpers for tests (the plan's six names above stay the primary surface).
Object.assign(module.exports, { ROOM, CATALOG_BY_ID, newPlayer, accrueAll, applyBuy, heartbeat, liveBonusPct, claimCommemorative, MAX_PLAYERS });

if (require.main === module) {
  load();
  playerCount = Object.keys(state.players).length;
  poll();
  setInterval(poll, POLL_MS);
  listen();
}

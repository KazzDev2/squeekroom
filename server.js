// Squeekroom: a cozy pixel room with a hamster on a wheel. The wheel is the real Squeektoshi:
// every settled Squeek block generates watts for EVERY player, online or not (true idle), and while
// he sleeps (no settled block for a while) every room earns a slower trickle from its bed.
// Watts buy cosmetics; wheel and bed upgrades are the only items that raise generation.
// While he runs, players may raid richer rooms (POST /api/raid): a won raid moves watts, a lost
// stake burns entirely. Only dens that have earned RAID.MIN_EARNED watts can raid or be raided.
// GET /api/leaderboard lists every room by balance; GET /api/den (?id= or /random) shows one den's look.
// Boosts (POST /api/boost), the Raid Shield (POST /api/shield) and lucky crates (POST /api/crate): single-use
// consumables bought with watts (burned) or found in crates that drop, on settled blocks, for dens that are
// watching. About 1 settled block in 150 is golden: it pays 10x wheel watts to every den watching.
// Usernames (POST /api/username): a den only exists once it has one. The onboarding name step creates it;
// until then the page shows a preview that earns nothing. The username is the name others see.
// Optional wallet sign-in (POST /api/wallet/{nonce,verify}): a gasless personal_sign proof binds an EVM
// address, which adds a verified badge next to the username.
// Zero dependencies. Node 18+ (uses global fetch).
//
//   node server.js            live mode: settled height from SqueekCore.state() on Sepolia
//   node server.js --demo     adds POST /api/dev/{advance,grant,night,sleep} so you can fake blocks
//   node server.js --replay   (or REPLAY=1) a simulated Squeektoshi on her real nightly rhythm, sped up:
//                             no RPC/API calls at all; see "replay mode" below. Not combinable with --demo.
//
// Env: PORT (default 8788), SQUEEK_API (default https://api.squeekchain.com/v1),
//      DATA_DIR (where state.json lives; mount a persistent disk here in production),
//      CORE_ADDRESS, SEPOLIA_RPC (comma-separated)
//      ALERT_WEBHOOK (Discord webhook for security alerts, see lib/alert.js; never commit it)
//      Replay only: REPLAY_SPEED (default 3), REPLAY_START_HEIGHT (default 5204),
//      REPLAY_EPOCH (ISO time the schedule is anchored to, default 2026-10-30T21:00:00Z)

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const ethsig = require("./lib/ethsig.js");
const alert = require("./lib/alert.js");

const PORT = Number(process.env.PORT || 8788);
const API = process.env.SQUEEK_API || "https://api.squeekchain.com/v1";
const DEMO = process.argv.includes("--demo") || process.env.SQUEEK_DEMO === "1";
const REPLAY_REQUESTED = process.argv.includes("--replay") || process.env.REPLAY === "1";
const REPLAY = REPLAY_REQUESTED && !DEMO; // mutually exclusive: the CLI refuses both (bottom of the file)
// Settled block height comes straight from the SqueekCore proxy on Sepolia (state()), so the
// server works even where api.squeekchain.com sits behind a Cloudflare challenge (most cloud IPs).
const CORE = process.env.CORE_ADDRESS || "0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44";
const RPCS = (process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com,https://1rpc.io/sepolia").split(",").map((s) => s.trim()).filter(Boolean);
const STATE_SELECTOR = "0xc19d93fb"; // state()
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "state.json");
const PUBLIC = path.join(__dirname, "public");
const POLL_MS = 10_000;
const SAVE_DEBOUNCE_MS = 10_000; // a crash (not a deploy: SIGTERM saves first) loses at most this much
const SAVE_CHUNK = 1000; // players serialized per event-loop turn by the regular save
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
  WELCOME_WATTS: 10_000, // a generous start: the tier-1 wheel (10,000 W) or a few cosmetics right away
  CERT_LIFETIME_WATTS: 500_000, // bed and wheel both count: ~7 days at tier 0 in replay, like CERT_ACTIVE_DAYS
  CERT_ACTIVE_DAYS: 7,
  // He's asleep by the chain when no settled block arrived for this long.
  IDLE_AFTER_MS: 90_000, // > the longest block gap inside a replay run (~50 s) + a 10 s poll, with room to spare
  // Bed income: while he sleeps, every room earns BED_AWAKE_PCT of the base awake rate
  // (BASE_WATTS_PER_BLOCK x the speed baseline's blocks/min, so live and replay both scale) x bed tier
  // multiplier x watching bonus, online or not. Credited from the poller by elapsed time (exact
  // integers via a carry). Replay at 3x: 37.2 W/min at tier 0 (awake ~74), live: 20 W/min.
  BED_AWAKE_PCT: 50,
  BED_MULT_PCT: [100, 125, 160, 200, 260, 350], // bedTier 0..5
  BED_TICK_MAX_MS: 60_000, // one poller tick credits at most this much time (no catch-up after downtime)
  // Speed bonus: wheel income x speedPct/100, where speedPct = clamp(100 x blocks/min over the last
  // WINDOW_MS / baseline, 100, MAX_PCT). Baseline: BASE_BPM live; in replay, the schedule's mean
  // cadence across its runs (so the ramp's 0.5x edges pay 100% and its 1.5x middle up to 150%).
  // Less than WARMUP_MS of history (restart, cadence unknown) -> 100. Bed income is not affected.
  SPEED: { WINDOW_MS: 600_000, BASE_BPM: 4, MAX_PCT: 150, WARMUP_MS: 120_000 },
  // Raids: wager a stake on a multiplier against a richer room while he RUNS. Win chance
  // p = clamp((EDGE / M) x (1 - defense) x tilt, P_MIN, P_MAX), raised to at least 1/M when the target
  // holds at least the attacker's watts, so attacker EV = S x (p x M - 1) does not depend on M (the
  // multiplier only dials variance). Punching up is never -EV; peer raids into strong rooms and
  // revenge on poorer rooms can be. A win pays exactly (M - 1) x stake, and 5% of wins crit for x1.5.
  // Stakes stop where a crit would hit the loot cap, so the cap never cuts a win and no stake is a
  // trap. A loss burns the whole stake: the
  // defender gets nothing (a share would let alt dens wager welcome watts into a main), so being
  // raided is -EV. The UI shows odds and loot, never EV: working that out is part of the game.
  RAID: {
    EDGE_PCT: 110,
    MULT_PCT: [150, 200, 300, 500, 1000], // M = 1.5, 2, 3, 5, 10 ("Heist")
    DEFENSE_PCT: [0, 5, 10, 15, 20, 25], // by the DEFENDER's roomTier 0..5
    TILT_EXP: 0.25, // tilt = (defenderWatts / attackerWatts) ^ TILT_EXP, clamped below
    TILT_MIN_PCT: 75,
    TILT_MAX_PCT: 175, // reached at ~9.4x the attacker's watts
    P_MIN_PCT: 2,
    P_MAX_PCT: 90,
    CRIT_CHANCE_PCT: 5, // win: loot = (M - 1) x stake, a crit x CRIT_MULT, <= LOOT_MAX_DEF_PCT of the defender
    CRIT_MULT_PCT: 150,
    LOOT_MAX_DEF_PCT: 25, // one raid takes at most 25% of the defender's balance
    STAKE_MIN: 50, // stake >= max(STAKE_MIN, STAKE_MIN_BAL_PCT of the attacker's balance)
    STAKE_MIN_BAL_PCT: 5, // stake <= min(balance, cap / ((M - 1) x CRIT_MULT)): see stakeBounds()
    ELIGIBLE_MIN_PCT: 70, // targets must hold >= 70% of the attacker's balance (punch-up only)...
    REVENGE_WINDOW_MS: 86_400_000, // ...unless they raided the attacker within 24 h (once per provocation)
    RAIDED_BY_MAX: 20,
    PER_DAY: 10, // raids per attacker per UTC day; being raided has no limit
    // A den raids and can be raided only once it has EARNED this much (lifetimeWatts: wheel + bed,
    // never the welcome grant or raid loot), so fresh alt dens can't wager or lose their welcome watts.
    MIN_EARNED: 5_000,
    FEED_MAX: 50,
    FEED_SNAPSHOT: 20,
    LEADERBOARD_MAX: 200,
    LEADERBOARD_CACHE_MS: 10_000,
  },
  // Raid Shield: MS of immunity, at most PER_DAY activations per UTC day (bought, or with a crate token
  // that waives the price). Price max(PRICE_MIN, PRICE_PCT of the balance), burned. While a bought
  // shield is up the den can't start raids (turtle mode). A successful raid against a den gives it
  // BRUISE_MS of free immunity that doesn't block its own raids; buying a shield replaces it.
  SHIELD: { MS: 3 * 3_600_000, PER_DAY: 1, PRICE_MIN: 500, PRICE_PCT: 3, BRUISE_MS: 600_000 },
  // Sales switch for the Boosts tab: false = boosts and the Raid Shield can't be bought with watts;
  // they come only from lucky crates (boost items, shield tokens). The bruise shield is unaffected.
  BOOSTS_FOR_SALE: false,
  // Boosts: single-use, bought (the price burns) or found in crates; one active per kind, never stacked.
  // Priced against ~31k W/day of tier-0 income: worth it when timed well, a loss when wasted.
  BOOSTS: {
    double_wheel: { PRICE: 2_000, MS: 3_600_000, PCT: 200 }, // wheel watts x2 for an hour
    deep_sleep: { PRICE: 3_000, MS: 8 * 3_600_000, PCT: 150 }, // bed income +50% for 8 hours
    lucky_whisker: { PRICE: 1_500, ODDS_PTS: 10 }, // next raid: +10 points win chance, still <= P_MAX
    wager_insurance: { PRICE: 1_000, REFUND_PCT: 50 }, // next FAILED raid refunds half the wager
  },
  // Lucky crates: on each settled block every den that is watching (the live-bonus heartbeat) rolls
  // CHANCE_PCT for a crate, up to PER_DAY a UTC day and MAX_UNOPENED waiting (further drops wait).
  // Contents are rolled at drop time: TABLE_PCT watts / a boost / a shield token / crate-only decor
  // (decor already owned or already waiting in another crate becomes DUP_WATTS instead).
  // Keyed off settled blocks and watching only: nothing here rewards making him run.
  CRATES: { CHANCE_PCT: 1, PER_DAY: 5, MAX_UNOPENED: 3, ROLLS_MAX: 50, WATTS_MIN: 200, WATTS_MAX: 800, DUP_WATTS: 800,
    TABLE_PCT: { watts: 60, boost: 25, shield: 10, decor: 5 } },
  // Golden blocks: a settled height is golden when its hash says so (~1 in ONE_IN, the same answer on
  // every boot). It pays MULT_PCT wheel watts to every den watching when it settles; others get the normal rate.
  GOLDEN: { ONE_IN: 150, MULT_PCT: 1000 },
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
  RESERVED: {}, // inclusive floor-column ranges by name; the burrow mound (16..18) was removed 1 Nov 2026
  // The wheel and the bed stand on floor tiles, against the walls too: the wheel covers 3 tiles and
  // the bed 2 (see fixtureTiles). Tiles with i + j > FIX_MAX_SUM fall off the bottom of the view.
  // The two never share a tile, and their anchors keep FIX_GAP tiles apart (Chebyshev).
  ISO_NI: 11,
  ISO_NJ: 10,
  FIX_MAX_SUM: 14,
  FIX_GAP: 2,
  FIXTURE_DEFAULTS: { wheel: { i: 1, j: 5, flip: true }, bed: { i: 7, j: 2, flip: false } },
};
// Floor furniture and rugs stand on floor tiles: placement (x, y) = (i, j) is the BACK tile of a
// w-tile chain that runs along i (flip false: parallel to the right wall, the iso art's canonical
// SW face) or along j (flip true: parallel to the left wall, mirrored). Rugs lie RUG_DEPTH tiles deep
// across the chain. Every tile must be on the visible floor (i + j <= FIX_MAX_SUM, like the fixtures).
const RUG_DEPTH = 2;
function footprint(item, i, j, flip) {
  const out = [], deep = item.zone === "rug" ? RUG_DEPTH : 1;
  for (let a = 0; a < item.w; a++) for (let d = 0; d < deep; d++) out.push(flip ? [i + d, j + a] : [i + a, j + d]);
  return out;
}
const tileOnFloor = ([i, j]) => i >= 0 && j >= 0 && i < ROOM.ISO_NI && j < ROOM.ISO_NJ && i + j <= ROOM.FIX_MAX_SUM;
const tileKey = ([i, j]) => i * 100 + j;

// ---------- catalog ----------
// {id, name, cat, price, w, h, zone, sprite, tier?, multPct?, animated?, crate?, remap?, colorOf?}
// w/h are in cells; zone is "floor" | "wall" | "rug" for placeables, null otherwise.
// crate: only found in lucky crates, never sold (price 0, but not one of the free defaults).
// Colourways reuse their base item's art (sprite and iso_ sprite) with remap: [[from, to], ...]
// palette-index pairs; the client builds the 16-entry map. colorOf names the base item.
const style = (id, name, cat, price) => ({ id, name, cat, price, w: 0, h: 0, zone: null, sprite: id });
const wheel = (tier, name, price) => ({ id: `wheel_t${tier}`, name, cat: "wheel", price, w: 0, h: 0, zone: null, sprite: `wheel_t${tier}`, tier, multPct: BALANCE.WHEEL_MULT_PCT[tier] });
const bed = (tier, name, price) => ({ id: `bed_t${tier}`, name, cat: "bed", price, w: 0, h: 0, zone: null, sprite: `bed_t${tier}`, tier, multPct: BALANCE.BED_MULT_PCT[tier] });
const roomMat = (tier, material, price) => ({ id: `room_t${tier}`, name: `${material} Room`, cat: "room", price, w: 0, h: 0, zone: null, sprite: `room_t${tier}`, tier, material });
const place = (id, name, cat, price, w, h, zone, animated) => ({ id, name, cat, price, w, h, zone, sprite: id, ...(animated ? { animated: true } : {}) });
const crateOnly = (id, name, cat, w, h, zone, animated) => ({ ...place(id, name, cat, 0, w, h, zone, animated), crate: true });

const CATALOG = [
  // wheel upgrades (strictly in order; with beds, the only items that change generation)
  wheel(1, "Oiled Bearings", 10_000),
  wheel(2, "Copper Dynamo", 36_000),
  wheel(3, "Flywheel Hub", 100_000),
  wheel(4, "Superconductor Rim", 280_000),
  wheel(5, "Squeektoshi Prime Wheel", 800_000),
  // beds (strictly in order; raise the income while he sleeps). Tier 0 is the free straw mat.
  bed(1, "Teacup Nest", 6_000),
  bed(2, "Memory Foam Pad", 20_000),
  bed(3, "Canopy Bed", 60_000),
  bed(4, "Heated Bunk", 160_000),
  bed(5, "Zero-G Pod", 400_000),
  // room material (strictly in order). Tier 0 is wood.
  roomMat(1, "Stone", 20_000),
  roomMat(2, "Iron", 60_000),
  roomMat(3, "Silver", 160_000),
  roomMat(4, "Gold", 400_000),
  roomMat(5, "Diamond", 900_000),
  // wallpaper (equip one)
  style("wp_dirt", "Packed Dirt", "wallpaper", 0),
  style("wp_plain", "Plain Cream", "wallpaper", 0),
  style("wp_polka", "Polka Dots", "wallpaper", 2_400),
  style("wp_forest", "Forest Mural", "wallpaper", 9_000),
  style("wp_circuit", "Circuit Board", "wallpaper", 18_000),
  style("wp_night_sky", "Night Sky", "wallpaper", 30_000),
  // flooring (equip one)
  style("fl_straw", "Straw Bedding", "floor", 0),
  style("fl_pine", "Pine Planks", "floor", 0),
  style("fl_checker", "Checker Tile", "floor", 2_400),
  style("fl_pebble", "Pebble Stone", "floor", 8_000),
  style("fl_cloud", "Cloud Carpet", "floor", 24_000),
  // rugs (flat layer, collide only with rugs)
  place("rug_rag", "Round Rag Rug", "rug", 1_600, 2, 1, "rug"),
  place("rug_cheese", "Cheese Wedge Rug", "rug", 5_000, 3, 1, "rug"),
  place("rug_persian", "Pixel Persian", "rug", 14_000, 4, 1, "rug"),
  place("rug_doormat", "Doormat", "rug", 500, 2, 1, "rug"),
  place("rug_leaves", "Leaf Pile", "rug", 600, 2, 1, "rug"),
  place("rug_sand", "Sand Patch", "rug", 800, 3, 1, "rug"),
  // floor furniture
  place("fur_seed_bowl", "Seed Bowl", "furniture", 1_200, 1, 1, "floor"),
  place("fur_cactus", "Cactus Pot", "furniture", 3_000, 1, 2, "floor"),
  place("fur_bookshelf", "Tiny Bookshelf", "furniture", 3_600, 2, 2, "floor"),
  place("fur_teacup_bed", "Teacup Bed", "furniture", 7_000, 2, 1, "floor"),
  place("fur_sofa", "Mini Sofa", "furniture", 12_000, 3, 2, "floor"),
  place("fur_lava_lamp", "Lava Lamp", "furniture", 16_000, 1, 2, "floor", true),
  place("fur_arcade", "Arcade Cabinet", "furniture", 28_000, 2, 3, "floor", true),
  place("fur_grandfather_clock", "Grandfather Clock", "furniture", 40_000, 1, 4, "floor", true),
  place("fur_jukebox", "Jukebox", "furniture", 50_000, 2, 3, "floor", true),
  place("fur_trophy_case", "Trophy Case", "furniture", 80_000, 2, 3, "floor"),
  place("fur_golden_statue", "Golden Seed Statue", "furniture", 150_000, 2, 3, "floor"),
  // v3 decor wave: small, cheap things for the first days, plus a pricey hammock
  place("fur_mushroom", "Tiny Mushroom", "furniture", 300, 1, 1, "floor"),
  place("fur_yarn", "Ball of Yarn", "furniture", 400, 1, 1, "floor"),
  place("fur_water_bottle", "Water Bottle", "furniture", 500, 1, 2, "floor"),
  place("fur_fern", "Potted Fern", "furniture", 600, 1, 2, "floor"),
  place("fur_stool", "Tiny Stool", "furniture", 700, 1, 1, "floor"),
  place("fur_melon_cushion", "Watermelon Cushion", "furniture", 900, 1, 1, "floor"),
  place("fur_box_house", "Cardboard Box House", "furniture", 1_500, 2, 2, "floor"),
  place("fur_hammock", "Hamster Hammock", "furniture", 14_000, 2, 2, "floor"),
  crateOnly("fur_sunflower", "Golden Sunflower", "furniture", 1, 2, "floor"),
  crateOnly("fur_clover_jar", "Four-Leaf Clover Jar", "furniture", 1, 1, "floor"),
  // wall decor (rows 2..7)
  place("wall_pennant", "Pennant", "wall", 1_400, 1, 1, "wall"),
  place("wall_photo", "Family Photo", "wall", 1_800, 1, 1, "wall"),
  place("wall_shelf", "Book Shelf", "wall", 4_400, 2, 1, "wall"),
  place("wall_window", "Window", "wall", 10_000, 2, 2, "wall", true),
  place("wall_neon", "Neon SQUEEK Sign", "wall", 20_000, 3, 1, "wall", true),
  place("wall_cuckoo", "Cuckoo Clock", "wall", 24_000, 1, 2, "wall"),
  place("wall_tv", "Wall TV", "wall", 36_000, 2, 2, "wall", true),
  place("wall_plaque", "Speed Record Plaque", "wall", 60_000, 2, 1, "wall"),
  place("wall_paw_stickers", "Paw Print Stickers", "wall", 300, 1, 1, "wall"),
  place("wall_run_poster", "\"RUN\" Poster", "wall", 400, 1, 2, "wall"),
  place("wall_doodle", "Doodle of Squeektoshi", "wall", 500, 1, 1, "wall"),
  place("wall_polaroids", "Polaroid String", "wall", 800, 3, 1, "wall"),
  place("wall_mirror", "Round Mirror", "wall", 900, 2, 2, "wall"),
  place("wall_ivy", "Hanging Ivy", "wall", 1_000, 2, 2, "wall"),
  place("wall_portrait", "Framed Squeektoshi Portrait", "wall", 1_200, 2, 2, "wall"),
  place("wall_fairy_lights", "Fairy Lights", "wall", 1_800, 4, 1, "wall", true),
  place("wall_fish_tank", "Fish Tank", "wall", 22_000, 2, 2, "wall", true),
  crateOnly("wall_lucky_lantern", "Lucky Lantern", "wall", 1, 2, "wall", true),
  crateOnly("wall_shooting_star", "Shooting Star", "wall", 2, 1, "wall", true),
  // hamster skins (palette remaps of one sprite set)
  style("skin_classic", "Classic", "skin", 0),
  style("skin_albino", "Albino", "skin", 20_000),
  style("skin_caramel", "Caramel", "skin", 24_000),
  style("skin_panda", "Panda", "skin", 30_000),
  style("skin_shadow", "Shadow", "skin", 50_000),
  style("skin_golden", "Golden", "skin", 120_000),
];
// Colourways: the same art with a palette swap (see the catalog header). Same price as the base.
const COLORWAYS = [
  ["rug_rag", "rug_rag_sea", "Round Rag Rug (Sea)", [[0xf, 0x7], [0x7, 0x8], [0x6, 0x2], [0xb, 0x9], [0xc, 0x7]]],
  ["rug_rag", "rug_rag_meadow", "Round Rag Rug (Meadow)", [[0xf, 0x9], [0x7, 0xa], [0xb, 0x3], [0xc, 0x9]]],
  ["rug_rag", "rug_rag_ember", "Round Rag Rug (Ember)", [[0xf, 0xb], [0x7, 0x4], [0xb, 0x5], [0xc, 0x3]]],
  ["wall_pennant", "wall_pennant_blue", "Pennant (Blue)", [[0xc, 0x7], [0xb, 0x8]]],
  ["wall_pennant", "wall_pennant_green", "Pennant (Green)", [[0xc, 0x9], [0xb, 0xa]]],
  ["wall_pennant", "wall_pennant_gold", "Pennant (Gold)", [[0xc, 0x6], [0xb, 0x3], [0x4, 0x5]]],
  ["wall_fairy_lights", "wall_fairy_lights_warm", "Fairy Lights (Warm)", [[0xb, 0x6], [0x7, 0x3], [0x9, 0x6]]],
  ["wall_fairy_lights", "wall_fairy_lights_rose", "Fairy Lights (Rose)", [[0x6, 0xc], [0xb, 0xf], [0x7, 0xc], [0x9, 0xf]]],
  ["fur_melon_cushion", "fur_kiwi_cushion", "Kiwi Cushion", [[0xb, 0x9], [0xc, 0x6], [0x9, 0x4], [0xa, 0x5]]],
  ["fur_melon_cushion", "fur_orange_cushion", "Orange Cushion", [[0xb, 0x3], [0xc, 0x6], [0x9, 0x4], [0xa, 0x5]]],
  ["fur_sofa", "fur_sofa_navy", "Mini Sofa (Navy)", [[0xb, 0x7], [0xc, 0xf], [0x4, 0x8]]],
  ["fur_sofa", "fur_sofa_moss", "Mini Sofa (Moss)", [[0xb, 0x9], [0xc, 0x6], [0x4, 0xa]]],
];
for (const [baseId, id, name, remap] of COLORWAYS) {
  const at = CATALOG.findIndex((i) => i.id === baseId);
  const base = CATALOG[at];
  let end = at + 1; // keep a base's colourways together, right after it
  while (end < CATALOG.length && CATALOG[end].colorOf === baseId) end++;
  CATALOG.splice(end, 0, { ...base, id, name, remap, colorOf: baseId });
}
const CATALOG_BY_ID = new Map(CATALOG.map((i) => [i.id, i]));
const SINGLE_COPY = new Set(["wallpaper", "floor", "skin"]);
// Tier ladders: bought strictly in order, one copy each; buying sets the player field to the tier.
const TIER_FIELD = { wheel: "wheelTier", bed: "bedTier", room: "roomTier" };
const tierField = (cat) => (Object.hasOwn(TIER_FIELD, cat) ? TIER_FIELD[cat] : null);
const DEFAULTS = { skin: "skin_classic", wallpaper: "wp_plain", floor: "fl_straw" };
const FREE_IDS = CATALOG.filter((i) => i.price === 0 && !i.crate).map((i) => i.id); // every player owns these

// ---------- fixtures: the wheel and the bed ----------
const FIXTURES = ["wheel", "bed"];
const defaultFixtures = () => ({ wheel: { ...ROOM.FIXTURE_DEFAULTS.wheel }, bed: { ...ROOM.FIXTURE_DEFAULTS.bed } });
// Floor tiles a fixture covers, from its anchor (i, j) and facing, matching the iso art: the wheel's
// disc stands across its axle, 3 tiles centred on the anchor, along i (flip false) or j (flip true);
// the bed reaches one tile back from its anchor, to (i - 1, j) (flip false) or (i, j - 1) (flip true).
function fixtureTiles(kind, f) {
  const out = [];
  for (let d = -1; d <= (kind === "wheel" ? 1 : 0); d++) out.push(f.flip ? [f.i, f.j + d] : [f.i + d, f.j]);
  return out;
}
const fixtureFits = (kind, f) => !!f && Number.isInteger(f.i) && Number.isInteger(f.j) && typeof f.flip === "boolean" && fixtureTiles(kind, f).every(tileOnFloor);
// The wheel and the bed never share a tile, and their anchors stay FIX_GAP apart (room for him).
function fixturesClear(wheelF, bedF) {
  if (Math.max(Math.abs(wheelF.i - bedF.i), Math.abs(wheelF.j - bedF.j)) < ROOM.FIX_GAP) return false;
  const w = new Set(fixtureTiles("wheel", wheelF).map(tileKey));
  return !fixtureTiles("bed", bedF).some((t) => w.has(tileKey(t)));
}
function validFixtures(f) {
  if (!f || typeof f !== "object") return false;
  for (const k of FIXTURES) if (!fixtureFits(k, f[k])) return false;
  return fixturesClear(f.wheel, f.bed);
}
const furnitureTiles = (player) => {
  const s = new Map(); // tileKey -> item id
  for (const o of player.placed || []) {
    const oi = CATALOG_BY_ID.get(o.item);
    if (oi && oi.zone === "floor") for (const t of footprint(oi, o.x, o.y, !!o.flip)) s.set(tileKey(t), oi.id);
  }
  return s;
};
// Move the wheel or the bed to floor tile (i, j); flip is optional (keeps the current facing).
function moveFixture(player, body) {
  const b = body && typeof body === "object" ? body : {};
  if (!FIXTURES.includes(b.which)) return fail("bad_fixture");
  if (b.flip != null && typeof b.flip !== "boolean") return fail("bad_flip");
  const cur = player.fixtures[b.which];
  const next = { i: b.i, j: b.j, flip: typeof b.flip === "boolean" ? b.flip : !!cur.flip };
  if (!fixtureFits(b.which, next)) return fail("out_of_bounds");
  const other = player.fixtures[b.which === "wheel" ? "bed" : "wheel"];
  if (!(b.which === "wheel" ? fixturesClear(next, other) : fixturesClear(other, next))) return fail("too_close");
  const furn = furnitureTiles(player); // not onto furniture (rugs are flat: fine)
  for (const t of fixtureTiles(b.which, next)) if (furn.has(tileKey(t))) return { ok: false, error: "occupied", with: furn.get(tileKey(t)) };
  cur.i = next.i;
  cur.j = next.j;
  cur.flip = next.flip;
  return { ok: true, fixture: cur };
}
// Saves from before the fixtures grew (1 tile each) can now collide with furniture, the walls or each
// other. Keep what still fits; move the rest to the nearest spot that does (either facing), wheel
// first. Furniture never moves. A crate left under a fixture moves to a free tile. Returns true if
// anything moved.
function repairFixtures(p) {
  const f = p.fixtures && typeof p.fixtures === "object" ? p.fixtures : {};
  const furn = furnitureTiles(p);
  const fits = (k, c) => fixtureFits(k, c) && fixtureTiles(k, c).every((t) => !furn.has(tileKey(t)));
  const out = {};
  let moved = false;
  for (const k of FIXTURES) {
    const ok = (c) => fits(k, c) && (k === "wheel" || fixturesClear(out.wheel, c));
    const was = f[k] && Number.isInteger(f[k].i) && Number.isInteger(f[k].j) ? { i: f[k].i, j: f[k].j, flip: !!f[k].flip } : { ...ROOM.FIXTURE_DEFAULTS[k] };
    let pick = ok(was) ? was : null;
    for (let r = 1; !pick && r <= Math.max(ROOM.ISO_NI, ROOM.ISO_NJ); r++) {
      for (let di = -r; di <= r && !pick; di++) for (let dj = -r; dj <= r && !pick; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        for (const flip of [was.flip, !was.flip]) { const c = { i: was.i + di, j: was.j + dj, flip }; if (ok(c)) { pick = c; break; } }
      }
    }
    if (!pick) pick = { ...ROOM.FIXTURE_DEFAULTS[k] }; // a den packed wall to wall: the default spot, overlap and all
    if (!f[k] || pick.i !== f[k].i || pick.j !== f[k].j || pick.flip !== f[k].flip) moved = true;
    out[k] = pick;
  }
  p.fixtures = out;
  if (Array.isArray(p.crates)) {
    const under = new Set(FIXTURES.flatMap((k) => fixtureTiles(k, out[k])).map(tileKey));
    for (const c of p.crates) if (c && under.has(tileKey([c.i, c.j]))) { const t = crateTile(p); c.i = t.i; c.j = t.j; }
  }
  return moved;
}

// ---------- consumables: boosts, shield tokens (the shapes newPlayer/patchPlayer use) ----------
const BOOST_KINDS = Object.keys(BALANCE.BOOSTS);
const TIMED_BOOSTS = new Set(BOOST_KINDS.filter((k) => BALANCE.BOOSTS[k].MS > 0));
const ITEM_KINDS = [...BOOST_KINDS, "shield_token"];
const emptyItems = () => Object.fromEntries(ITEM_KINDS.map((k) => [k, 0]));
const emptyEffects = () => Object.fromEntries(BOOST_KINDS.map((k) => [k, TIMED_BOOSTS.has(k) ? 0 : false]));

// ---------- players ----------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Public, non-secret handle for a player (safe to show others; the token never leaves its owner).
const publicIdFor = (token) => sha256(token).slice(0, 12);
function newPlayer(height, now = Date.now(), token = null) {
  return {
    publicId: typeof token === "string" ? publicIdFor(token) : null,
    nick: "anon",
    createdAt: new Date(now).toISOString(),
    lastSeen: now,
    joinHeight: height == null ? null : height,
    watts: BALANCE.WELCOME_WATTS, // welcome grant (not counted as generated)
    lifetimeWatts: 0, // generated by the wheel only
    wheelTier: 0,
    bedTier: 0,
    bedFrac: 0, // carried fraction of a bed watt, in 1/BED_FRAC_DEN units
    roomTier: 0, // 0 = wood
    skin: DEFAULTS.skin,
    wallpaper: DEFAULTS.wallpaper,
    floor: DEFAULTS.floor,
    owned: Object.fromEntries(FREE_IDS.map((id) => [id, 1])),
    placed: [],
    fixtures: defaultFixtures(), // where the wheel and the bed stand: {wheel: {i, j, flip}, bed: {...}}
    lastHeartbeat: 0,
    activeDays: 0,
    lastActiveDay: null,
    commemorative: null,
    lastRaidAt: 0, // ms of this player's last resolved raid
    raidDay: null, // UTC day ("YYYY-MM-DD") that raidsToday counts
    raidsToday: 0, // raids made on raidDay (BALANCE.RAID.PER_DAY a day)
    raidedBy: [], // ring of {pid, at, avenged}: who raided this room (revenge waives the 70% rule once)
    wallet: null, // lowercase 0x address once a personal_sign proof was verified
    username: null, // unique, shown on the leaderboard instead of the nick; picked when the den starts
    walletNonce: null, // pending sign-in {message, expiresAt}: single-use, 10 min
    items: emptyItems(), // consumables held (from crates): one count per boost kind + shield_token
    effects: emptyEffects(), // timed boosts: expiry ms (0 = off); next-raid boosts: true while armed
    shield: { until: 0, kind: null }, // raid immunity until (ms); kind "bought" | "bruise"
    shieldDay: null, // UTC day of the last shield activation (SHIELD.PER_DAY)
    crates: [], // unopened lucky crates {id, at, i, j, c}; c (the contents) never leaves the server
    crateDay: null, // UTC day that cratesToday counts
    cratesToday: 0,
  };
}
// Bring an older player record up to the current shape (missing fields get their defaults).
const LEGACY_FIELDS = ["lastSpinAt", "manualDay", "manualMsToday", "manualFrac"]; // wheel duty, removed
function patchPlayer(p, token) {
  if (!p.publicId && typeof token === "string") p.publicId = publicIdFor(token);
  if (!Number.isInteger(p.bedTier)) p.bedTier = 0;
  if (!Number.isFinite(p.bedFrac)) p.bedFrac = 0;
  if (!Number.isInteger(p.roomTier)) p.roomTier = 0;
  if (!Number.isFinite(p.lifetimeWatts)) p.lifetimeWatts = 0; // raidReady() reads it
  if (!Number.isFinite(p.lastRaidAt)) p.lastRaidAt = 0;
  if (p.raidDay === undefined) p.raidDay = null;
  if (!Number.isInteger(p.raidsToday)) p.raidsToday = 0;
  repairFixtures(p); // older saves: 1-tile fixtures may collide with the 3-tile wheel / 2-tile bed
  if (!Array.isArray(p.raidedBy)) p.raidedBy = [];
  if (p.wallet === undefined) p.wallet = null;
  if (p.username === undefined) p.username = null;
  if (p.walletNonce === undefined) p.walletNonce = null;
  const items = p.items && typeof p.items === "object" ? p.items : {};
  p.items = emptyItems();
  for (const k of ITEM_KINDS) if (Number.isInteger(items[k]) && items[k] > 0) p.items[k] = items[k];
  const fx = p.effects && typeof p.effects === "object" ? p.effects : {};
  p.effects = emptyEffects();
  for (const k of BOOST_KINDS) if (TIMED_BOOSTS.has(k) ? Number.isFinite(fx[k]) && fx[k] > 0 : fx[k] === true) p.effects[k] = fx[k];
  if (!p.shield || typeof p.shield !== "object" || !Number.isFinite(p.shield.until)) p.shield = { until: 0, kind: null };
  if (p.shieldDay === undefined) p.shieldDay = null;
  if (!Array.isArray(p.crates)) p.crates = [];
  if (p.crateDay === undefined) p.crateDay = null;
  if (!Number.isInteger(p.cratesToday)) p.cratesToday = 0;
  if (p.owned && typeof p.owned === "object") for (const id of FREE_IDS) if (!p.owned[id]) p.owned[id] = 1;
  for (const k of LEGACY_FIELDS) delete p[k];
  return p;
}
function getPlayer(st, token) {
  return typeof token === "string" && TOKEN_RE.test(token) && Object.hasOwn(st.players, token) ? st.players[token] : null;
}

// ---------- wallet sign-in (optional; EIP-191 personal_sign, gasless) ----------
// A player asks for a one-time message, signs it in their wallet, and the server recovers the signer
// (lib/ethsig.js) from the exact stored text. A bound wallet puts a verified badge next to the username.
// Players without a wallet are unaffected.
const WALLET = {
  NONCE_TTL_MS: 600_000, // a pending sign-in message lives 10 minutes and is spent by a successful verify
  USERNAME_RE: /^[A-Za-z0-9_]{3,16}$/,
  ADDRESS_RE: /^0x[0-9a-fA-F]{40}$/,
};
const displayName = (p) => (p && p.username) || (p && p.nick) || "anon";
function walletMessage(publicId, nonceHex, now) {
  return [
    "Squeekroom — sign in",
    "",
    "EXPERIMENTAL GAME — link a BURNER wallet only.",
    "Signing is free: no transaction, no gas. It only proves you own this address.",
    "",
    `Room: ${publicId}`,
    `Nonce: ${nonceHex}`,
    `Issued At: ${new Date(now).toISOString()}`,
  ].join("\n");
}
// Issue (or replace) the player's pending sign-in message. nonceHex is injectable for tests.
function issueWalletNonce(st, token, now = Date.now(), nonceHex = crypto.randomBytes(16).toString("hex")) {
  const p = getPlayer(st, token);
  if (!p) return fail("unknown_player");
  p.walletNonce = { message: walletMessage(p.publicId, nonceHex, now), expiresAt: now + WALLET.NONCE_TTL_MS };
  return { ok: true, message: p.walletNonce.message, expiresAt: p.walletNonce.expiresAt };
}
// body {address, signature}: the signature must recover to `address` over the pending message.
// Order: nonce -> expiry -> address -> signature -> signer match -> uniqueness. Failures (other than
// expiry) keep the pending message so the player can retry; success spends it.
function verifyWallet(st, token, body, now = Date.now()) {
  const p = getPlayer(st, token);
  if (!p) return fail("unknown_player");
  const pending = p.walletNonce;
  if (!pending || typeof pending.message !== "string") return fail("no_nonce");
  if (!(now < pending.expiresAt)) {
    p.walletNonce = null;
    return fail("nonce_expired");
  }
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.address !== "string" || !WALLET.ADDRESS_RE.test(b.address)) return fail("bad_address");
  const address = b.address.toLowerCase();
  const signer = ethsig.recoverPersonalSig(pending.message, b.signature);
  if (!signer) return fail("bad_signature");
  if (signer !== address) return fail("wallet_mismatch");
  for (const q of Object.values(st.players)) if (q && q !== p && q.wallet === address) return fail("wallet_taken");
  p.wallet = address;
  p.walletNonce = null;
  invalidateLeaderboard(st);
  return { ok: true, wallet: address };
}
// What's wrong with username `u` for den `p` (null: a den not created yet), or null if it's fine:
// 3-16 of [A-Za-z0-9_], unique case-insensitively.
function usernameProblem(st, p, u) {
  if (typeof u !== "string" || !WALLET.USERNAME_RE.test(u)) return "bad_username";
  const key = u.toLowerCase();
  for (const q of Object.values(st.players)) {
    if (q && q !== p && typeof q.username === "string" && q.username.toLowerCase() === key) return "username_taken";
  }
  return null;
}
// body {username}: set or change an existing den's username. No wallet needed.
function setUsername(st, token, body) {
  const p = getPlayer(st, token);
  if (!p) return fail("unknown_player");
  const u = body && typeof body === "object" ? body.username : undefined;
  const bad = usernameProblem(st, p, u);
  if (bad) return fail(bad);
  p.username = u;
  invalidateLeaderboard(st);
  return { ok: true, username: u };
}
// A den is created only here, with its username (the onboarding name step). Order: name valid -> name
// free -> room on the server -> the new-den rate limit -> create. A refused name never leaves a den behind.
// count: dens on the server (the live server passes its running count).
function createDen(st, token, body, now = Date.now(), { ip = null, count = Object.keys(st.players).length } = {}) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return fail("bad_token");
  if (getPlayer(st, token)) return fail("den_exists");
  const u = body && typeof body === "object" ? body.username : undefined;
  const bad = usernameProblem(st, null, u);
  if (bad) return fail(bad);
  if (count >= MAX_PLAYERS) return fail("server_full");
  if (!allowNewDen(ip, now)) return fail("too_many_dens");
  const p = (st.players[token] = newPlayer(st.height, now, token));
  indexPlayer(st, token, p);
  p.username = u;
  p.lastSeen = now;
  invalidateLeaderboard(st);
  return { ok: true, player: p, username: u };
}
// One-time cleanup (v4): delete every den that never picked a username (they were created on page load,
// before onboarding, and kept earning while idle). Returns the removed dens by token. Also drops them
// from the raid feed and from every revenge list, and resets the publicId index. Pure on `st`.
function purgeNameless(st) {
  const removed = {};
  for (const [token, p] of Object.entries(st.players || {})) {
    if (!p || typeof p !== "object" || typeof p.username !== "string" || !p.username) {
      removed[token] = p;
      delete st.players[token];
    }
  }
  const gone = new Set(Object.values(removed).map((p) => p && p.publicId).filter(Boolean));
  if (gone.size) {
    for (const p of Object.values(st.players)) if (Array.isArray(p.raidedBy)) p.raidedBy = p.raidedBy.filter((e) => e && !gone.has(e.pid));
    if (Array.isArray(st.raidFeed)) st.raidFeed = st.raidFeed.filter((e) => e && !gone.has(e.atkId) && !gone.has(e.defId));
  }
  PID_INDEX.delete(st);
  invalidateLeaderboard(st);
  return removed;
}

// ---------- economy (pure-ish: explicit args, no globals) ----------
function liveBonusPct(player, now = Date.now()) {
  return player.lastHeartbeat > 0 && now - player.lastHeartbeat <= BALANCE.HEARTBEAT_WINDOW_MS ? BALANCE.LIVE_BONUS_PCT : 100;
}
// boostPct: Double Wheel (100 = off). delta may count a golden block as GOLDEN.MULT_PCT / 100 blocks.
function wattsFor(delta, tier, bonusPct, speedPct = 100, boostPct = 100) {
  const mult = BALANCE.WHEEL_MULT_PCT[tier] ?? BALANCE.WHEEL_MULT_PCT[0];
  return Math.round((delta * BALANCE.BASE_WATTS_PER_BLOCK * mult * bonusPct * speedPct * boostPct) / 100_000_000);
}
// Is boost `kind` working for this player at `now`? Timed: before its expiry; next-raid: while armed.
function boostActive(p, kind, now = Date.now()) {
  const v = p && p.effects ? p.effects[kind] : undefined;
  return TIMED_BOOSTS.has(kind) ? Number.isFinite(v) && v > now : v === true;
}
const boostPct = (p, kind, now) => (boostActive(p, kind, now) ? BALANCE.BOOSTS[kind].PCT : 100);
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);
// Generated watts (wheel or bed): balance + lifetime, and one active day per UTC day.
function creditWatts(player, earned, now) {
  player.watts += earned;
  player.lifetimeWatts += earned;
  const day = utcDay(now);
  if (player.lastActiveDay !== day) {
    player.activeDays += 1;
    player.lastActiveDay = day;
  }
}
// Credit `delta` settled blocks to one player. Returns watts earned (integer).
// speedPct: the speed bonus (100..BALANCE.SPEED.MAX_PCT) measured for this advance; wheel only.
// golden: how many of those blocks were golden; each pays GOLDEN.MULT_PCT, but only while watching.
function accrue(player, delta, now = Date.now(), speedPct = 100, golden = 0) {
  if (!Number.isInteger(delta) || delta <= 0) return 0;
  const bonus = liveBonusPct(player, now);
  const gold = bonus > 100 && golden > 0 ? (Math.min(golden, delta) * (BALANCE.GOLDEN.MULT_PCT - 100)) / 100 : 0;
  const earned = wattsFor(delta + gold, player.wheelTier | 0, bonus, speedPct, boostPct(player, "double_wheel", now));
  if (earned <= 0) return 0;
  creditWatts(player, earned, now);
  return earned;
}

// ---------- sleep: the live reading when there is one, else the chain ----------
const CHAIN_FRESH_MS = 120_000; // live mode: no chain reading this recent -> can't tell he's asleep
// Asleep by the chain: height was observed and has not advanced for IDLE_AFTER_MS.
// chainReadAt (live mode): when the chain was last read successfully; a stale read is "not idle".
function chainIdle(lastAdvanceAt, now = Date.now(), chainReadAt = null) {
  if (!Number.isFinite(lastAdvanceAt) || lastAdvanceAt <= 0) return false; // height never observed
  if (chainReadAt != null && !(now - chainReadAt <= CHAIN_FRESH_MS)) return false;
  return now - lastAdvanceAt >= BALANCE.IDLE_AFTER_MS;
}
// The live reading (the status feed; synthesized in replay and demo) says within seconds when he stops,
// where the chain needs IDLE_AFTER_MS without a block. So while a fresh reading exists it decides:
// asleep once it hasn't said ACTIVE for STATUS_PAUSE_MS (a short stop mid-run isn't sleep). Bed income,
// raids and the hamster on screen all follow this one answer. A missing or stale reading (feed down,
// blocked) falls back to the chain, so a broken feed can't keep him awake.
const STATUS_FRESH_MS = 120_000; // older than this the reading is no use (the client shows it as STALE)
const STATUS_PAUSE_MS = 20_000;
function statusFresh(h, now = Date.now()) {
  if (!h || typeof h !== "object" || h.freshness === "stale") return false;
  const at = Date.parse(h.updatedAt || h.observedAt || "");
  return Number.isFinite(at) && now - at <= STATUS_FRESH_MS;
}
// Once per reading: remember when it last said he was running.
function noteStatus(st, now = Date.now()) {
  if (statusFresh(st.hamster, now) && st.hamster.coreStatus === "ACTIVE") st.lastStatusActiveAt = now;
}
function asleep(st, now = Date.now(), chainReadAt = null) {
  const h = st.hamster;
  if (statusFresh(h, now)) return h.coreStatus !== "ACTIVE" && !(now - (st.lastStatusActiveAt || 0) < STATUS_PAUSE_MS);
  return chainIdle(st.lastAdvanceAt, now, chainReadAt);
}

// ---------- bed income ----------
// While he sleeps the poller credits every room for real elapsed time (never an amount from a
// client): ms x rate x bed mult x watching bonus. The rate runs in tenths of a watt per minute so
// the whole product is an exact integer; the remainder carries in player.bedFrac.
// tier-0 rate in tenths of a watt per minute (SPEED_BASE_BPM is fixed at boot, below REPLAY_SCHEDULE)
const bedRateTenths = () => Math.round((BALANCE.BASE_WATTS_PER_BLOCK * SPEED_BASE_BPM * BALANCE.BED_AWAKE_PCT) / 10);
const BED_FRAC_DEN = 60_000 * 10 * 100 * 100 * 100; // ms/min x tenths x multPct x bonusPct x Deep Sleep pct
const bedMultPct = (player) => BALANCE.BED_MULT_PCT[player.bedTier | 0] ?? BALANCE.BED_MULT_PCT[0];
const bedWattsPerMin = (player) => (bedRateTenths() * bedMultPct(player)) / 1000; // before the watching bonus
// Credit one player `ms` of bed time. Returns whole watts credited.
function bedCredit(player, ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const total = (Number.isFinite(player.bedFrac) ? player.bedFrac : 0) + ms * bedRateTenths() * bedMultPct(player) * liveBonusPct(player, now) * boostPct(player, "deep_sleep", now);
  const watts = Math.floor(total / BED_FRAC_DEN);
  player.bedFrac = total - watts * BED_FRAC_DEN;
  if (watts > 0) creditWatts(player, watts, now);
  return watts;
}
// One poller tick. Elapsed time since the previous tick (capped at BED_TICK_MAX_MS) is credited to
// every player when he is asleep; awake ticks only move the clock. st.lastBedTickAt is not persisted,
// so a restart never pays for downtime (whether he slept through it is unknown).
function accrueBed(st, idle, now = Date.now()) {
  const last = st.lastBedTickAt;
  st.lastBedTickAt = now;
  if (!idle || !Number.isFinite(last) || last <= 0 || now <= last) return 0;
  const ms = Math.min(now - last, BALANCE.BED_TICK_MAX_MS);
  let total = 0;
  for (const p of Object.values(st.players)) total += bedCredit(p, ms, now);
  return total;
}
// Credit every player for blocks lastAccruedHeight..newHeight. Also catches up server downtime.
// A player never earns for blocks settled before they joined. speedPct applies to the whole advance.
// Golden blocks in the range pay watchers extra (st.lastGolden remembers the newest for the client),
// and every den watching rolls for lucky crates, once per new block (at most CRATES.ROLLS_MAX).
function accrueAll(st, newHeight, now = Date.now(), speedPct = 100, rng = Math.random) {
  if (st.lastAccruedHeight == null) {
    st.lastAccruedHeight = newHeight;
    return 0;
  }
  if (newHeight <= st.lastAccruedHeight) return 0;
  const golden = goldenBetween(st.lastAccruedHeight, newHeight);
  if (golden.length) st.lastGolden = { height: golden[golden.length - 1], at: now };
  let total = 0;
  for (const p of Object.values(st.players)) {
    const since = p.joinHeight == null ? st.lastAccruedHeight : Math.max(st.lastAccruedHeight, p.joinHeight);
    if (newHeight <= since) continue;
    total += accrue(p, newHeight - since, now, speedPct, golden.filter((h) => h > since).length);
    if (liveBonusPct(p, now) > 100) rollCrates(p, Math.min(newHeight - since, BALANCE.CRATES.ROLLS_MAX), now, rng);
  }
  st.lastAccruedHeight = newHeight;
  return total;
}

// ---------- golden blocks ----------
// Deterministic from the height alone, so every boot (and replay) agrees which blocks are golden.
const isGoldenBlock = (h) => Number.isSafeInteger(h) && h > 0 && parseInt(sha256(`squeekden-golden|${h}`).slice(0, 8), 16) % BALANCE.GOLDEN.ONE_IN === 0;
// Golden heights in (from, to], ascending. A long catch-up checks every height once.
function goldenBetween(from, to) {
  const out = [];
  for (let h = Math.max(0, from) + 1; h <= to; h++) if (isGoldenBlock(h)) out.push(h);
  return out;
}

// ---------- lucky crates ----------
const CRATE_DECOR = () => CATALOG.filter((i) => i.crate).map((i) => i.id); // crate-only decor (Patch 3 fills it)
// What a crate holds, decided when it drops. Decor the den owns or already has waiting becomes DUP_WATTS.
function rollCrateContents(p, rng = Math.random) {
  const C = BALANCE.CRATES, T = C.TABLE_PCT, r = rng() * 100;
  if (r < T.watts) return { kind: "watts", watts: C.WATTS_MIN + Math.floor(rng() * (C.WATTS_MAX - C.WATTS_MIN + 1)) };
  if (r < T.watts + T.boost) return { kind: "boost", boost: BOOST_KINDS[Math.floor(rng() * BOOST_KINDS.length) % BOOST_KINDS.length] };
  if (r < T.watts + T.boost + T.shield) return { kind: "shield" };
  const decor = CRATE_DECOR();
  if (!decor.length) return { kind: "watts", watts: C.DUP_WATTS };
  const id = decor[Math.floor(rng() * decor.length) % decor.length];
  const waiting = (p.crates || []).some((c) => c && c.c && c.c.kind === "decor" && c.c.item === id);
  return (p.owned && p.owned[id]) || waiting ? { kind: "watts", watts: C.DUP_WATTS, dup: id } : { kind: "decor", item: id };
}
// A free floor tile for the parcel: on the visible floor, off the wheel, the bed, furniture and other crates.
function crateTile(p, rng = Math.random) {
  const taken = new Set();
  for (const k of FIXTURES) { const f = p.fixtures && p.fixtures[k]; if (f) for (const t of fixtureTiles(k, f)) taken.add(tileKey(t)); }
  for (const o of p.placed || []) {
    const oi = CATALOG_BY_ID.get(o.item);
    if (oi && oi.zone === "floor") for (const t of footprint(oi, o.x, o.y, !!o.flip)) taken.add(tileKey(t));
  }
  for (const c of p.crates || []) if (c) taken.add(tileKey([c.i, c.j]));
  const free = [];
  for (let i = 0; i < ROOM.ISO_NI; i++) for (let j = 0; j < ROOM.ISO_NJ; j++) if (tileOnFloor([i, j]) && !taken.has(tileKey([i, j]))) free.push({ i, j });
  if (!free.length) return { i: 2, j: 2 };
  return free[Math.floor(rng() * free.length) % free.length];
}
// `rolls` CHANCE_PCT rolls for one den; drops what the daily cap and the unopened cap allow. Returns drops.
function rollCrates(p, rolls, now = Date.now(), rng = Math.random) {
  const C = BALANCE.CRATES, day = utcDay(now);
  if (p.crateDay !== day) { p.crateDay = day; p.cratesToday = 0; }
  if (!Array.isArray(p.crates)) p.crates = [];
  let dropped = 0;
  for (let n = 0; n < rolls; n++) {
    if (p.cratesToday >= C.PER_DAY || p.crates.length >= C.MAX_UNOPENED) break;
    if (!(rng() < C.CHANCE_PCT / 100)) continue;
    const c = rollCrateContents(p, rng), t = crateTile(p, rng);
    p.crates.push({ id: crypto.randomBytes(4).toString("hex"), at: now, i: t.i, j: t.j, c });
    p.cratesToday += 1;
    dropped++;
  }
  return dropped;
}
// Open one waiting crate: its contents land in the den (watts on the balance only: not earnings).
function openCrate(st, token, body, now = Date.now()) {
  const p = getPlayer(st, token);
  if (!p) return fail("unknown_player");
  const id = body && typeof body === "object" ? body.id : undefined;
  const k = typeof id === "string" && Array.isArray(p.crates) ? p.crates.findIndex((c) => c && c.id === id) : -1;
  if (k < 0) return fail("unknown_crate");
  const [crate] = p.crates.splice(k, 1);
  let got = crate.c || { kind: "watts", watts: BALANCE.CRATES.WATTS_MIN };
  if (got.kind === "decor" && (!CATALOG_BY_ID.has(got.item) || (p.owned && p.owned[got.item]))) got = { kind: "watts", watts: BALANCE.CRATES.DUP_WATTS, dup: got.item };
  if (got.kind === "watts") p.watts += got.watts;
  else if (got.kind === "boost" && ITEM_KINDS.includes(got.boost)) p.items[got.boost] = (p.items[got.boost] | 0) + 1;
  else if (got.kind === "shield") p.items.shield_token = (p.items.shield_token | 0) + 1;
  else if (got.kind === "decor") p.owned[got.item] = 1;
  return { ok: true, got };
}

// ---------- boosts + the Raid Shield ----------
// body {kind, from: "item" (one held from a crate) | "watts" (buy it now; the price burns)}.
function useBoost(st, token, body, now = Date.now()) {
  const p = getPlayer(st, token);
  if (!p) return fail("unknown_player");
  const b = body && typeof body === "object" ? body : {};
  if (!BOOST_KINDS.includes(b.kind)) return fail("bad_boost");
  const B = BALANCE.BOOSTS[b.kind];
  if (boostActive(p, b.kind, now)) return { ok: false, error: "boost_active", until: TIMED_BOOSTS.has(b.kind) ? p.effects[b.kind] : null };
  if (b.from === "item") {
    if (!((p.items[b.kind] | 0) > 0)) return fail("no_item");
    p.items[b.kind] -= 1;
  } else if (b.from === "watts") {
    if (!BALANCE.BOOSTS_FOR_SALE) return fail("not_for_sale");
    if (p.watts < B.PRICE) return { ok: false, error: "poor", need: B.PRICE - p.watts };
    p.watts -= B.PRICE;
  } else return fail("bad_from");
  p.effects[b.kind] = TIMED_BOOSTS.has(b.kind) ? now + B.MS : true;
  return { ok: true, kind: b.kind, effect: p.effects[b.kind] };
}
const shieldUp = (p, now = Date.now()) => !!p && !!p.shield && p.shield.until > now;
const boughtShieldUp = (p, now = Date.now()) => shieldUp(p, now) && p.shield.kind === "bought";
const shieldPrice = (p) => Math.max(BALANCE.SHIELD.PRICE_MIN, Math.floor((Math.max(0, p.watts) * BALANCE.SHIELD.PRICE_PCT) / 100));
const shieldUsedToday = (p, now = Date.now()) => p.shieldDay === utcDay(now);
// body {from: "token" | "watts"}: SHIELD.MS of immunity; once a UTC day; replaces a bruise shield.
function raiseShield(st, token, body, now = Date.now()) {
  const p = getPlayer(st, token);
  if (!p) return fail("unknown_player");
  const b = body && typeof body === "object" ? body : {};
  if (shieldUsedToday(p, now)) return { ok: false, error: "shield_used_today", resetMs: msToUtcMidnight(now) };
  if (boughtShieldUp(p, now)) return { ok: false, error: "shield_active", until: p.shield.until };
  if (b.from === "token") {
    if (!((p.items.shield_token | 0) > 0)) return fail("no_item");
    p.items.shield_token -= 1;
  } else if (b.from === "watts") {
    if (!BALANCE.BOOSTS_FOR_SALE) return fail("not_for_sale");
    const price = shieldPrice(p);
    if (p.watts < price) return { ok: false, error: "poor", need: price - p.watts };
    p.watts -= price;
  } else return fail("bad_from");
  p.shield = { until: now + BALANCE.SHIELD.MS, kind: "bought" };
  p.shieldDay = utcDay(now);
  invalidateLeaderboard(st);
  return { ok: true, shield: p.shield };
}

// ---------- speed bonus (judged by the chain's own cadence) ----------
// The settled height is the only trusted signal (never the status API). speedPct over a ring of
// {t, h} samples, oldest first: the oldest sample inside [now - windowMs, now] against the newest
// one gives blocks/min; under warmupMs of history (or none) it is 100, so a restart or a catch-up
// after downtime never pays a windfall. Pure.
function speedPctFrom(samples, now, { windowMs, baseBpm, maxPct, warmupMs }) {
  if (!Array.isArray(samples) || !(baseBpm > 0)) return 100;
  let oldest = null;
  let latest = null;
  for (const s of samples) {
    if (!s || !Number.isFinite(s.h) || !(s.t <= now)) continue;
    if (s.t >= now - windowMs && (!oldest || s.t < oldest.t)) oldest = s;
    if (!latest || s.t >= latest.t) latest = s;
  }
  if (!oldest) return 100;
  const span = now - oldest.t;
  if (span < warmupMs) return 100;
  const bpm = (latest.h - oldest.h) / (span / 60_000);
  return clamp(Math.round((100 * bpm) / baseBpm), 100, maxPct);
}
// Replay baseline: the schedule's mean cadence across its run segments (blocks per run-minute). Pure.
function replayRunMeanBpm(sched) {
  const runMs = sched.segments.reduce((a, s) => a + (s.kind === "run" ? s.ms : 0), 0);
  return runMs > 0 ? sched.blocksPerCycle / (runMs / 60_000) : 0;
}
// The server's own ring (in memory only, never in state.json): a sample on every advance of the live
// state and one per poll tick, so the window keeps ageing while he sleeps.
const SPEED_RING_MAX = 4096;
const speedSamples = [];
function recordSpeedSample(h, now = Date.now(), ring = speedSamples, windowMs = BALANCE.SPEED.WINDOW_MS) {
  if (!Number.isFinite(h)) return;
  ring.push({ t: now, h });
  let drop = 0;
  while (drop < ring.length - 1 && ring[drop].t < now - 2 * windowMs) drop++;
  drop = Math.max(drop, ring.length - SPEED_RING_MAX);
  if (drop > 0) ring.splice(0, drop);
}
const resetSpeedSamples = () => void (speedSamples.length = 0);
// BALANCE.SPEED knobs -> speedPctFrom options, against a baseline in blocks/min.
const speedOpts = (baseBpm, B = BALANCE.SPEED) => ({ windowMs: B.WINDOW_MS, baseBpm, maxPct: B.MAX_PCT, warmupMs: B.WARMUP_MS });
// The live speed bonus now. SPEED_BASE_BPM is fixed at boot (below REPLAY_SCHEDULE).
const currentSpeedPct = (now = Date.now()) => speedPctFrom(speedSamples, now, speedOpts(SPEED_BASE_BPM));

function canBuy(player, itemId) {
  const item = typeof itemId === "string" ? CATALOG_BY_ID.get(itemId) : undefined;
  if (!item) return { ok: false, error: "unknown_item" };
  if (item.crate) return { ok: false, error: "crate_only" };
  const field = tierField(item.cat);
  if (field) {
    const cur = player[field] | 0;
    if (item.tier <= cur) return { ok: false, error: "already_owned" };
    if (item.tier !== cur + 1) return { ok: false, error: "wrong_tier" };
  } else if (SINGLE_COPY.has(item.cat) && (player.owned[item.id] || 0) > 0) {
    return { ok: false, error: "already_owned" };
  }
  if (player.watts < item.price) return { ok: false, error: "poor", need: item.price - player.watts };
  return { ok: true, item, price: item.price };
}
function applyBuy(player, itemId) {
  const c = canBuy(player, itemId);
  if (!c.ok) return c;
  const item = c.item;
  player.watts -= c.price;
  player.owned[item.id] = (player.owned[item.id] || 0) + 1;
  const field = tierField(item.cat);
  if (field) player[field] = item.tier;
  return { ok: true, item, price: c.price };
}

const fail = (error) => ({ ok: false, error });
const spanHits = (ax, aw, bx, bw) => ax < bx + bw && bx < ax + aw;
// Validate putting one copy of itemId at cell (x, y). For floor/rug items x is the left column
// and y is normalised to the floor row; for wall items (x, y) is the top-left cell.
// ignorePid: the placement being moved (excluded from overlap + ownership counts).
function validatePlacement(player, itemId, x, y, ignorePid = null, flip = false) {
  const item = typeof itemId === "string" ? CATALOG_BY_ID.get(itemId) : undefined;
  if (!item) return fail("unknown_item");
  if (!item.zone) return fail("not_placeable");
  if (!Number.isInteger(x) || !Number.isInteger(y)) return fail("bad_coords");
  const others = (player.placed || []).filter((p) => p.pid !== ignorePid);
  const placedCount = others.filter((p) => p.item === item.id).length;
  if (placedCount >= ((player.owned && player.owned[item.id]) || 0)) return fail("unowned");

  if (item.zone === "wall") {
    if (x < 0 || x + item.w > ROOM.COLS || y < ROOM.WALL_TOP || y + item.h - 1 > ROOM.WALL_BOTTOM) return fail("out_of_bounds");
    for (const o of others) {
      const oi = CATALOG_BY_ID.get(o.item);
      if (oi && oi.zone === "wall" && spanHits(x, item.w, o.x, oi.w) && spanHits(y, item.h, o.y, oi.h)) return fail("overlap");
    }
    return { ok: true, item, x, y };
  }

  // floor furniture and rugs: tiles anywhere on the floor; furniture overlaps furniture, rugs rugs,
  // and furniture keeps off the wheel's and the bed's tiles (a rug can lie under them)
  const tiles = footprint(item, x, y, !!flip);
  if (!tiles.every(tileOnFloor)) return fail("out_of_bounds");
  const mine = new Set(tiles.map(tileKey));
  for (const o of others) {
    const oi = CATALOG_BY_ID.get(o.item);
    if (oi && oi.zone === item.zone && footprint(oi, o.x, o.y, !!o.flip).some((t) => mine.has(tileKey(t)))) return fail("overlap");
  }
  if (item.zone === "floor") for (const k of FIXTURES) {
    const f = player.fixtures && player.fixtures[k];
    if (f && fixtureTiles(k, f).some((t) => mine.has(tileKey(t)))) return { ok: false, error: "fixture", which: k };
  }
  return { ok: true, item, x, y };
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
    nick: displayName(p),
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

// ---------- raids ----------
// Pure core first (explicit args, injectable rng), then applyRaid() which validates and mutates one
// state object. Raid transfers never touch lifetimeWatts/activeDays: lifetime is earn-only (it
// gates the certificate), so loot is moved on the balances directly, never through creditWatts().
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// tilt = clamp((defenderWatts / attackerWatts) ^ 0.25, 0.75, 1.75): punching up pays better.
function wealthTilt(attackerWatts, defenderWatts) {
  const R = BALANCE.RAID;
  const ratio = defenderWatts / attackerWatts;
  const t = Number.isNaN(ratio) ? 1 : Math.pow(ratio, R.TILT_EXP); // 0/0 -> neutral; x/0 -> Infinity -> max
  return clamp(t, R.TILT_MIN_PCT / 100, R.TILT_MAX_PCT / 100);
}
const raidDefensePct = (defender) => BALANCE.RAID.DEFENSE_PCT[defender.roomTier | 0] ?? BALANCE.RAID.DEFENSE_PCT[0];
// p = clamp((1.10 / M) x (1 - d) x T, 0.02, 0.90), with M given as a percentage (150 = 1.5x).
// punchUp: the target holds at least the attacker's watts, so p is at least 1/M (break-even before
// the loot roll's crits, which keep it just above).
function raidOdds(multPct, defensePct, tilt, punchUp = false) {
  const R = BALANCE.RAID;
  let p = (R.EDGE_PCT / multPct) * (1 - defensePct / 100) * tilt;
  if (punchUp) p = Math.max(p, 100 / multPct);
  return clamp(p, R.P_MIN_PCT / 100, R.P_MAX_PCT / 100);
}
const isPunchUp = (attackerWatts, defenderWatts) => defenderWatts >= attackerWatts;
function raidChance(attacker, defender, multPct) {
  if (!BALANCE.RAID.MULT_PCT.includes(multPct)) return 0;
  return raidOdds(multPct, raidDefensePct(defender), wealthTilt(attacker.watts, defender.watts), isPunchUp(attacker.watts, defender.watts));
}
// One resolution, rolls in a fixed order: win, then crit (a loss uses one roll).
// Loot is capped at LOOT_MAX_DEF_PCT of the defender's balance, crit included, so no single roll can
// empty a room however big the stake. A loss loses the whole stake, and it all burns.
// oddsPts (Lucky Whisker) adds percentage points after all other maths, still capped at P_MAX.
// Pure: returns the outcome, mutates nothing.
function resolveRaid(attacker, defender, stake, multPct, rng = Math.random, oddsPts = 0) {
  const R = BALANCE.RAID;
  let p = raidChance(attacker, defender, multPct);
  if (oddsPts > 0 && p > 0) p = Math.min(R.P_MAX_PCT / 100, p + oddsPts / 100);
  if (!(rng() < p)) return { win: false, p, stakeLost: stake };
  const cap = lootCap(defender.watts);
  let loot = Math.min(Math.floor(((multPct - 100) * stake) / 100), cap);
  const crit = rng() < R.CRIT_CHANCE_PCT / 100;
  if (crit) loot = Math.min(Math.floor((loot * R.CRIT_MULT_PCT) / 100), cap);
  return { win: true, p, loot: Math.max(0, loot), crit };
}
const lootCap = (defWatts) => Math.floor((Math.max(0, defWatts) * BALANCE.RAID.LOOT_MAX_DEF_PCT) / 100);
// Stake bounds: min = max(50, 5% of the balance); max = the balance, and with a target and a
// multiplier also the largest stake whose crit loot (M - 1) x S x 1.5 fits under the target's loot
// cap. Past it the cap would eat the crit (and then the win itself) while the loss kept growing.
// limit: which bound sets max ("balance" | "target"). max < min: can't raid (at this multiplier).
function stakeBounds(watts, defWatts = null, multPct = null) {
  const R = BALANCE.RAID;
  const bal = Math.max(0, Math.floor(watts));
  const min = Math.max(R.STAKE_MIN, Math.ceil((bal * R.STAKE_MIN_BAL_PCT) / 100));
  if (defWatts == null || multPct == null) return { min, max: bal, limit: "balance" };
  const top = Math.floor((lootCap(defWatts) * 10_000) / ((multPct - 100) * R.CRIT_MULT_PCT));
  return top < bal ? { min, max: top, limit: "target" } : { min, max: bal, limit: "balance" };
}
// The multiplier as shown (1.5, 2, 3, 5, 10) or as its percentage (150 .. 1000). null if neither.
function parseMultPct(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const L = BALANCE.RAID.MULT_PCT;
  if (L.includes(v)) return v;
  const pct = Math.round(v * 100);
  return L.includes(pct) && Math.abs(v * 100 - pct) < 1e-9 ? pct : null;
}
// Daily allowance: PER_DAY raids per UTC day; the count resets at 00:00 UTC.
const raidsLeft = (p, now) => (p.raidDay === utcDay(now) ? Math.max(0, BALANCE.RAID.PER_DAY - (p.raidsToday | 0)) : BALANCE.RAID.PER_DAY);
const msToUtcMidnight = (now) => 86_400_000 - (now % 86_400_000);
// The oldest unavenged provocation by `pid` against `player` within the revenge window, or null.
function pendingRevenge(player, pid, now) {
  const list = Array.isArray(player.raidedBy) ? player.raidedBy : [];
  return list.find((e) => e && e.pid === pid && !e.avenged && now >= e.at && now - e.at < BALANCE.RAID.REVENGE_WINDOW_MS) || null;
}
// Earned enough (wheel + bed, lifetime) to raid and to be raided. Lifetime only grows, so once true it stays true.
const raidReady = (p) => !!p && Number.isFinite(p.lifetimeWatts) && p.lifetimeWatts >= BALANCE.RAID.MIN_EARNED;
// Punch-up rule (target holds >= 70% of the attacker's balance) or a pending revenge.
function raidEligibility(attacker, defender, now) {
  if (attacker === defender || (attacker.publicId && attacker.publicId === defender.publicId)) return { ok: false, error: "self_target" };
  if (defender.watts * 100 >= attacker.watts * BALANCE.RAID.ELIGIBLE_MIN_PCT) return { ok: true, revenge: null };
  const revenge = pendingRevenge(attacker, defender.publicId, now);
  return revenge ? { ok: true, revenge } : { ok: false, error: "not_eligible" };
}
// Raids are open only while he RUNS: height observed, chain reading fresh (live mode), not asleep.
// With a state `st`, asleep() decides (the live reading first); without one, the chain alone.
function raidWindow(lastAdvanceAt, now = Date.now(), chainReadAt = null, st = null) {
  if (!Number.isFinite(lastAdvanceAt) || lastAdvanceAt <= 0) return { open: false, reason: "chain_unknown" };
  if (chainReadAt != null && !(now - chainReadAt <= CHAIN_FRESH_MS)) return { open: false, reason: "chain_stale" };
  if (st ? asleep(st, now, chainReadAt) : chainIdle(lastAdvanceAt, now, chainReadAt)) return { open: false, reason: "hamster_asleep" };
  return { open: true, reason: null };
}
function raidStatus(st, player, now = Date.now(), chainReadAt = null) {
  return { open: raidWindow(st.lastAdvanceAt, now, chainReadAt, st).open, raidsLeft: raidsLeft(player, now), perDay: BALANCE.RAID.PER_DAY, resetMs: msToUtcMidnight(now),
    ready: raidReady(player), earned: Math.max(0, player.lifetimeWatts | 0), needEarned: BALANCE.RAID.MIN_EARNED, shielded: boughtShieldUp(player, now) };
}

// publicId -> token index per state object (built lazily, extended on player creation; a miss
// rebuilds only when the player count says the index is behind).
const PID_INDEX = new WeakMap();
function buildPidIndex(st) {
  const m = new Map();
  for (const [t, p] of Object.entries(st.players)) if (p && p.publicId) m.set(p.publicId, t);
  PID_INDEX.set(st, m);
  return m;
}
function indexPlayer(st, token, p) {
  const m = PID_INDEX.get(st);
  if (m && p && p.publicId) m.set(p.publicId, token);
}
function tokenForPublicId(st, pid) {
  if (typeof pid !== "string" || !pid || pid.length > 64) return null;
  let m = PID_INDEX.get(st) || buildPidIndex(st);
  let t = m.get(pid);
  if (t === undefined && m.size !== Object.keys(st.players).length) t = buildPidIndex(st).get(pid);
  return t !== undefined && Object.hasOwn(st.players, t) && st.players[t] && st.players[t].publicId === pid ? t : null;
}

const LB_CACHE = new WeakMap(); // state -> { at, rows, total }
const invalidateLeaderboard = (st) => LB_CACHE.delete(st);
const pushRing = (arr, entry, max) => {
  arr.push(entry);
  if (arr.length > max) arr.splice(0, arr.length - max);
};

// Validate and resolve one raid by the player behind `token` on body {target (publicId), stake, mult}.
// Order: window -> attacker earned enough -> attacker not behind a bought shield -> daily allowance ->
// target -> target earned enough -> target not shielded -> eligibility/revenge -> multiplier -> stake.
// Refusals use no raid. Lucky Whisker is spent on any resolved raid; Wager Insurance only on a loss.
// Mutates st only
// on success. opts.chainReadAt: live-mode freshness (null in demo); opts.rng: injectable for tests.
function applyRaid(st, token, body, now = Date.now(), { chainReadAt = null, rng = Math.random } = {}) {
  const R = BALANCE.RAID;
  const atk = getPlayer(st, token);
  if (!atk) return fail("unknown_player");
  const w = raidWindow(st.lastAdvanceAt, now, chainReadAt, st);
  if (!w.open) return fail(w.reason);
  if (!raidReady(atk)) return { ok: false, error: "not_eligible", reason: "fresh_attacker", needEarned: R.MIN_EARNED, earned: Math.max(0, atk.lifetimeWatts | 0) };
  if (boughtShieldUp(atk, now)) return { ok: false, error: "shielded", until: atk.shield.until };
  if (raidsLeft(atk, now) <= 0) return { ok: false, error: "no_raids_left", resetMs: msToUtcMidnight(now) };
  const b = body && typeof body === "object" ? body : {};
  const defToken = tokenForPublicId(st, b.target);
  if (!defToken) return fail("bad_target");
  const def = st.players[defToken];
  if (def !== atk && !raidReady(def)) return { ok: false, error: "not_eligible", reason: "fresh_target", needEarned: R.MIN_EARNED };
  if (def !== atk && shieldUp(def, now)) return { ok: false, error: "target_shielded", until: def.shield.until };
  const el = raidEligibility(atk, def, now);
  if (!el.ok) return fail(el.error);
  const multPct = parseMultPct(b.mult);
  if (multPct == null) return fail("bad_mult");
  const { min, max, limit } = stakeBounds(atk.watts, def.watts, multPct);
  if (!Number.isInteger(b.stake)) return { ok: false, error: "bad_stake", min, max, limit };
  if (b.stake < min || b.stake > max) return { ok: false, error: "stake_out_of_range", min, max, limit };
  const stake = b.stake;

  // the whisker is only spent when it can help: odds already at P_MAX leave it armed for the next raid
  const lucky = boostActive(atk, "lucky_whisker", now) && raidChance(atk, def, multPct) < R.P_MAX_PCT / 100;
  const r = resolveRaid(atk, def, stake, multPct, rng, lucky ? BALANCE.BOOSTS.lucky_whisker.ODDS_PTS : 0);
  if (lucky) { atk.effects.lucky_whisker = false; r.lucky = true; }
  if (r.win) {
    def.watts -= r.loot;
    atk.watts += r.loot;
    def.shield = { until: now + BALANCE.SHIELD.BRUISE_MS, kind: "bruise" }; // a bruise: a few minutes of peace
  } else {
    const insured = boostActive(atk, "wager_insurance", now);
    const refund = insured ? Math.floor((stake * BALANCE.BOOSTS.wager_insurance.REFUND_PCT) / 100) : 0;
    if (insured) { atk.effects.wager_insurance = false; r.refund = refund; }
    atk.watts -= stake - refund;
    st.burned = (Number.isFinite(st.burned) ? st.burned : 0) + stake - refund;
  }
  atk.lastRaidAt = now;
  const day = utcDay(now);
  atk.raidsToday = atk.raidDay === day ? (atk.raidsToday | 0) + 1 : 1;
  atk.raidDay = day;
  if (el.revenge) el.revenge.avenged = true; // the 70% waiver was used: this provocation is spent
  if (!Array.isArray(def.raidedBy)) def.raidedBy = [];
  def.raidedBy = def.raidedBy.filter((e) => e && now - e.at < R.REVENGE_WINDOW_MS);
  pushRing(def.raidedBy, { pid: atk.publicId, at: now, avenged: false }, R.RAIDED_BY_MAX);
  const feed = { at: now, atk: displayName(atk), atkId: atk.publicId, def: displayName(def), defId: def.publicId, win: r.win, amount: r.win ? r.loot : stake - (r.refund || 0), crit: r.win ? r.crit : false }; // a loss: what actually burned
  if (!Array.isArray(st.raidFeed)) st.raidFeed = [];
  pushRing(st.raidFeed, feed, R.FEED_MAX);
  invalidateLeaderboard(st);
  return { ok: true, result: { ...r, stake, multPct, revenge: !!el.revenge, raidsLeft: raidsLeft(atk, now) }, feed, attacker: atk, defender: def };
}

// Every player by current balance (top LEADERBOARD_MAX), projected once per LEADERBOARD_CACHE_MS
// (a raid invalidates it). Per-viewer flags are added on top of the cached rows.
function leaderboardRows(st, now) {
  const R = BALANCE.RAID;
  const c = LB_CACHE.get(st);
  if (c && now >= c.at && now - c.at < R.LEADERBOARD_CACHE_MS) return c;
  const all = Object.values(st.players).filter((p) => p && p.publicId);
  all.sort((a, b) => b.watts - a.watts || b.lifetimeWatts - a.lifetimeWatts || (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0));
  const rows = all.slice(0, R.LEADERBOARD_MAX).map((p, i) => ({ rank: i + 1, publicId: p.publicId, nick: p.nick, name: displayName(p), verified: !!p.wallet, watts: p.watts, lifetimeWatts: p.lifetimeWatts, roomTier: p.roomTier | 0, fresh: !raidReady(p),
    shieldUntil: p.shield && p.shield.until > now ? p.shield.until : 0 }));
  const out = { at: now, rows, total: all.length };
  LB_CACHE.set(st, out);
  return out;
}
// What `viewer` (null: anonymous) may do to den `row` ({publicId, watts, fresh, shielded}): the same
// rules applyRaid enforces (it re-checks everything). Shared by the leaderboard and den visits.
function viewerFlags(viewer, row, now) {
  const you = !!viewer && row.publicId === viewer.publicId;
  const revenge = !!viewer && !you && pendingRevenge(viewer, row.publicId, now) != null;
  const raidable = !!viewer && !you && raidReady(viewer) && !boughtShieldUp(viewer, now) && !row.fresh && !row.shielded && (row.watts * 100 >= viewer.watts * BALANCE.RAID.ELIGIBLE_MIN_PCT || revenge);
  return { raidable, revenge, you };
}
function leaderboard(st, token, now = Date.now(), { chainReadAt = null } = {}) {
  const viewer = getPlayer(st, token);
  const c = leaderboardRows(st, now);
  const rows = c.rows.map(({ shieldUntil, ...r }) => {
    const shielded = shieldUntil > now; // cached rows hold the expiry, so a shield ends on time
    return { ...r, shielded, ...viewerFlags(viewer, { ...r, shielded }, now) };
  });
  return { rows, total: c.total, cachedAt: c.at, raid: viewer ? raidStatus(st, viewer, now, chainReadAt) : null };
}

// ---------- den visits ----------
// A den as visitors see it: how it looks (style, furniture, fixtures, tiers, skin, a raised shield)
// and what the leaderboard already shows (name, watts). Never its crates, held items, boosts,
// wallet address or token. raid: the viewer's flags against it, as on the leaderboard.
function denView(st, p, viewer, now = Date.now()) {
  const sh = shieldUp(p, now) ? { until: p.shield.until, kind: p.shield.kind } : { until: 0, kind: null };
  const den = {
    publicId: p.publicId, name: displayName(p), verified: !!p.wallet, watts: p.watts, lifetimeWatts: p.lifetimeWatts,
    roomTier: p.roomTier | 0, wheelTier: p.wheelTier | 0, bedTier: p.bedTier | 0, skin: p.skin, wallpaper: p.wallpaper, floor: p.floor,
    placed: (p.placed || []).map(({ pid, item, x, y, flip }) => ({ pid, item, x, y, flip: !!flip })),
    fixtures: { wheel: { ...p.fixtures.wheel }, bed: { ...p.fixtures.bed } },
    shield: sh,
  };
  const row = { publicId: p.publicId, watts: p.watts, fresh: !raidReady(p), shielded: sh.until > 0 };
  return { den, raid: { ...viewerFlags(viewer, row, now), fresh: row.fresh, shielded: row.shielded } };
}
// GET /api/den?id=<publicId>&token=<viewer, optional>
function visitDen(st, id, token, now = Date.now()) {
  const t = tokenForPublicId(st, id);
  if (!t) return fail("unknown_den");
  return { ok: true, ...denView(st, st.players[t], getPlayer(st, token), now) };
}
// GET /api/den/random?token=: any named den but the viewer's. The token list is cached for 10 s.
const RANDOM_CACHE = new WeakMap(); // state -> { at, tokens }
function randomDen(st, token, now = Date.now(), rng = Math.random) {
  let c = RANDOM_CACHE.get(st);
  if (!c || now < c.at || now - c.at >= 10_000) RANDOM_CACHE.set(st, (c = { at: now, tokens: Object.keys(st.players).filter((t) => st.players[t] && st.players[t].username) }));
  const viewer = getPlayer(st, token);
  const pool = viewer ? c.tokens.filter((t) => t !== token) : c.tokens;
  const live = pool.filter((t) => Object.hasOwn(st.players, t));
  if (!live.length) return fail("no_dens");
  return { ok: true, ...denView(st, st.players[live[Math.floor(rng() * live.length) % live.length]], viewer, now) };
}

// ---------- state ----------
let state = {
  startHeight: null, // chain block height when the room server was born
  height: null, // settled Squeek block height (12 confirmations)
  lastAccruedHeight: null, // every player has been credited through this height
  lastAdvanceAt: null, // server ms when the settled height last advanced (the sleep clock)
  lastBedTickAt: null, // server ms of the last bed-income tick (reset on every boot: no catch-up)
  chain: null, // last SqueekCore.state() read
  hamster: null, // live reading (from the API, when reachable; faked in demo)
  lastError: null,
  apiError: null,
  born: null,
  certSerial: 0,
  burned: 0, // watts destroyed by lost raid stakes (supply accounting)
  lastGolden: null, // newest golden block {height, at}
  raidFeed: [], // last BALANCE.RAID.FEED_MAX raids, oldest first
  players: {},
};

// Bring a freshly read state (any older version) up to the current shape.
function patchState(st, now = Date.now()) {
  if (!st.players || typeof st.players !== "object") st.players = {};
  if (st.lastAccruedHeight == null && st.height != null) st.lastAccruedHeight = st.height;
  // a state file without a sleep clock: assume the chain just moved (he counts as asleep 10 min later)
  if (!Number.isFinite(st.lastAdvanceAt) && st.height != null) st.lastAdvanceAt = now;
  st.lastBedTickAt = null; // bed income never pays for the time the server was down
  if (!Number.isFinite(st.burned)) st.burned = 0;
  if (!Array.isArray(st.raidFeed)) st.raidFeed = [];
  for (const [token, p] of Object.entries(st.players)) if (p && typeof p === "object") patchPlayer(p, token);
  return st;
}
// Bump STATE_RESET to wipe the saved state once on the next boot (a clean relaunch: every room,
// balance and the replay anchor). The old file is kept beside it as state.<old id>.bak.json.
const STATE_RESET = "2026-11-01-floor-tiles"; // wiped again: furniture moved from wall columns onto floor tiles
function load() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {}
  if (saved && saved.resetId !== STATE_RESET) {
    const bak = DATA_FILE.replace(/\.json$/, `.${saved.resetId || "pre-reset"}.bak.json`);
    try {
      fs.copyFileSync(DATA_FILE, bak);
    } catch (e) {
      console.error("state reset: backup failed:", e.message || e);
    }
    console.log(`state reset to ${STATE_RESET}: ${Object.keys(saved.players || {}).length} rooms wiped, old state kept at ${bak}`);
    saved = null;
  }
  if (saved) state = { ...state, ...saved };
  const fresh = state.resetId !== STATE_RESET;
  state.resetId = STATE_RESET;
  patchState(state);
  const purged = runMigrations(state);
  if (fresh || purged) writeNow(); // persist a wipe or a purge at once, so a crash can't bring the old dens back
}
// One-time migrations, each gated by a flag in state.migrations. Returns true when something changed.
// anonPurge1 (v4): dens without a username are deleted; they're kept in state.anon-purge.bak.json.
// The backup is written BEFORE anything is deleted; if it can't be written nothing is deleted and the
// flag stays unset, so the next boot tries again.
function runMigrations(st, now = Date.now(), { backupFile = DATA_FILE.replace(/\.json$/, ".anon-purge.bak.json"), log = console.log } = {}) {
  if (!st.migrations || typeof st.migrations !== "object") st.migrations = {};
  if (st.migrations.anonPurge1) return false;
  const doomed = {};
  for (const [t, p] of Object.entries(st.players || {})) if (!p || typeof p !== "object" || typeof p.username !== "string" || !p.username) doomed[t] = p;
  if (Object.keys(doomed).length) {
    try {
      if (!backupFile) throw new Error("no backup file");
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.writeFileSync(backupFile, JSON.stringify({ at: new Date(now).toISOString(), players: doomed }));
    } catch (e) {
      console.error("anon purge: backup failed, nothing deleted (retried next boot):", e.message || e);
      return false;
    }
  }
  const removed = purgeNameless(st);
  const list = Object.values(removed).filter(Boolean);
  st.migrations.anonPurge1 = new Date(now).toISOString();
  const spent = list.filter((p) => Number.isFinite(p.watts) && Number.isFinite(p.lifetimeWatts) && p.watts < p.lifetimeWatts + BALANCE.WELCOME_WATTS).length;
  log(`anon purge: ${list.length} nameless dens deleted (${spent} had spent watts, ${list.filter((p) => p.wallet).length} had a wallet, ${list.filter((p) => p.nick && p.nick !== "anon").length} had a nick); backup: ${list.length ? backupFile : "none"}`);
  return true;
}
// Coalesced, atomic save: at most one write per SAVE_DEBOUNCE_MS (a steady stream of changes
// cannot starve it), written to a tmp file then renamed over state.json.
// The regular save serializes SAVE_CHUNK players per event-loop turn, so a big state never freezes
// the server (50k dens = ~68 MB of JSON). A raid landing between two chunks can leave that one file
// a raid out of step; the next save fixes it, and shutdown (writeNow) is always one consistent write.
let saveTimer = null;
let saving = false; // a chunked save is in flight
let saveAgain = false; // something changed while it ran
let writeGen = 0; // bumped by writeNow: an older chunked save must not rename over it
function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeGen++;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  security.beforeWrite();
  fs.renameSync(tmp, DATA_FILE);
  security.wrote();
}
async function writeChunked() {
  const gen = writeGen;
  const st = state;
  const { players, ...rest } = st;
  const parts = [];
  const tokens = Object.keys(players);
  for (let i = 0; i < tokens.length; i += SAVE_CHUNK) {
    if (i) await new Promise((r) => setImmediate(r));
    for (const t of tokens.slice(i, i + SAVE_CHUNK)) if (st.players[t] !== undefined) parts.push(`${JSON.stringify(t)}:${JSON.stringify(st.players[t])}`);
  }
  const head = JSON.stringify(rest);
  const text = `${head.slice(0, -1)}${head.length > 2 ? "," : ""}"players":{${parts.join(",")}}}`;
  await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".chunked.tmp";
  await fs.promises.writeFile(tmp, text);
  if (gen === writeGen) {
    security.beforeWrite();
    await fs.promises.rename(tmp, DATA_FILE);
    security.wrote();
  }
}
function save() {
  if (saving) { saveAgain = true; return; }
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    saving = true;
    try {
      await writeChunked();
    } catch (e) {
      console.error("save failed:", e.message || e);
    }
    saving = false;
    if (saveAgain) { saveAgain = false; save(); }
  }, SAVE_DEBOUNCE_MS);
}

// Height advanced: credit everyone. First reading only sets the baseline.
// The speed ring follows the server's own state only (tests pass their own st: no bonus, no samples).
function advanceTo(h, now = Date.now(), st = state) {
  const own = st === state;
  if (st.startHeight == null) {
    st.startHeight = h;
    st.height = h;
    st.lastAccruedHeight = h;
    st.born = new Date(now).toISOString();
    st.lastAdvanceAt = now; // first sighting: we can't know how long it's been quiet
    for (const p of Object.values(st.players)) if (p.joinHeight == null) p.joinHeight = h;
    if (own) recordSpeedSample(h, now);
    return;
  }
  if (h <= st.height) return;
  st.height = h;
  st.lastAdvanceAt = now;
  if (own) recordSpeedSample(h, now);
  accrueAll(st, h, now, own ? currentSpeedPct(now) : 100);
}
// When the chain was last read successfully (live mode only; demo and replay drive the height themselves).
function chainReadAt() {
  if (DEMO || REPLAY) return null;
  const t = state.chain && Date.parse(state.chain.updatedAt);
  return Number.isFinite(t) ? t : 0;
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

// ---------- replay mode (REPLAY=1 or --replay) ----------
// Before mainnet the deployed room can run on a simulated Squeektoshi instead of the Sepolia chain.
// Nothing is fetched (no RPC, no api.squeekchain.com); the settled height is a pure function of the
// wall clock:
//   height(t) = offset + replayCumulativeBlocks(t)
// so a restart neither replays nor skips a block (downtime is caught up exactly like in live mode).
// offset is REPLAY_START_HEIGHT on a fresh state. When an existing state.json switches to replay (or
// the speed / epoch changes) it is chosen once so the height carries on from where it stood (no
// windfall, no stall), and stored with the schedule key in state.replay = {key, offset, since}.
// Everything downstream (accrueAll, chainIdle, bed income, raid windows) runs unchanged: a sleep
// segment leaves the height still, so 10 min in he counts as asleep and raids close; the first poll
// inside a run settles a block (the per-run count rounds UP), which reopens them.
//
// Schedule source: Squeektoshi's real history, GET /v1/measurement/stats?range=30d (read 31 Oct
// 2026: 5 nights, 26-30 Oct, 58,518 work units / 5,204 settled blocks = 11.25 units per block,
// ~1,041 blocks a night). She runs only 21:00-07:30 UTC; the night's work by slice: 21:00-22:00 12%,
// 22:00-23:30 31% (peak half-hour 22:00), 23:30-02:00 35%, 02:00-05:00 14.5%, 05:00-07:30 7.7%, and
// not one passage 07:30-21:00 (~13.5 h asleep). A replay "night" keeps that order and work split but
// is compressed into 24 h / SPEED (8 h at the default 3x), with runs of 10-30 min and rests of
// 20-60 min, so every rest outlasts IDLE_AFTER_MS (bed income, raids closed) and a player who checks
// in a few times a day sees both states. The two short daytime stirs are synthetic (the real day is
// silent) so the day sleep never runs past an hour. Blocks per day = 1,078 x SPEED (the real rate the
// balance is tuned on), shared out over the runs by those real work weights.
const REPLAY_NIGHT = [
  // [kind, minutes at the base speed, weight = real work units in the slice it stands for, label]
  ["run", 20, 6989, "evening warm-up"], // 21:00-22:00
  ["sleep", 20, 0, "catnap"],
  ["run", 30, 18107, "peak"], // 22:00-23:30
  ["sleep", 20, 0, "catnap"],
  ["run", 30, 20441, "after midnight"], // 23:30-02:00
  ["sleep", 45, 0, "lull"],
  ["run", 15, 4223, "small hours"], // 02:00-03:30
  ["sleep", 25, 0, "nap"],
  ["run", 15, 4271, "small hours"], // 03:30-05:00
  ["sleep", 45, 0, "nap"],
  ["run", 15, 4487, "dawn"], // 05:00-07:30
  ["sleep", 60, 0, "day sleep"],
  ["run", 10, 2800, "stir"], // synthetic (~4% each): dense enough that he stays awake through it
  ["sleep", 60, 0, "day sleep"],
  ["run", 10, 2800, "stir"], // synthetic
  ["sleep", 60, 0, "day sleep"],
];
// Nonstop (the default for now, until the real hamster goes live): the same runs with their real work
// weights, stretched to fill the whole cycle with no rests, so he is always running. Same blocks per
// day; there is no sleep, so no bed income. REPLAY_NONSTOP=0 brings back the real nightly rhythm.
const REPLAY_NONSTOP_NIGHT = (() => {
  const runs = REPLAY_NIGHT.filter(([kind]) => kind === "run"), total = REPLAY_NIGHT.reduce((a, [, min]) => a + min, 0);
  const runMin = runs.reduce((a, [, min]) => a + min, 0);
  return runs.map(([kind, min, weight, label]) => [kind, (min * total) / runMin, weight, label]);
})();
const REPLAY_NONSTOP = process.env.REPLAY_NONSTOP !== "0";
const REPLAY_VERSION = 2; // bump when REPLAY_NIGHT changes (re-anchors the offset once, continuously)
const REPLAY_BASE_SPEED = 3; // REPLAY_NIGHT minutes are written for this speed (480 min = 24 h / 3)
const REPLAY_BLOCKS_PER_DAY = 1078; // the real rate; replay settles this x SPEED
const REPLAY_MIN_RUN_MS = 5 * 60_000; // floors when a high SPEED shrinks the segments
const REPLAY_MIN_SLEEP_MS = Math.max(BALANCE.IDLE_AFTER_MS + 10 * 60_000, 20 * 60_000); // always >= 10 min of real sleep; fast replays keep 20-min rests
const REPLAY_RAMP = 0.5; // blocks settle at 0.5x the run's mean rate at its edges, 1.5x mid-run
const REPLAY_MM_PER_BLOCK = 9873; // real: 51,378,804 mm over 5,204 blocks
const REPLAY_WHEEL_MM = 200; // wheel diameter used for rpm (same as the demo and the client)
// The browser ignores a falsy config.api and would keep fetching the real api.squeekchain.com (whose
// reading would contradict the replay). This same-origin base has no /status (404), so the client's
// liveFetch fails, S.live stays null and it shows the server's synthesized reading ("via room server").
const REPLAY_API_SINK = "/api/replay";
const replayEnvNum = (v, ok, dflt) => (v != null && v !== "" && ok(Number(v)) ? Number(v) : dflt);
const REPLAY_SPEED = replayEnvNum(process.env.REPLAY_SPEED, (n) => Number.isFinite(n) && n >= 0.5 && n <= 48, REPLAY_BASE_SPEED);
const REPLAY_START_HEIGHT = replayEnvNum(process.env.REPLAY_START_HEIGHT, (n) => Number.isSafeInteger(n) && n >= 0, 5204);
const REPLAY_EPOCH_MS = Number.isFinite(Date.parse(process.env.REPLAY_EPOCH || "")) ? Date.parse(process.env.REPLAY_EPOCH) : Date.parse("2026-10-30T21:00:00Z");

// The cycle for one speed: segments with absolute offsets in the cycle and whole block counts
// (largest remainder, so they sum exactly to blocksPerCycle). Pure.
function replaySchedule(speed = REPLAY_BASE_SPEED, epochMs = REPLAY_EPOCH_MS, nonstop = false) {
  const k = REPLAY_BASE_SPEED / speed;
  let at = 0;
  const segments = (nonstop ? REPLAY_NONSTOP_NIGHT : REPLAY_NIGHT).map(([kind, min, weight, label]) => {
    const ms = Math.max(Math.round(min * 60_000 * k), kind === "run" ? REPLAY_MIN_RUN_MS : REPLAY_MIN_SLEEP_MS);
    const s = { kind, label, start: at, end: at + ms, ms, weight: kind === "run" ? weight : 0, blocks: 0, before: 0 };
    at += ms;
    return s;
  });
  const cycleMs = at;
  const blocksPerCycle = Math.round((REPLAY_BLOCKS_PER_DAY * speed * cycleMs) / 86_400_000);
  const runs = segments.filter((s) => s.kind === "run");
  const W = runs.reduce((a, s) => a + s.weight, 0);
  const exact = new Map(runs.map((s) => [s, (blocksPerCycle * s.weight) / W]));
  let given = 0;
  for (const s of runs) given += s.blocks = Math.floor(exact.get(s));
  const byRemainder = runs.slice().sort((a, b) => exact.get(b) - b.blocks - (exact.get(a) - a.blocks));
  for (let i = 0; i < blocksPerCycle - given; i++) byRemainder[i % byRemainder.length].blocks++;
  let c = 0;
  for (const s of segments) (s.before = c), (c += s.blocks);
  const maxRate = Math.max(...runs.map((s) => s.blocks / s.ms));
  return { version: REPLAY_VERSION, speed, epochMs, cycleMs, blocksPerCycle, blocksPerDay: (blocksPerCycle * 86_400_000) / cycleMs, maxRate, segments, nonstop, key: `v${REPLAY_VERSION}${nonstop ? "ns" : ""}|x${speed}|${epochMs}` };
}
// Where t falls: cycle number n, segment index i, progress u in [0, 1). null before the epoch.
function replayLocate(t, sched) {
  const dt = t - sched.epochMs;
  if (!(dt > 0)) return null;
  const n = Math.floor(dt / sched.cycleMs);
  const r = dt - n * sched.cycleMs;
  const segs = sched.segments;
  let i = 0;
  while (i < segs.length - 1 && r >= segs[i].end) i++;
  const seg = segs[i];
  return { n, i, seg, r, u: (r - seg.start) / seg.ms, cycleStart: sched.epochMs + n * sched.cycleMs };
}
// Settled fraction of a run at progress u: a smooth ramp (monotonic, rampF(0) = 0, rampF(1) = 1).
const rampF = (u) => u - (REPLAY_RAMP * Math.sin(2 * Math.PI * u)) / (2 * Math.PI);
const rampRate = (u) => 1 - REPLAY_RAMP * Math.cos(2 * Math.PI * u); // d rampF / du, in [0.5, 1.5]
// Rounds up, so a block lands right as a run starts; the run's last block is held for its end, so
// the sleep clock starts exactly when the run is over.
function runBlocksAt(seg, u) {
  if (seg.kind !== "run" || !(u > 0)) return 0;
  if (u >= 1) return seg.blocks;
  return Math.min(seg.blocks > 1 ? seg.blocks - 1 : 1, Math.ceil(seg.blocks * rampF(u)));
}
// Blocks settled from the epoch through t. Deterministic, monotonic non-decreasing in t.
function replayCumulativeBlocks(t, sched) {
  const p = replayLocate(t, sched);
  if (!p) return 0;
  return p.n * sched.blocksPerCycle + p.seg.before + runBlocksAt(p.seg, p.u);
}
// Absolute time of the end of the last run before a sleep at p (when the height last moved).
function replayLastRunEnd(p, sched) {
  const segs = sched.segments;
  for (let j = p.i - 1; j >= 0; j--) if (segs[j].kind === "run") return p.cycleStart + segs[j].end;
  for (let j = segs.length - 1; j >= 0; j--) if (segs[j].kind === "run") return p.cycleStart - sched.cycleMs + segs[j].end;
  return null;
}
function replayNextRunAt(p, sched) {
  if (!p) return sched.epochMs;
  const segs = sched.segments;
  for (let j = p.i + 1; j < segs.length; j++) if (segs[j].kind === "run") return p.cycleStart + segs[j].start;
  return p.cycleStart + sched.cycleMs + segs.find((s) => s.kind === "run").start;
}
// The simulated wheel at t: segment, block progress and a hamster reading in the live API's shape
// (the fields the client reads) plus {key, active, speed, rpm}. Speed follows the run's intensity
// and ramp, ~0.8-1.6 m/s, with a mild deterministic wobble. Pure.
function replayReading(t, sched) {
  const p = replayLocate(t, sched);
  const cum = replayCumulativeBlocks(t, sched);
  const running = !!p && p.seg.kind === "run" && p.u > 0;
  let speed = 0;
  let progress = 0;
  if (running) {
    const settled = p.seg.blocks * rampF(p.u);
    progress = settled - Math.floor(settled);
    const intensity = p.seg.blocks / p.seg.ms / sched.maxRate; // 0..1 (the peak run is 1)
    const wobble = 45 * Math.sin(t / 4700) + 25 * Math.sin(t / 1300);
    speed = Math.round(clamp(800 + 600 * intensity * (rampRate(p.u) / 1.5) + wobble, 800, 1600));
  }
  const rpmMilli = Math.round((speed / (Math.PI * REPLAY_WHEEL_MM)) * 60_000);
  const iso = new Date(t).toISOString();
  return {
    running,
    cumulative: cum,
    progress,
    segment: p ? p.seg.kind : "sleep",
    label: p ? p.seg.label : "before the first night",
    segmentEndsAt: p ? p.cycleStart + p.seg.end : sched.epochMs,
    nextRunAt: running ? null : replayNextRunAt(p, sched),
    lastRunEndAt: p && !running ? replayLastRunEnd(p, sched) : null,
    hamster: {
      coreStatus: running ? "ACTIVE" : "IDLE",
      freshness: "online",
      speedMmPerSecond: speed,
      rpmMilli,
      distanceMm: cum * REPLAY_MM_PER_BLOCK,
      observedAt: iso,
      updatedAt: iso,
      key: running ? "running" : "idle",
      active: running,
      speed, // mm/s, same as speedMmPerSecond
      rpm: rpmMilli / 1000,
      source: "replay", // not "live": the client labels it "via room server"
    },
  };
}
// One replay poll on state `st`: advance to the scheduled height, then publish chain + hamster.
function replayTick(st, now = Date.now(), sched = REPLAY_SCHEDULE, startHeight = REPLAY_START_HEIGHT) {
  const cum = replayCumulativeBlocks(now, sched);
  if (!st.replay || st.replay.key !== sched.key || !Number.isSafeInteger(st.replay.offset)) {
    st.replay = { key: sched.key, offset: st.height != null ? st.height - cum : startHeight, since: new Date(now).toISOString() };
  }
  const before = st.height;
  advanceTo(st.replay.offset + cum, now, st);
  const r = replayReading(now, sched);
  // Blocks first seen while she already sleeps (the end of a run between polls, a restart after
  // downtime, or the very first boot) settled when that run ended: start the sleep clock there.
  if ((before == null || st.height > before) && !r.running && r.lastRunEndAt != null) st.lastAdvanceAt = Math.min(now, r.lastRunEndAt);
  st.chain = {
    blockHeight: st.height,
    blockProgress: Math.floor(r.progress * 1e9),
    paused: false,
    rpc: "replay",
    updatedAt: new Date(now).toISOString(),
    replay: { speed: sched.speed, segment: r.segment, label: r.label, segmentEndsAt: r.segmentEndsAt, nextRunAt: r.nextRunAt },
  };
  st.hamster = r.hamster;
  noteStatus(st, now);
  st.lastError = null;
  st.apiError = null;
  return st.height;
}
// Back from replay to the real chain: the live height becomes a fresh baseline (the jump is never
// paid out, and a lower live height does not stall income until it catches up).
function leaveReplay(st, h, now = Date.now()) {
  st.height = h;
  st.lastAccruedHeight = h;
  st.lastAdvanceAt = now;
  if (st.startHeight == null || st.startHeight > h) st.startHeight = h;
  for (const p of Object.values(st.players)) if (p && Number.isFinite(p.joinHeight) && p.joinHeight > h) p.joinHeight = h;
  delete st.replay;
  if (st === state) resetSpeedSamples(); // the jump is not a cadence
}
const REPLAY_SCHEDULE = replaySchedule(REPLAY_SPEED, REPLAY_EPOCH_MS, REPLAY_NONSTOP);
// Speed-bonus baseline (blocks/min that pays 100%): replay's own mean run cadence, else BASE_BPM.
const SPEED_BASE_BPM = REPLAY ? replayRunMeanBpm(REPLAY_SCHEDULE) : BALANCE.SPEED.BASE_BPM;

async function poll() {
  // 1. Settled height from the contract (authoritative for the economy).
  //    In demo mode the chain only seeds the starting height; after that /api/dev/* drives it.
  //    In replay mode the schedule is the chain: no RPC at all.
  if (REPLAY) replayTick(state, Date.now());
  else {
    try {
      const c = await readCoreState();
      if (DEMO) {
        if (state.height == null && c.blockHeight > 0) advanceTo(c.blockHeight);
        state.chain = { ...c, blockHeight: state.height, rpc: "demo" };
      } else {
        if (state.replay && c.blockHeight > 0) leaveReplay(state, c.blockHeight);
        state.chain = c;
        if (c.blockHeight > 0) advanceTo(c.blockHeight);
      }
      state.lastError = null;
    } catch (e) {
      state.lastError = `rpc: ${String(e.message || e)}`;
      // live: cadence unknown while blind, so the catch-up after the outage earns no speed bonus
      if (!DEMO) resetSpeedSamples();
    }
  }
  const now = Date.now();
  // Speed ring: one sample per tick even when nothing advanced, so the window ages while he sleeps.
  if (state.height != null && (REPLAY || DEMO || !state.lastError)) recordSpeedSample(state.height, now);
  // 2. Bed income: while he sleeps (asleep(): the live reading, else the chain), every room earns for
  //    the time since the last tick.
  noteStatus(state, now); // every poll, whichever mode set the reading (demo readings aren't re-stamped)
  accrueBed(state, asleep(state, now, chainReadAt()), now);
  // 3. Live hamster reading. Demo mode fakes it (and lets a fake run go back to sleep); replay
  //    already synthesized it in replayTick().
  if (DEMO) {
    const h = state.hamster;
    if (!night && (!h || (h.coreStatus === "ACTIVE" && Date.now() - Date.parse(h.updatedAt) > 30_000))) setDemoHamster("IDLE");
  } else if (!REPLAY) {
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
      noteStatus(state);
      state.apiError = null;
    } catch (e) {
      state.apiError = String(e.message || e);
    }
  }
  security.tick(state, { saving });
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
  noteStatus(state);
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
// On every response. The CSP allows only this origin, Google Fonts and the live status API; inline
// style attributes stay allowed (index.html uses a few), inline scripts do not.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${new URL(API).origin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
};
const GZIP_MIN = 1024;
const acceptsGzip = (req) => !!req && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
function json(res, code, body) {
  let data = Buffer.from(JSON.stringify(body));
  const headers = { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "accept-encoding" };
  if (data.length >= GZIP_MIN && acceptsGzip(res.req)) {
    data = zlib.gzipSync(data, { level: 6 });
    headers["content-encoding"] = "gzip";
  }
  res.writeHead(code, headers);
  res.end(data);
}
// Static files never change inside a running container (a deploy is a new one), so each is read and
// gzipped once and served with an ETag: a returning visitor revalidates with a 304 instead of
// downloading it all again.
const STATIC_CACHE = new Map(); // full path -> { data, gz, etag, type }
function staticFile(full) {
  let f = STATIC_CACHE.get(full);
  if (!f) {
    const data = fs.readFileSync(full);
    f = { data, gz: zlib.gzipSync(data, { level: 9 }), etag: `"${sha256(data).slice(0, 16)}"`, type: MIME[path.extname(full)] || "application/octet-stream" };
    STATIC_CACHE.set(full, f);
  }
  return f;
}
function serveStatic(req, res, full) {
  let f;
  try {
    f = staticFile(full);
  } catch {
    return json(res, 404, { error: "not_found" });
  }
  const headers = { ...SECURITY_HEADERS, "content-type": f.type, "cache-control": "no-cache", etag: f.etag, vary: "accept-encoding" };
  if (req.headers["if-none-match"] === f.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const gz = acceptsGzip(req) && f.gz.length < f.data.length;
  if (gz) headers["content-encoding"] = "gzip";
  res.writeHead(200, headers);
  res.end(gz ? f.gz : f.data);
}
const BODY_MAX = 64_000;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > BODY_MAX) {
        reject(new Error("too big"));
        req.destroy(); // stop reading: an endless body must not grow in memory
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const d = Buffer.concat(chunks).toString("utf8");
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}
// New dens per client address: one script can't fill MAX_PLAYERS (which would lock every new player
// out) or mint welcome grants by the thousand. Railway's edge sets X-Real-IP; locally it's the socket.
// Den visits per client address: a visit is cheap, but nobody should crawl every den in a minute.
const VISIT_LIMIT = { MAX: 120, WINDOW_MS: 60_000 };
const visitHits = new Map(); // ip -> { start, n }
function allowVisit(ip, now = Date.now()) {
  if (!ip) return true;
  if (visitHits.size > 10_000) for (const [k, e] of visitHits) if (now - e.start >= VISIT_LIMIT.WINDOW_MS) visitHits.delete(k);
  let e = visitHits.get(ip);
  if (!e || now - e.start >= VISIT_LIMIT.WINDOW_MS) visitHits.set(ip, (e = { start: now, n: 0 }));
  if (e.n >= VISIT_LIMIT.MAX) return false;
  e.n++;
  return true;
}
const NEW_DEN_LIMIT = { MAX: 60, WINDOW_MS: 3_600_000 };
const newDenHits = new Map(); // ip -> { start, n }
const clientIp = (req) => String((req && req.headers["x-real-ip"]) || (req && req.socket && req.socket.remoteAddress) || "").trim().slice(0, 64);
function allowNewDen(ip, now = Date.now()) {
  if (!ip) return true;
  if (newDenHits.size > 10_000) for (const [k, e] of newDenHits) if (now - e.start >= NEW_DEN_LIMIT.WINDOW_MS) newDenHits.delete(k);
  let e = newDenHits.get(ip);
  if (!e || now - e.start >= NEW_DEN_LIMIT.WINDOW_MS) newDenHits.set(ip, (e = { start: now, n: 0 }));
  if (e.n >= NEW_DEN_LIMIT.MAX) return false;
  e.n++;
  return true;
}
function publicPlayer(p, now = Date.now()) {
  const bonusPct = liveBonusPct(p, now);
  return {
    publicId: p.publicId,
    nick: p.nick,
    createdAt: p.createdAt,
    joinHeight: p.joinHeight,
    watts: p.watts,
    lifetimeWatts: p.lifetimeWatts,
    wheelTier: p.wheelTier,
    multPct: BALANCE.WHEEL_MULT_PCT[p.wheelTier],
    bedTier: p.bedTier | 0,
    bedMultPct: bedMultPct(p),
    bedWattsPerMin: bedWattsPerMin(p), // before the watching bonus
    roomTier: p.roomTier | 0,
    skin: p.skin,
    wallpaper: p.wallpaper,
    floor: p.floor,
    owned: p.owned,
    placed: p.placed,
    fixtures: p.fixtures,
    activeDays: p.activeDays,
    watching: bonusPct > 100,
    bonusPct,
    nextHeartbeatMs: p.lastHeartbeat > 0 ? Math.max(0, BALANCE.HEARTBEAT_MIN_INTERVAL_MS - (now - p.lastHeartbeat)) : 0,
    certEligible: certEligible(p),
    commemorative: p.commemorative,
    wallet: p.wallet || null,
    username: p.username || null,
    verified: !!p.wallet,
    items: p.items,
    effects: p.effects, // timed: expiry ms (server clock); next-raid: true while armed
    shield: { until: shieldUp(p, now) ? p.shield.until : 0, kind: shieldUp(p, now) ? p.shield.kind : null, usedToday: shieldUsedToday(p, now), price: shieldPrice(p) },
    crates: (p.crates || []).map(({ id, at, i, j }) => ({ id, at, i, j })), // never the contents
    cratesToday: p.crateDay === utcDay(now) ? p.cratesToday | 0 : 0,
  };
}
let playerCount = 0;
function snapshot(token, ip = null) {
  const now = Date.now();
  let me = null;
  let meError = null;
  let needsName = false; // a fresh token: no den until the name step (POST /api/username) creates one
  if (typeof token === "string" && TOKEN_RE.test(token)) {
    const p = getPlayer(state, token);
    if (p) {
      p.lastSeen = now;
      me = publicPlayer(p, now);
      save();
    } else needsName = true;
  } else if (token) meError = "bad_token";
  const readAt = chainReadAt();
  const viewer = me ? getPlayer(state, token) : null;
  // Dynamic data only (polled every few seconds); the static rules live in configPayload().
  return {
    startHeight: state.startHeight,
    height: state.height,
    lastAccruedHeight: state.lastAccruedHeight,
    born: state.born,
    night: night ? { startedAt: night.startedAt, endsAt: night.endsAt } : null,
    chain: state.chain || null,
    hamster: state.hamster,
    idle: asleep(state, now, readAt), // asleep (live reading, else the chain): bed income flows, raids are closed
    speedPct: currentSpeedPct(now), // speed bonus on wheel income (100 = none), from the chain's cadence
    golden: state.lastGolden || null, // newest golden block {height, at}: 10x wheel watts for everyone watching
    raid: viewer ? raidStatus(state, viewer, now, readAt) : null, // this viewer's raid window + cooldown
    raidFeed: (Array.isArray(state.raidFeed) ? state.raidFeed : []).slice(-BALANCE.RAID.FEED_SNAPSHOT), // oldest first
    burned: state.burned || 0,
    lastError: state.lastError,
    apiError: state.apiError || null,
    players: playerCount,
    certsIssued: state.certSerial,
    serverTime: now,
    me,
    meError,
    needsName,
  };
}
// Static rules and catalog: fetched once per page load (GET /api/config), never polled.
// Every BALANCE key is public tuning (nothing secret lives there), so it ships whole.
// Replay: `api` points at REPLAY_API_SINK (see there) so the browser uses the server's synthesized
// reading, and `replay` describes the schedule; null outside replay.
function configPayload({ replay = REPLAY, sched = REPLAY_SCHEDULE } = {}) {
  return {
    demo: DEMO, core: CORE, api: replay ? REPLAY_API_SINK : API, balance: BALANCE, room: ROOM, catalog: CATALOG,
    replay: replay ? { speed: sched.speed, blocksPerDay: sched.blocksPerDay, cycleMs: sched.cycleMs, epoch: new Date(sched.epochMs).toISOString(), nonstop: !!sched.nonstop } : null,
    wallet: { enabled: true, usernameRe: WALLET.USERNAME_RE.source, burnerWarning: true, nonceTtlMs: WALLET.NONCE_TTL_MS },
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
    return okMe(p, { item: r.item.id, price: r.price });
  },
  "/api/place": (b, p) => {
    const v = validatePlacement(p, b.itemId, b.x, b.y, null, b.flip === true);
    if (!v.ok) return err(400, v.error, v.which ? { which: v.which } : {});
    const entry = { pid: crypto.randomBytes(4).toString("hex"), item: v.item.id, x: v.x, y: v.y, flip: b.flip === true };
    p.placed.push(entry);
    return okMe(p, { placed: entry });
  },
  "/api/move": (b, p) => {
    const e = typeof b.pid === "string" ? p.placed.find((q) => q.pid === b.pid) : null;
    if (!e) return err(404, "unknown_pid");
    const v = validatePlacement(p, e.item, b.x, b.y, e.pid, typeof b.flip === "boolean" ? b.flip : !!e.flip);
    if (!v.ok) return err(400, v.error, v.which ? { which: v.which } : {});
    e.x = v.x;
    e.y = v.y;
    if (typeof b.flip === "boolean") e.flip = b.flip;
    return okMe(p, { placed: e });
  },
  // {which: "wheel"|"bed", i, j, flip?}: stand the wheel or the bed on another floor tile
  "/api/fixture": (b, p) => {
    const r = moveFixture(p, b);
    if (!r.ok) return err(400, r.error, r.with ? { with: r.with } : {});
    return okMe(p, { fixture: r.fixture });
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
  // {target: defender publicId, stake: integer watts, mult: 1.5|2|3|5|10 (or 150..1000)}
  "/api/raid": (b, p, token) => {
    const r = applyRaid(state, token, b, Date.now(), { chainReadAt: chainReadAt() });
    if (!r.ok) {
      const code = RAID_ERR_STATUS[r.error] || 400;
      const { ok, error, ...extra } = r;
      return err(code, error, extra);
    }
    return okMe(p, { result: r.result, feed: r.feed });
  },
  // {kind: double_wheel|deep_sleep|lucky_whisker|wager_insurance, from: "item"|"watts"}
  "/api/boost": (b, p, token) => {
    const r = useBoost(state, token, b);
    if (!r.ok) { const { ok, error, ...extra } = r; return err(SHOP_ERR_STATUS[error] || 400, error, extra); }
    return okMe(p, { kind: r.kind });
  },
  // {from: "token"|"watts"}: three hours of raid immunity, once a UTC day
  "/api/shield": (b, p, token) => {
    const r = raiseShield(state, token, b);
    if (!r.ok) { const { ok, error, ...extra } = r; return err(SHOP_ERR_STATUS[error] || 400, error, extra); }
    return okMe(p, { shield: r.shield });
  },
  // {id}: open a lucky crate
  "/api/crate": (b, p, token) => {
    const r = openCrate(state, token, b);
    if (!r.ok) return err(SHOP_ERR_STATUS[r.error] || 400, r.error);
    return okMe(p, { got: r.got });
  },
  // Wallet sign-in: nonce -> personal_sign in the wallet -> verify {address, signature} -> username.
  "/api/wallet/nonce": (b, p, token) => {
    const r = issueWalletNonce(state, token);
    if (!r.ok) return err(WALLET_ERR_STATUS[r.error] || 400, r.error);
    return [200, r];
  },
  "/api/wallet/verify": (b, p, token) => {
    const r = verifyWallet(state, token, b);
    if (!r.ok) return err(WALLET_ERR_STATUS[r.error] || 400, r.error);
    return okMe(p, { wallet: r.wallet });
  },
};
// {username}: set or change the den's username (the onboarding step and the side panel; the wallet
// panel still uses its old path)
const USERNAME_PATHS = new Set(["/api/username", "/api/wallet/username"]);
POST_ROUTES["/api/username"] = POST_ROUTES["/api/wallet/username"] = (b, p, token) => {
  const r = setUsername(state, token, b);
  if (!r.ok) return err(WALLET_ERR_STATUS[r.error] || 400, r.error);
  return okMe(p, { username: r.username });
};
const RAID_ERR_STATUS = { hamster_asleep: 409, chain_unknown: 409, chain_stale: 409, no_raids_left: 429, bad_target: 404, unknown_player: 404, not_eligible: 403, self_target: 400, shielded: 409, target_shielded: 409 };
const SHOP_ERR_STATUS = { unknown_player: 404, not_for_sale: 403, boost_active: 409, shield_active: 409, shield_used_today: 429, unknown_crate: 404 };
const WALLET_ERR_STATUS = { unknown_player: 404, no_nonce: 409, nonce_expired: 410, wallet_taken: 409, username_taken: 409, server_full: 503, too_many_dens: 429, den_exists: 409 };
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
  // Wind the chain's sleep clock past IDLE_AFTER_MS so he counts as asleep (bed income) right away.
  "/api/dev/sleep": () => {
    if (night) return err(409, "night_running", { endsAt: night.endsAt });
    if (state.height == null) demoBlocks(0);
    state.lastAdvanceAt = Date.now() - BALANCE.IDLE_AFTER_MS - 60_000;
    setDemoHamster("IDLE");
    state.lastStatusActiveAt = 0; // asleep by the live reading right away too
    return [200, { ok: true, height: state.height, lastAdvanceAt: state.lastAdvanceAt, idle: true }];
  },
};

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, snapshot(url.searchParams.get("token"), clientIp(req)));
    }
    if (url.pathname === "/api/config" && req.method === "GET") return json(res, 200, configPayload());
    if ((url.pathname === "/api/den" || url.pathname === "/api/den/random") && req.method === "GET") {
      if (!allowVisit(clientIp(req))) return json(res, 429, { error: "slow_down" });
      const tok = url.searchParams.get("token");
      const r = url.pathname === "/api/den" ? visitDen(state, url.searchParams.get("id"), tok) : randomDen(state, tok);
      if (!r.ok) return json(res, 404, { error: r.error });
      const { ok, ...body } = r;
      return json(res, 200, body);
    }
    if (url.pathname === "/api/leaderboard" && req.method === "GET") {
      return json(res, 200, leaderboard(state, url.searchParams.get("token"), Date.now(), { chainReadAt: chainReadAt() }));
    }
    const devRoute = DEMO ? DEV_ROUTES[url.pathname] : undefined;
    if (!DEMO && url.pathname.startsWith("/api/dev/")) security.devProbe(url.pathname, clientIp(req));
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
        if (!p && USERNAME_PATHS.has(url.pathname)) { // the name step creates the den
          const r = createDen(state, token, b, Date.now(), { ip: clientIp(req), count: playerCount });
          if (!r.ok) return json(res, WALLET_ERR_STATUS[r.error] || 400, { error: r.error });
          playerCount++;
          out = okMe(r.player, { username: r.username, created: true });
        } else if (!p) return json(res, 404, { error: "unknown_player" });
        else out = route(b, p, token);
      }
      save();
      return json(res, out[0], out[1]);
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not_found" });

    // static
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: "forbidden" });
    return serveStatic(req, res, full);
  } catch (e) {
    console.error("request failed:", req.method, url.pathname, e);
    security.serverError(url.pathname);
    json(res, 500, { error: "server_error" });
  }
}

// Security alerts (lib/alert.js): a no-op unless ALERT_WEBHOOK is set.
const security = alert.createSecurity({ dataFile: DATA_FILE, BALANCE, baseBpm: SPEED_BASE_BPM, demo: DEMO });

function listen() {
  const server = http.createServer(handle);
  server.listen(PORT, () => {
    const S = REPLAY_SCHEDULE;
    const mode = DEMO ? "DEMO mode: POST /api/dev/advance|grant|night|sleep" : REPLAY ? `REPLAY mode: ${S.speed}x, ${Math.round(S.blocksPerDay)} blocks/day, ${S.cycleMs / 60_000} min cycle, no chain reads` : "live mode";
    console.log(`Squeekroom on http://localhost:${PORT}  (${mode})`);
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
Object.assign(module.exports, { ROOM, CATALOG_BY_ID, newPlayer, accrueAll, applyBuy, heartbeat, liveBonusPct, claimCommemorative, MAX_PLAYERS, chainIdle,
  accrueBed, asleep, noteStatus, statusFresh, STATUS_PAUSE_MS, bedCredit, bedMultPct, bedWattsPerMin, BED_FRAC_DEN, patchPlayer, patchState, publicIdFor, publicPlayer, snapshot, configPayload,
  raidChance, resolveRaid, raidOdds, raidReady, fixtureTiles, fixtureFits, fixturesClear, repairFixtures, wealthTilt, stakeBounds, lootCap, raidsLeft, moveFixture, validFixtures, parseMultPct, raidEligibility, pendingRevenge, raidWindow, raidStatus, applyRaid,
  leaderboard, invalidateLeaderboard, tokenForPublicId, CHAIN_FRESH_MS, viewerFlags, denView, visitDen, randomDen, allowVisit, VISIT_LIMIT,
  WALLET, displayName, walletMessage, issueWalletNonce, verifyWallet, setUsername, usernameProblem, createDen, purgeNameless, runMigrations,
  REPLAY_NIGHT, REPLAY_NONSTOP_NIGHT, REPLAY_API_SINK, REPLAY_MIN_SLEEP_MS, replaySchedule, replayLocate, replayCumulativeBlocks, cumulativeBlocks: replayCumulativeBlocks,
  replayReading, replayTick, leaveReplay, advanceTo,
  wattsFor, speedPctFrom, speedOpts, replayRunMeanBpm, recordSpeedSample,
  BOOST_KINDS, ITEM_KINDS, boostActive, useBoost, raiseShield, shieldUp, boughtShieldUp, shieldPrice, isGoldenBlock, goldenBetween,
  rollCrateContents, rollCrates, crateTile, openCrate,
  COLORWAYS, FREE_IDS });

if (require.main === module) {
  if (DEMO && REPLAY_REQUESTED) {
    console.error("--replay (REPLAY=1) and --demo are mutually exclusive.");
    process.exit(1);
  }
  load();
  security.boot();
  playerCount = Object.keys(state.players).length;
  poll();
  setInterval(poll, POLL_MS);
  listen();
}

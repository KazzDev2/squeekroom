// Economy + rules tests. Run from the repo root: node --test squeekroom/test/
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server.js");
const { BALANCE, CATALOG, accrue, canBuy, validatePlacement, certEligible } = S;

const T0 = Date.UTC(2026, 9, 30, 22, 0, 0);
const fresh = (over = {}) => Object.assign(S.newPlayer(1000, T0), over);
const own = (p, id, n = 1) => ((p.owned[id] = (p.owned[id] || 0) + n), p);
const TOKEN = "a".repeat(32);
const W0 = BALANCE.WELCOME_WATTS; // welcome grant

// ---------- exports + catalog ----------
test("module exports the plan's six names", () => {
  for (const k of ["BALANCE", "CATALOG", "accrue", "canBuy", "validatePlacement", "certEligible"]) assert.ok(k in S, k);
});

test("catalog: unique ids, schema, defaults free, wheel tiers 1..5", () => {
  const ids = new Set(CATALOG.map((i) => i.id));
  assert.equal(ids.size, CATALOG.length);
  for (const i of CATALOG) {
    for (const k of ["id", "name", "cat", "price", "w", "h", "zone", "sprite"]) assert.ok(k in i, `${i.id}.${k}`);
    assert.ok(Number.isInteger(i.price) && i.price >= 0);
    assert.ok(["wheel", "bed", "room", "wallpaper", "floor", "rug", "furniture", "wall", "skin"].includes(i.cat));
  }
  const free = CATALOG.filter((i) => i.price === 0).map((i) => i.id).sort();
  assert.deepEqual(free, ["fl_pine", "fl_straw", "skin_classic", "wp_dirt", "wp_plain"]);
  const wheels = CATALOG.filter((i) => i.cat === "wheel");
  assert.deepEqual(wheels.map((w) => w.tier), [1, 2, 3, 4, 5]);
  assert.deepEqual(wheels.map((w) => w.price), [5000, 18000, 50000, 140000, 400000]);
  assert.deepEqual(wheels.map((w) => w.multPct), [125, 160, 200, 260, 350]);
  const seed = S.CATALOG_BY_ID.get("fur_seed_bowl");
  assert.equal(seed.price, 600);
  assert.equal(seed.w, 1);
  assert.equal(seed.h, 1);
  assert.equal(S.CATALOG_BY_ID.get("wall_tv").animated, true);
});

// ---------- accrual ----------
test("new player: 800 W welcome grant (a first purchase right away), tier 0, defaults owned", () => {
  const p = fresh();
  assert.equal(W0, 800);
  assert.equal(p.watts, 800);
  const cheapest = Math.min(...CATALOG.filter((i) => i.price > 0).map((i) => i.price));
  assert.equal(cheapest, 600);
  assert.ok(canBuy(p, "fur_seed_bowl").ok, "the 600 W seed bowl is affordable on arrival");
  assert.equal(p.wheelTier, 0);
  assert.equal(p.skin, "skin_classic");
  assert.equal(p.wallpaper, "wp_dirt");
  assert.equal(p.floor, "fl_straw");
  for (const id of ["wp_plain", "fl_pine"]) assert.equal(p.owned[id], 1, `${id} stays free to switch back to`);
});

test("accrual: delta x 10 x tier multiplier", () => {
  const p = fresh();
  assert.equal(accrue(p, 10, T0), 100);
  assert.equal(p.watts, W0 + 100);
  assert.equal(p.lifetimeWatts, 100);
  for (const [tier, per10] of [[1, 125], [2, 160], [3, 200], [4, 260], [5, 350]]) {
    const q = fresh({ wheelTier: tier });
    assert.equal(accrue(q, 10, T0), per10, `tier ${tier}`);
  }
});

test("accrual: live bonus 1.2x only while heartbeat is within 90 s", () => {
  const p = fresh({ lastHeartbeat: T0 - 60_000 });
  assert.equal(accrue(p, 10, T0), 120);
  const edge = fresh({ lastHeartbeat: T0 - 90_000 });
  assert.equal(accrue(edge, 10, T0), 120);
  const stale = fresh({ lastHeartbeat: T0 - 90_001 });
  assert.equal(accrue(stale, 10, T0), 100);
  const t1 = fresh({ wheelTier: 1, lastHeartbeat: T0 });
  assert.equal(accrue(t1, 10, T0), 150);
});

test("accrual: always integers (rounded)", () => {
  const p = fresh({ wheelTier: 1 });
  assert.equal(accrue(p, 1, T0), 13); // 12.5 -> 13
  const q = fresh({ wheelTier: 4, lastHeartbeat: T0 });
  assert.equal(accrue(q, 1, T0), 31); // 31.2 -> 31
  for (let i = 0; i < 50; i++) accrue(q, i + 1, T0);
  assert.ok(Number.isInteger(q.watts) && Number.isInteger(q.lifetimeWatts));
});

test("accrual: ignores zero, negative, non-integer deltas", () => {
  const p = fresh();
  assert.equal(accrue(p, 0, T0), 0);
  assert.equal(accrue(p, -5, T0), 0);
  assert.equal(accrue(p, 1.5, T0), 0);
  assert.equal(p.watts, W0);
  assert.equal(p.activeDays, 0);
});

test("accrual: activeDays bumps once per distinct UTC day", () => {
  const p = fresh();
  accrue(p, 1, T0);
  accrue(p, 1, T0 + 3600_000);
  assert.equal(p.activeDays, 1);
  accrue(p, 1, T0 + 86_400_000);
  assert.equal(p.activeDays, 2);
});

test("accrueAll: credits every player, catches up downtime, respects joinHeight", () => {
  const st = { lastAccruedHeight: 1000, height: 1000, players: { a: fresh(), b: fresh({ wheelTier: 2 }), late: fresh({ joinHeight: 1400 }) } };
  // server was down for 500 blocks
  S.accrueAll(st, 1500, T0);
  assert.equal(st.lastAccruedHeight, 1500);
  assert.equal(st.players.a.watts, W0 + 5000);
  assert.equal(st.players.b.watts, W0 + 8000);
  assert.equal(st.players.late.watts, W0 + 1000); // only blocks after it joined
  // no double counting
  S.accrueAll(st, 1500, T0);
  S.accrueAll(st, 1490, T0);
  assert.equal(st.players.a.watts, W0 + 5000);
});

// ---------- balance targets ----------
test("balance: 1078 blocks at tier 0 = 10780 W", () => {
  const p = fresh();
  assert.equal(accrue(p, 1078, T0), 10_780);
});

test("balance: tier-1 wheel affordable within 1.5 simulated days at tier 0", () => {
  const p = fresh();
  const blocksPerDay = 1034; // low end of the observed rhythm
  let blocks = 0;
  // credit one block at a time (worst case for rounding), no heartbeat
  while (!canBuy(p, "wheel_t1").ok) {
    accrue(p, 1, T0);
    blocks++;
  }
  assert.ok(blocks / blocksPerDay <= 1.5, `took ${blocks} blocks`);
});

// ---------- buy rules ----------
test("buy: unknown item", () => {
  assert.deepEqual(canBuy(fresh(), "nope"), { ok: false, error: "unknown_item" });
  assert.equal(canBuy(fresh(), "__proto__").error, "unknown_item");
  assert.equal(canBuy(fresh(), 42).error, "unknown_item");
});

test("buy: poor returns need", () => {
  const r = canBuy(fresh(), "fur_cactus"); // 1500 > 800
  assert.equal(r.ok, false);
  assert.equal(r.error, "poor");
  assert.equal(r.need, 700);
});

test("buy: deducts server-side price, placeables stack", () => {
  const p = fresh({ watts: 2000 });
  assert.ok(S.applyBuy(p, "fur_seed_bowl").ok);
  assert.ok(S.applyBuy(p, "fur_seed_bowl").ok);
  assert.equal(p.watts, 800);
  assert.equal(p.owned.fur_seed_bowl, 2);
});

test("buy: wheel tiers strictly in order", () => {
  const p = fresh({ watts: 1_000_000 });
  assert.equal(canBuy(p, "wheel_t2").error, "wrong_tier");
  assert.equal(canBuy(p, "wheel_t5").error, "wrong_tier");
  assert.ok(S.applyBuy(p, "wheel_t1").ok);
  assert.equal(p.wheelTier, 1);
  assert.equal(canBuy(p, "wheel_t1").error, "already_owned");
  assert.ok(S.applyBuy(p, "wheel_t2").ok);
  assert.equal(p.wheelTier, 2);
  assert.equal(p.watts, 1_000_000 - 5000 - 18000);
  assert.equal(canBuy(p, "wheel_t4").error, "wrong_tier");
});

test("buy: skins, wallpapers, floors are single-copy; defaults already owned", () => {
  const p = fresh({ watts: 100_000 });
  assert.ok(S.applyBuy(p, "skin_albino").ok);
  assert.equal(canBuy(p, "skin_albino").error, "already_owned");
  assert.ok(S.applyBuy(p, "wp_polka").ok);
  assert.equal(canBuy(p, "wp_polka").error, "already_owned");
  assert.ok(S.applyBuy(p, "fl_checker").ok);
  assert.equal(canBuy(p, "fl_checker").error, "already_owned");
  for (const id of ["skin_classic", "wp_dirt", "wp_plain", "fl_straw", "fl_pine"]) assert.equal(canBuy(p, id).error, "already_owned");
  assert.equal(p.watts, 100_000 - 10_000 - 1200 - 1200);
});

// ---------- placement ----------
const R = S.ROOM;
test("placement: floor furniture in bounds, y normalised to the floor row", () => {
  const p = own(fresh(), "fur_sofa"); // 3 wide
  const v = validatePlacement(p, "fur_sofa", 7, 3);
  assert.equal(v.ok, true);
  assert.equal(v.y, R.FLOOR_ROW);
  assert.equal(validatePlacement(p, "fur_sofa", -1, 11).error, "out_of_bounds");
  assert.equal(validatePlacement(p, "fur_sofa", 18, 11).error, "out_of_bounds");
  assert.equal(validatePlacement(p, "fur_sofa", 7, 12).error, "out_of_bounds");
  assert.ok(validatePlacement(own(fresh(), "fur_seed_bowl"), "fur_seed_bowl", 19, 11).ok);
});

test("placement: non-integer coords rejected", () => {
  const p = own(fresh(), "fur_seed_bowl");
  for (const [x, y] of [[1.5, 11], ["1", 11], [1, null], [NaN, 11], [1, Infinity]]) {
    assert.equal(validatePlacement(p, "fur_seed_bowl", x, y).error, "bad_coords", `${x},${y}`);
  }
});

test("placement: reserved burrow (16-18) columns; the wheel's old columns are free", () => {
  const p = own(fresh(), "fur_bookshelf", 1); // 2 wide
  for (const x of [15, 16, 17, 18]) assert.equal(validatePlacement(p, "fur_bookshelf", x, 11).error, "reserved", `x=${x}`);
  for (const x of [2, 3, 4, 5, 6]) assert.ok(validatePlacement(p, "fur_bookshelf", x, 11).ok, `x=${x}`);
  assert.ok(validatePlacement(p, "fur_bookshelf", 0, 11).ok);
  assert.ok(validatePlacement(p, "fur_bookshelf", 7, 11).ok);
  assert.ok(validatePlacement(p, "fur_bookshelf", 14, 11).ok);
});

test("placement: floor overlap is 1-D over columns", () => {
  const p = own(own(fresh(), "fur_sofa"), "fur_seed_bowl", 2);
  p.placed.push({ pid: "s1", item: "fur_sofa", x: 8, y: 11, flip: false }); // cols 8..10
  assert.equal(validatePlacement(p, "fur_seed_bowl", 8, 11).error, "overlap");
  assert.equal(validatePlacement(p, "fur_seed_bowl", 10, 11).error, "overlap");
  assert.ok(validatePlacement(p, "fur_seed_bowl", 7, 11).ok);
  assert.ok(validatePlacement(p, "fur_seed_bowl", 11, 11).ok);
  // moving the sofa onto itself (shifted by one) is fine
  assert.ok(validatePlacement(p, "fur_sofa", 9, 11, "s1").ok);
});

test("placement: wall zone is 2-D on rows 2-7 and ignores the floor", () => {
  const p = own(own(fresh(), "wall_window", 2), "wall_pennant", 2); // window 2x2
  assert.ok(validatePlacement(p, "wall_window", 3, 2).ok); // reserved cols only apply to the floor
  assert.equal(validatePlacement(p, "wall_window", 3, 1).error, "out_of_bounds");
  assert.equal(validatePlacement(p, "wall_window", 3, 7).error, "out_of_bounds"); // would cover row 8
  assert.ok(validatePlacement(p, "wall_window", 3, 6).ok);
  assert.equal(validatePlacement(p, "wall_window", 19, 3).error, "out_of_bounds");
  p.placed.push({ pid: "w1", item: "wall_window", x: 5, y: 3, flip: false }); // cols 5-6, rows 3-4
  assert.equal(validatePlacement(p, "wall_pennant", 6, 4).error, "overlap");
  assert.ok(validatePlacement(p, "wall_pennant", 6, 5).ok);
  assert.ok(validatePlacement(p, "wall_pennant", 7, 3).ok);
  // a floor item in the same columns does not collide with wall decor
  own(p, "fur_seed_bowl");
  assert.ok(validatePlacement(p, "fur_seed_bowl", 9, 11).ok);
});

test("placement: rugs collide only with rugs, never on reserved columns", () => {
  const p = own(own(own(fresh(), "rug_persian"), "rug_rag"), "fur_sofa");
  p.placed.push({ pid: "f1", item: "fur_sofa", x: 8, y: 11, flip: false });
  assert.ok(validatePlacement(p, "rug_persian", 8, 11).ok); // under furniture is fine
  p.placed.push({ pid: "r1", item: "rug_persian", x: 8, y: 11, flip: false }); // cols 8..11
  assert.equal(validatePlacement(p, "rug_rag", 11, 11).error, "overlap");
  assert.ok(validatePlacement(p, "rug_rag", 12, 11).ok);
  assert.ok(validatePlacement(p, "rug_rag", 5, 11).ok);
  assert.equal(validatePlacement(p, "rug_rag", 15, 11).error, "reserved");
});

test("placement: unowned, unknown and non-placeable items", () => {
  const p = fresh();
  assert.equal(validatePlacement(p, "fur_seed_bowl", 0, 11).error, "unowned");
  own(p, "fur_seed_bowl", 1);
  p.placed.push({ pid: "b1", item: "fur_seed_bowl", x: 0, y: 11, flip: false });
  assert.equal(validatePlacement(p, "fur_seed_bowl", 1, 11).error, "unowned"); // only one copy
  assert.ok(validatePlacement(p, "fur_seed_bowl", 1, 11, "b1").ok); // but it can move
  assert.equal(validatePlacement(p, "nope", 0, 11).error, "unknown_item");
  assert.equal(validatePlacement(p, "skin_classic", 0, 11).error, "not_placeable");
  assert.equal(validatePlacement(p, "wheel_t1", 0, 11).error, "not_placeable");
});

// ---------- heartbeat ----------
test("heartbeat: 20 s minimum interval, early calls do not stamp", () => {
  const p = fresh();
  const a = S.heartbeat(p, T0);
  assert.equal(a.stamped, true);
  assert.equal(a.bonusPct, 120);
  assert.equal(p.lastHeartbeat, T0);
  const early = S.heartbeat(p, T0 + 5000);
  assert.equal(early.stamped, false);
  assert.equal(early.nextMs, 15_000);
  assert.equal(early.watching, true);
  assert.equal(p.lastHeartbeat, T0);
  const later = S.heartbeat(p, T0 + 20_000);
  assert.equal(later.stamped, true);
  assert.equal(p.lastHeartbeat, T0 + 20_000);
  // spamming cannot extend the window: bonus expires 90 s after the last real stamp
  for (let t = 1; t < 20; t++) S.heartbeat(p, T0 + 20_000 + t * 1000);
  assert.equal(S.liveBonusPct(p, T0 + 20_000 + 90_001), 100);
});

// ---------- commemorative ----------
test("cert eligibility thresholds", () => {
  assert.equal(certEligible(fresh({ lifetimeWatts: 249_999, activeDays: 30 })), false);
  assert.equal(certEligible(fresh({ lifetimeWatts: 1_000_000, activeDays: 6 })), false);
  assert.equal(certEligible(fresh({ lifetimeWatts: 250_000, activeDays: 7 })), true);
});

test("claim: rejects ineligible, issues serial + seed, idempotent", () => {
  const crypto = require("node:crypto");
  const st = { height: 9000, certSerial: 0, players: { [TOKEN]: fresh({ lifetimeWatts: 1000, activeDays: 1, nick: "squeaky" }) } };
  const no = S.claimCommemorative(st, TOKEN, T0);
  assert.equal(no.ok, false);
  assert.equal(no.error, "not_eligible");
  assert.equal(st.certSerial, 0);
  assert.equal(S.claimCommemorative(st, "b".repeat(32), T0).error, "unknown_player");

  const p = st.players[TOKEN];
  Object.assign(p, { lifetimeWatts: 300_000, activeDays: 9, wheelTier: 3 });
  own(p, "fur_sofa");
  p.placed.push({ pid: "x", item: "fur_sofa", x: 8, y: 11, flip: true });
  const r = S.claimCommemorative(st, TOKEN, T0);
  assert.equal(r.ok, true);
  const c = r.cert;
  assert.equal(c.serial, 1);
  assert.equal(st.certSerial, 1);
  assert.equal(c.seed, crypto.createHash("sha256").update(TOKEN + "9000" + "1").digest("hex"));
  assert.equal(c.tokenFingerprint, crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 12));
  assert.equal(c.tokenFingerprint.length, 12);
  for (const k of ["version", "type", "serial", "seed", "tokenFingerprint", "nick", "claimedAt", "joinHeight", "claimHeight", "lifetimeWatts", "activeDays", "wheelTier", "skin", "itemsOwned", "room"]) assert.ok(k in c, k);
  assert.equal(c.nick, "squeaky");
  assert.equal(c.claimHeight, 9000);
  assert.deepEqual(c.room, { wallpaper: "wp_dirt", floor: "fl_straw", placed: [{ item: "fur_sofa", x: 8, y: 11, flip: true }] });
  assert.ok(!JSON.stringify(c).includes(TOKEN), "cert must not leak the token");

  // re-claim later: same cert, no new serial
  st.height = 9500;
  const again = S.claimCommemorative(st, TOKEN, T0 + 86_400_000);
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.deepEqual(again.cert, c);
  assert.equal(st.certSerial, 1);
});

// ---------- sleep (by the chain) ----------
test("chainIdle: asleep after IDLE_AFTER_MS without a settled block; stale reads are not asleep", () => {
  const { chainIdle } = S;
  assert.equal(BALANCE.IDLE_AFTER_MS, 600_000);
  for (const k of Object.keys(BALANCE)) assert.ok(!k.startsWith("MANUAL_"), `wheel duty key ${k} is gone`);
  assert.equal(chainIdle(T0 - 60_000, T0), false); // a block 1 min ago
  assert.equal(chainIdle(null, T0), false); // height never observed
  assert.equal(chainIdle(T0 - BALANCE.IDLE_AFTER_MS + 1, T0), false);
  assert.equal(chainIdle(T0 - BALANCE.IDLE_AFTER_MS, T0), true); // exactly 10 min quiet
  const asleep = T0 - BALANCE.IDLE_AFTER_MS - 60_000;
  assert.equal(chainIdle(asleep, T0, T0 - 10_000), true); // live mode, fresh chain read
  assert.equal(chainIdle(asleep, T0, T0 - 600_000), false); // live mode, stale read
  assert.equal(chainIdle(asleep, T0, 0), false);
  assert.equal(chainIdle(asleep, T0, null), true); // demo mode: no freshness check
});

// ---------- bed income ----------
test("bed: balance constants", () => {
  assert.equal(BALANCE.BED_RATE_PER_MIN, 1.5);
  assert.deepEqual(BALANCE.BED_MULT_PCT, [100, 125, 160, 200, 260, 350]);
  assert.equal(BALANCE.BED_TICK_MAX_MS, 60_000);
  assert.equal(S.bedWattsPerMin(fresh()), 1.5);
  assert.equal(S.bedWattsPerMin(fresh({ bedTier: 5 })), 5.25);
  assert.equal(S.bedMultPct(fresh({ bedTier: 3 })), 200);
});

test("bed: 1.5 W/min x bed multiplier x watching bonus", () => {
  const ten = 10 * 60_000;
  assert.equal(S.bedCredit(fresh(), ten, T0), 15);
  for (const [tier, per10] of [[1, 18], [2, 24], [3, 30], [4, 39], [5, 52]]) {
    const p = fresh({ bedTier: tier });
    assert.equal(S.bedCredit(p, ten, T0), per10, `tier ${tier}`); // 18.75 and 52.5 floor, the rest carries
    assert.equal(p.lifetimeWatts, per10);
  }
  const w = fresh({ lastHeartbeat: T0 - 30_000 }); // watching: 1.2x
  assert.equal(S.bedCredit(w, ten, T0), 18);
  const w5 = fresh({ bedTier: 5, lastHeartbeat: T0 });
  assert.equal(S.bedCredit(w5, ten, T0), 63); // 1.5 x 3.5 x 1.2 x 10
  assert.equal(S.bedCredit(fresh(), 0, T0), 0);
  assert.equal(S.bedCredit(fresh(), -5, T0), 0);
});

test("bed: fractional carry is exact (integers only, nothing lost)", () => {
  const p = fresh();
  assert.equal(S.bedCredit(p, 60_000, T0), 1); // 1.5 W -> 1 now, 0.5 carried
  assert.equal(p.bedFrac, S.BED_FRAC_DEN / 2);
  assert.equal(S.bedCredit(p, 60_000, T0), 2); // 0.5 + 1.5
  assert.equal(p.bedFrac, 0);
  assert.equal(p.watts, W0 + 3);
  assert.equal(p.activeDays, 1);
  for (let tier = 0; tier <= 5; tier++) {
    const q = fresh({ bedTier: tier, lastHeartbeat: tier % 2 ? T0 : 0 });
    let ms = 0;
    for (let i = 0; i < 500; i++) {
      const step = 1000 + ((i * 7919) % 59_001); // 1..60 s, irregular
      ms += step;
      S.bedCredit(q, step, T0);
      assert.ok(Number.isInteger(q.watts) && Number.isInteger(q.lifetimeWatts), `tier ${tier}`);
    }
    const bonus = tier % 2 ? 120 : 100;
    const exact = (ms * 15 * BALANCE.BED_MULT_PCT[tier] * bonus) / S.BED_FRAC_DEN;
    assert.equal(q.lifetimeWatts, Math.floor(exact), `tier ${tier}`);
    assert.equal(q.watts, W0 + q.lifetimeWatts);
  }
});

test("accrueBed: every player while asleep, 60 s cap per tick, nothing while awake", () => {
  const st = { lastBedTickAt: null, players: { a: fresh(), b: fresh({ bedTier: 3 }), live: fresh({ lastHeartbeat: T0 }) } };
  assert.equal(S.accrueBed(st, true, T0), 0); // first tick only starts the clock
  assert.equal(st.lastBedTickAt, T0);
  S.accrueBed(st, true, T0 + 60_000);
  assert.equal(st.players.a.lifetimeWatts, 1); // 1.5
  assert.equal(st.players.b.lifetimeWatts, 3); // 1.5 x 2
  assert.equal(st.players.live.lifetimeWatts, 1); // 1.8
  // a 10-minute gap credits only 60 s
  S.accrueBed(st, true, T0 + 11 * 60_000);
  assert.equal(st.players.b.lifetimeWatts, 6);
  assert.equal(st.lastBedTickAt, T0 + 11 * 60_000);
  // awake: no watts, but the clock moves (the awake stretch is never paid later)
  assert.equal(S.accrueBed(st, false, T0 + 20 * 60_000), 0);
  assert.equal(st.players.b.lifetimeWatts, 6);
  S.accrueBed(st, true, T0 + 20 * 60_000 + 30_000); // asleep again: only the last 30 s count
  assert.equal(st.players.b.lifetimeWatts, 7); // + 1.5
  // a clock that steps backwards credits nothing
  const before = st.players.b.lifetimeWatts;
  assert.equal(S.accrueBed(st, true, T0), 0);
  assert.equal(st.players.b.lifetimeWatts, before);
});

// ---------- bed + room ladders ----------
test("catalog: bed and room ladders (tiers 1..5, not placeable); teacup bed stays a cosmetic", () => {
  const beds = CATALOG.filter((i) => i.cat === "bed");
  assert.deepEqual(beds.map((b) => b.id), ["bed_t1", "bed_t2", "bed_t3", "bed_t4", "bed_t5"]);
  assert.deepEqual(beds.map((b) => b.price), [3000, 10000, 30000, 80000, 200000]);
  assert.deepEqual(beds.map((b) => b.multPct), [125, 160, 200, 260, 350]);
  const rooms = CATALOG.filter((i) => i.cat === "room");
  assert.deepEqual(rooms.map((r) => r.tier), [1, 2, 3, 4, 5]);
  assert.deepEqual(rooms.map((r) => r.price), [10000, 30000, 80000, 200000, 450000]);
  assert.deepEqual(rooms.map((r) => r.material), ["Stone", "Iron", "Silver", "Gold", "Diamond"]);
  for (const i of [...beds, ...rooms]) assert.equal(i.zone, null);
  const teacup = S.CATALOG_BY_ID.get("fur_teacup_bed");
  assert.equal(teacup.cat, "furniture");
  assert.equal(teacup.price, 3500);
});

test("buy: bed tiers strictly in order, set bedTier, single copy", () => {
  const p = fresh({ watts: 1_000_000 });
  assert.equal(p.bedTier, 0);
  assert.equal(canBuy(p, "bed_t2").error, "wrong_tier");
  assert.equal(canBuy(p, "bed_t5").error, "wrong_tier");
  assert.ok(S.applyBuy(p, "bed_t1").ok);
  assert.equal(p.bedTier, 1);
  assert.equal(p.owned.bed_t1, 1);
  assert.equal(canBuy(p, "bed_t1").error, "already_owned");
  assert.ok(S.applyBuy(p, "bed_t2").ok);
  assert.equal(p.bedTier, 2);
  assert.equal(canBuy(p, "bed_t1").error, "already_owned");
  assert.equal(canBuy(p, "bed_t4").error, "wrong_tier");
  assert.equal(p.watts, 1_000_000 - 3000 - 10000);
  assert.equal(p.wheelTier, 0); // ladders are independent
  assert.equal(p.roomTier, 0);
  assert.equal(validatePlacement(p, "bed_t1", 0, 11).error, "not_placeable");
  const r = canBuy(fresh(), "bed_t1");
  assert.equal(r.error, "poor");
  assert.equal(r.need, 3000 - W0);
  // the new bed raises bed income right away
  assert.equal(S.bedCredit(p, 10 * 60_000, T0), 24);
});

test("buy: room material tiers strictly in order, set roomTier, single copy", () => {
  const p = fresh({ watts: 1_000_000 });
  assert.equal(p.roomTier, 0);
  assert.equal(canBuy(p, "room_t3").error, "wrong_tier");
  assert.ok(S.applyBuy(p, "room_t1").ok);
  assert.equal(p.roomTier, 1);
  assert.equal(canBuy(p, "room_t1").error, "already_owned");
  assert.equal(canBuy(p, "room_t3").error, "wrong_tier");
  assert.ok(S.applyBuy(p, "room_t2").ok);
  assert.equal(p.roomTier, 2);
  assert.equal(p.watts, 1_000_000 - 10000 - 30000);
  assert.equal(p.bedTier, 0);
  assert.equal(p.wheelTier, 0);
  assert.equal(validatePlacement(p, "room_t1", 0, 11).error, "not_placeable");
});

// ---------- player records ----------
test("new player: publicId from the token, bed + room tiers at 0, no wheel-duty fields", () => {
  const crypto = require("node:crypto");
  const p = S.newPlayer(1000, T0, TOKEN);
  assert.equal(p.publicId, crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 12));
  assert.equal(S.publicIdFor(TOKEN), p.publicId);
  assert.equal(p.bedTier, 0);
  assert.equal(p.roomTier, 0);
  assert.equal(p.bedFrac, 0);
  for (const k of ["lastSpinAt", "manualDay", "manualMsToday", "manualFrac"]) assert.ok(!(k in p), k);
  const pub = S.publicPlayer(Object.assign(p, { bedTier: 2, roomTier: 4 }), T0);
  assert.equal(pub.publicId, p.publicId);
  assert.equal(pub.bedTier, 2);
  assert.equal(pub.bedMultPct, 160);
  assert.equal(pub.bedWattsPerMin, 2.4);
  assert.equal(pub.roomTier, 4);
  assert.ok(!("manual" in pub));
  assert.ok(!JSON.stringify(pub).includes(TOKEN), "public view must not leak the token");
});

test("load patch: old records get publicId + bed/room defaults, wheel-duty fields dropped", () => {
  const crypto = require("node:crypto");
  const old = fresh({ wheelTier: 2, watts: 9000, lastSpinAt: T0, manualDay: "2026-10-30", manualMsToday: 5000, manualFrac: 12 });
  for (const k of ["publicId", "bedTier", "roomTier", "bedFrac"]) delete old[k];
  const keep = fresh({ publicId: "already12chr", bedTier: 3, roomTier: 1, bedFrac: 77 });
  const st = { height: 5000, lastAdvanceAt: T0 - 1000, lastBedTickAt: T0 - 5000, players: { [TOKEN]: old, ["b".repeat(32)]: keep } };
  S.patchState(st, T0);
  assert.equal(old.publicId, crypto.createHash("sha256").update(TOKEN).digest("hex").slice(0, 12));
  assert.equal(old.bedTier, 0);
  assert.equal(old.roomTier, 0);
  assert.equal(old.bedFrac, 0);
  assert.equal(old.wheelTier, 2);
  assert.equal(old.watts, 9000);
  for (const k of ["lastSpinAt", "manualDay", "manualMsToday", "manualFrac"]) assert.ok(!(k in old), k);
  assert.deepEqual([keep.publicId, keep.bedTier, keep.roomTier, keep.bedFrac], ["already12chr", 3, 1, 77]); // never overwritten
  assert.equal(st.lastBedTickAt, null); // no bed catch-up for downtime
  assert.equal(st.lastAccruedHeight, 5000);
  // an empty / ancient state file still comes out usable
  const bare = S.patchState({ height: 10 }, T0);
  assert.deepEqual(bare.players, {});
  assert.equal(bare.lastAdvanceAt, T0);
});

// ---------- config vs. polled state ----------
test("config carries the static rules; the polled snapshot carries only dynamic data", () => {
  const cfg = S.configPayload();
  assert.deepEqual(cfg.catalog, CATALOG);
  assert.deepEqual(cfg.balance, BALANCE);
  assert.deepEqual(cfg.room, S.ROOM);
  for (const k of ["demo", "core", "api"]) assert.ok(k in cfg, k);
  assert.ok(cfg.catalog.some((i) => i.id === "bed_t1") && cfg.catalog.some((i) => i.id === "room_t1"));
  const snap = S.snapshot();
  for (const k of ["catalog", "balance", "room", "spin", "core", "api"]) assert.ok(!(k in snap), `snapshot has ${k}`);
  assert.equal(typeof snap.idle, "boolean");
  for (const k of ["height", "chain", "hamster", "serverTime", "players", "me"]) assert.ok(k in snap, k);
  assert.equal(snap.me, null); // no token: no player created
  assert.ok(JSON.stringify(snap).length < JSON.stringify(cfg).length / 4, "the poll stays small");
});

// ---------- raids ----------
const RA = BALANCE.RAID;
const TA = "a".repeat(32), TB = "b".repeat(32), TC = "c".repeat(32);
const pidOf = (t) => S.publicIdFor(t);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ""} ${a} vs ${b}`);
// Scripted rng: returns the given rolls in order and fails the test if a roll is read beyond them.
const seq = (...xs) => {
  let i = 0;
  const f = () => {
    if (i >= xs.length) throw new Error("rng read past the scripted rolls");
    return xs[i++];
  };
  f.used = () => i;
  return f;
};
const WIN = 0, LOSE = 0.999; // first roll vs p (p is always within [0.02, 0.90])
// Seeded PRNG (mulberry32) for the fuzz test.
const prng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Three rooms while he runs: atk and def at 10k, poor at 1k.
function raidWorld(over = {}) {
  const st = { lastAdvanceAt: T0 - 60_000, burned: 0, raidFeed: [], players: {} };
  for (const [t, nick, watts] of [[TA, "atk", 10_000], [TB, "def", 10_000], [TC, "poor", 1_000]]) {
    st.players[t] = Object.assign(S.newPlayer(1000, T0, t), { nick, watts }, over[nick] || {});
  }
  return st;
}
const supply = (st) => Object.values(st.players).reduce((s, p) => s + p.watts, 0) + st.burned;
const raid = (st, token, target, stake, mult, now = T0, rng = seq(LOSE)) => S.applyRaid(st, token, { target: pidOf(target), stake, mult }, now, { rng });

test("raid: balance knobs", () => {
  assert.equal(RA.EDGE_PCT, 110);
  assert.deepEqual(RA.MULT_PCT, [150, 200, 300, 500, 1000]);
  assert.deepEqual(RA.DEFENSE_PCT, [0, 5, 10, 15, 20, 25]);
  assert.deepEqual([RA.TILT_EXP, RA.TILT_MIN_PCT, RA.TILT_MAX_PCT, RA.P_MIN_PCT, RA.P_MAX_PCT], [0.25, 75, 150, 2, 90]);
  assert.deepEqual([RA.LOOT_U_MIN_PCT, RA.LOOT_U_MAX_PCT, RA.CRIT_CHANCE_PCT, RA.CRIT_MULT_PCT], [75, 125, 5, 150]);
  assert.deepEqual([RA.STAKE_MIN, RA.LOOT_MAX_DEF_PCT, RA.ELIGIBLE_MIN_PCT], [50, 25, 70]);
  assert.equal(RA.STAKE_MAX, undefined); // no stake cap
  assert.equal(RA.PER_DAY, 10);
  assert.equal(RA.REVENGE_WINDOW_MS, 24 * 3600_000);
});

test("raidChance: base 1.10/M at equal wealth in a wood room", () => {
  const a = fresh({ watts: 10_000 }), d = fresh({ watts: 10_000 });
  for (const m of RA.MULT_PCT) near(S.raidChance(a, d, m), 110 / m, `M=${m}`);
  near(S.raidChance(a, d, 150), 0.7333333333333333);
  near(S.raidChance(a, d, 1000), 0.11);
  assert.equal(S.raidChance(a, d, 400), 0); // not an offered multiplier
});

test("raidChance: defense ladder by the defender's room tier", () => {
  const a = fresh({ watts: 10_000, roomTier: 5 }); // the attacker's own room does not matter
  for (let tier = 0; tier <= 5; tier++) {
    const d = fresh({ watts: 10_000, roomTier: tier });
    near(S.raidChance(a, d, 200), 0.55 * (1 - [0, 0.05, 0.1, 0.15, 0.2, 0.25][tier]), `tier ${tier}`);
  }
});

test("raidChance: wealth tilt (def/atk)^0.25, capped to [0.75, 1.5]", () => {
  near(S.wealthTilt(1000, 1000), 1);
  near(S.wealthTilt(1000, 2000), Math.pow(2, 0.25));
  near(S.wealthTilt(2000, 1000), Math.pow(0.5, 0.25));
  assert.equal(S.wealthTilt(1000, 16_000), 1.5); // 16^.25 = 2 -> cap
  assert.equal(S.wealthTilt(1000, 1e12), 1.5);
  assert.equal(S.wealthTilt(16_000, 1000), 0.75); // 0.5 -> floor
  assert.equal(S.wealthTilt(1e12, 1), 0.75);
  assert.equal(S.wealthTilt(0, 500), 1.5); // broke attacker: Infinity -> cap
  assert.equal(S.wealthTilt(500, 0), 0.75);
  assert.equal(S.wealthTilt(0, 0), 1);
  // through raidChance: a 10x punch-up at M=10 in a wood room = 0.11 x 1.5
  near(S.raidChance(fresh({ watts: 1000 }), fresh({ watts: 10_000 }), 1000), 0.165);
});

test("raidChance: clamped to [0.02, 0.90]", () => {
  assert.equal(S.raidOdds(150, 0, 1.5), 0.9); // 1.1 raw
  assert.equal(S.raidOdds(150, 0, 1.25), 0.9); // 0.9167 raw
  near(S.raidOdds(150, 0, 1.2), 0.88);
  assert.equal(S.raidOdds(1000, 90, 0.75), 0.02); // 0.00825 raw
  assert.equal(S.raidChance(fresh({ watts: 100 }), fresh({ watts: 1e9 }), 150), 0.9);
  // with the shipped knobs the floor is never reached: min p = 0.11 x 0.75 x 0.75
  const worst = S.raidChance(fresh({ watts: 1e9 }), fresh({ watts: 1, roomTier: 5 }), 1000);
  near(worst, 0.11 * 0.75 * 0.75);
  assert.ok(worst > 0.02);
});

test("raid EV identity: p x M is the same for every multiplier (M only dials variance)", () => {
  for (const dPct of RA.DEFENSE_PCT) {
    for (const tilt of [0.75, 0.9, 1, 1.1, 1.2]) {
      const expect = 1.1 * (1 - dPct / 100) * tilt;
      for (const m of RA.MULT_PCT) near(S.raidOdds(m, dPct, tilt) * (m / 100), expect, `d=${dPct} T=${tilt} M=${m}`);
    }
  }
  // same through real players (a mild punch-up, iron room)
  const a = fresh({ watts: 10_000 }), d = fresh({ watts: 12_000, roomTier: 2 });
  const evs = RA.MULT_PCT.map((m) => S.raidChance(a, d, m) * (m / 100));
  for (const ev of evs) near(ev, evs[0]);
  near(evs[0], 1.1 * 0.9 * Math.pow(1.2, 0.25));
});

test("resolveRaid: a loss uses one roll and loses the whole stake", () => {
  const a = fresh({ watts: 10_000 }), d = fresh({ watts: 10_000 });
  const rng = seq(LOSE);
  const r = S.resolveRaid(a, d, 1000, 300, rng);
  assert.deepEqual(r, { win: false, p: S.raidChance(a, d, 300), stakeLost: 1000 });
  assert.equal(rng.used(), 1);
  // a roll exactly at p loses (a win needs roll < p)
  const p = S.raidChance(a, d, 200);
  assert.equal(S.resolveRaid(a, d, 100, 200, seq(p)).win, false);
  assert.equal(a.watts, 10_000); // pure: nothing mutated
});

test("resolveRaid: loot = floor((M-1) x S x U), U in [0.75, 1.25], rolls win -> U -> crit", () => {
  const a = fresh({ watts: 10_000 }), d = fresh({ watts: 100_000 });
  const rng = seq(WIN, 0.5, 0.99);
  const r = S.resolveRaid(a, d, 1000, 300, rng);
  assert.equal(rng.used(), 3);
  assert.deepEqual([r.win, r.loot, r.crit], [true, 2000, false]); // U = 1.00
  assert.equal(S.resolveRaid(a, d, 1000, 300, seq(WIN, 0, 0.99)).loot, 1500); // U = 0.75
  assert.equal(S.resolveRaid(a, d, 1000, 300, seq(WIN, 0.999999, 0.99)).loot, 2499); // U -> 1.25
  assert.equal(S.resolveRaid(a, d, 333, 150, seq(WIN, 0.5, 0.99)).loot, 166); // 166.5 floors
  for (let i = 0; i < 200; i++) {
    const u = i / 200;
    const loot = S.resolveRaid(a, d, 777, 500, seq(WIN, u, 0.99)).loot;
    assert.ok(Number.isInteger(loot) && loot >= Math.floor(4 * 777 * 0.75) && loot <= Math.floor(4 * 777 * 1.25), `u=${u} loot=${loot}`);
  }
  assert.equal(d.watts, 100_000);
});

test("resolveRaid: 5% crit x1.5, and loot never exceeds 25% of the defender's balance", () => {
  const a = fresh({ watts: 10_000 }), d = fresh({ watts: 100_000 });
  const c = S.resolveRaid(a, d, 1000, 300, seq(WIN, 0.5, 0.01));
  assert.deepEqual([c.loot, c.crit], [3000, true]);
  assert.equal(S.resolveRaid(a, d, 1000, 300, seq(WIN, 0.5, 0.0499)).crit, true);
  assert.equal(S.resolveRaid(a, d, 1000, 300, seq(WIN, 0.5, 0.05)).crit, false);
  const thin = fresh({ watts: 4800 }); // cap 1200
  assert.equal(S.lootCap(4800), 1200);
  assert.equal(S.resolveRaid(a, thin, 1000, 300, seq(WIN, 0.5, 0.99)).loot, 1200); // 2000 -> capped
  assert.equal(S.resolveRaid(a, thin, 1000, 200, seq(WIN, 0.5, 0.99)).loot, 1000); // under the cap
  const crit = S.resolveRaid(a, thin, 1000, 200, seq(WIN, 0.5, 0.01)); // 1500 -> capped
  assert.deepEqual([crit.loot, crit.crit], [1200, true]);
  // an all-in heist can't empty a room: at most a quarter of it
  const big = fresh({ watts: 1e6 });
  const heist = S.resolveRaid(a, big, 100_000, 1000, seq(WIN, 0.999999, 0.01));
  assert.equal(heist.loot, 250_000);
  assert.equal(S.resolveRaid(a, fresh({ watts: 0 }), 100, 1000, seq(WIN, 0.5, 0.01)).loot, 0);
});

test("applyRaid: a win moves the loot defender -> attacker; lifetime/activeDays untouched", () => {
  const st = raidWorld({ atk: { lifetimeWatts: 5000, activeDays: 3, lastActiveDay: "2026-10-29" }, def: { lifetimeWatts: 7000, activeDays: 4 } });
  const before = supply(st);
  const r = raid(st, TA, TB, 1000, 3, T0, seq(WIN, 0.5, 0.99));
  assert.equal(r.ok, true);
  assert.deepEqual([r.result.win, r.result.loot, r.result.crit, r.result.stake, r.result.multPct, r.result.revenge], [true, 2000, false, 1000, 300, false]);
  const [a, d] = [st.players[TA], st.players[TB]];
  assert.equal(a.watts, 12_000);
  assert.equal(d.watts, 8000);
  assert.deepEqual([a.lifetimeWatts, a.activeDays, a.lastActiveDay, d.lifetimeWatts, d.activeDays], [5000, 3, "2026-10-29", 7000, 4]);
  assert.equal(st.burned, 0);
  assert.equal(supply(st), before);
  assert.equal(a.lastRaidAt, T0);
  assert.deepEqual(d.raidedBy, [{ pid: a.publicId, at: T0, avenged: false }]);
  assert.deepEqual(r.feed, { at: T0, atk: "atk", atkId: a.publicId, def: "def", defId: d.publicId, win: true, amount: 2000, crit: false });
  assert.deepEqual(st.raidFeed, [r.feed]);
});

test("applyRaid: a loss burns the stake (the defender gets nothing)", () => {
  const st = raidWorld({ atk: { lifetimeWatts: 5000, activeDays: 3 } });
  const before = supply(st);
  const r = raid(st, TA, TB, 2000, 10, T0, seq(LOSE));
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { win: false, p: S.raidChance(fresh({ watts: 10_000 }), fresh({ watts: 10_000 }), 1000), stakeLost: 2000, stake: 2000, multPct: 1000, revenge: false, raidsLeft: RA.PER_DAY - 1 });
  assert.equal(st.players[TA].watts, 8000);
  assert.equal(st.players[TB].watts, 10_000);
  assert.equal(st.burned, 2000);
  assert.equal(supply(st), before);
  assert.deepEqual([st.players[TA].lifetimeWatts, st.players[TA].activeDays], [5000, 3]);
  assert.deepEqual([r.feed.win, r.feed.amount, r.feed.crit], [false, 2000, false]);
  assert.equal(st.players[TB].raidedBy.length, 1); // a failed raid still counts as a provocation
  // a state object without the raid fields still works (burned/raidFeed start lazily)
  const bare = raidWorld();
  delete bare.burned;
  delete bare.raidFeed;
  assert.ok(raid(bare, TA, TB, 100, 2).ok);
  assert.equal(bare.burned, 100);
  assert.equal(bare.raidFeed.length, 1);
});

test("applyRaid fuzz: watts + burned conserved, integers only, lifetime never moves", () => {
  const rng = prng(42);
  const tokens = Array.from({ length: 8 }, (_, i) => String.fromCharCode(97 + i).repeat(20) + "x".repeat(12));
  const st = { lastAdvanceAt: T0 - 60_000, burned: 0, raidFeed: [], players: {} };
  for (const [i, t] of tokens.entries()) st.players[t] = Object.assign(S.newPlayer(1000, T0, t), { watts: 2000 + i * 3000, lifetimeWatts: 100 * i, activeDays: i, roomTier: i % 6 });
  const supply0 = supply(st);
  const life = tokens.map((t) => st.players[t].lifetimeWatts);
  let wins = 0, losses = 0;
  for (let n = 0; n < 2000; n++) {
    const atk = tokens[Math.floor(rng() * tokens.length)];
    const def = tokens[Math.floor(rng() * tokens.length)];
    st.players[atk].raidsToday = 0; // skip the daily allowance for the fuzz
    const { max } = S.stakeBounds(st.players[atk].watts);
    const stake = 50 + Math.floor(rng() * Math.max(1, max / 5 - 49)); // mostly modest stakes keep the rooms solvent
    const mult = RA.MULT_PCT[Math.floor(rng() * 5)];
    const r = S.applyRaid(st, atk, { target: pidOf(def), stake, mult }, T0, { rng });
    if (r.ok) r.result.win ? wins++ : losses++;
    assert.equal(supply(st), supply0, `raid ${n}`);
    for (const t of tokens) assert.ok(Number.isInteger(st.players[t].watts) && st.players[t].watts >= 0, `raid ${n}`);
  }
  assert.ok(wins > 50 && losses > 50, `wins ${wins} losses ${losses}`);
  assert.ok(Number.isInteger(st.burned) && st.burned > 0);
  assert.deepEqual(tokens.map((t) => st.players[t].lifetimeWatts), life);
  assert.equal(st.raidFeed.length, RA.FEED_MAX);
});

test("raid stake bounds: any integer from 50 up to your whole balance", () => {
  assert.deepEqual(S.stakeBounds(10_000), { min: 50, max: 10_000 });
  assert.deepEqual(S.stakeBounds(10_004.7), { min: 50, max: 10_004 }); // floor
  assert.deepEqual(S.stakeBounds(1e9), { min: 50, max: 1e9 });
  assert.deepEqual(S.stakeBounds(49), { min: 50, max: 49 }); // too poor to raid
  const st = raidWorld();
  for (const s of [49, 0, -100, 10_001]) {
    const r = raid(st, TA, TB, s, 2);
    assert.deepEqual([r.ok, r.error, r.min, r.max], [false, "stake_out_of_range", 50, 10_000], `stake ${s}`);
  }
  for (const s of [100.5, "100", null, undefined, NaN, Infinity]) assert.equal(raid(st, TA, TB, s, 2).error, "bad_stake", `stake ${s}`);
  assert.equal(st.players[TA].watts, 10_000); // nothing moved on a refusal
  assert.equal(st.players[TA].raidsToday, 0);
  assert.ok(raid(st, TA, TB, 10_000, 2).ok); // all in
  assert.equal(st.players[TA].watts, 0);
  const broke = raidWorld({ atk: { watts: 40 }, def: { watts: 200 } });
  assert.equal(raid(broke, TA, TB, 50, 2).error, "stake_out_of_range");
});

test("raid multiplier: 1.5/2/3/5/10 or their percentages, nothing else", () => {
  for (const [v, pct] of [[1.5, 150], [2, 200], [3, 300], [5, 500], [10, 1000], [150, 150], [1000, 1000]]) assert.equal(S.parseMultPct(v), pct, `${v}`);
  for (const v of [1, 4, 1.25, 100, 2.0001, "2", null, NaN, Infinity, -2]) assert.equal(S.parseMultPct(v), null, `${v}`);
  const st = raidWorld();
  assert.equal(raid(st, TA, TB, 100, 4).error, "bad_mult");
  assert.equal(raid(st, TA, TB, 100, "3").error, "bad_mult");
  assert.equal(raid(st, TA, TB, 100, 1.5).result.multPct, 150);
});

test("raid allowance: 10 per attacker per UTC day, being raided is unlimited", () => {
  const st = raidWorld({ def: { watts: 1e9 } });
  const day = Date.UTC(2026, 9, 31, 10, 0, 0);
  const at = (t) => ((st.lastAdvanceAt = t - 1000), t); // keep him running
  for (let n = 0; n < RA.PER_DAY; n++) assert.ok(raid(st, TA, TB, 100, 2, at(day + n)).ok, `raid ${n}`);
  const r = raid(st, TA, TB, 100, 2, at(day + 20));
  assert.deepEqual([r.ok, r.error, r.resetMs], [false, "no_raids_left", 14 * 3600_000 - 20]);
  assert.deepEqual(S.raidStatus(st, st.players[TA], day + 60_000), { open: true, raidsLeft: 0, perDay: RA.PER_DAY, resetMs: 14 * 3600_000 - 60_000 });
  // others can still raid the same room
  st.players[TC].watts = 1e9;
  for (let n = 0; n < 3; n++) assert.ok(raid(st, TC, TB, 100, 2, at(day + 100 + n)).ok);
  // the count resets at 00:00 UTC
  const next = Date.UTC(2026, 10, 1, 0, 0, 0);
  assert.equal(S.raidsLeft(st.players[TA], next - 1), 0);
  assert.equal(S.raidsLeft(st.players[TA], next), RA.PER_DAY);
  const ok = raid(st, TA, TB, 100, 2, at(next));
  assert.ok(ok.ok);
  assert.equal(ok.result.raidsLeft, RA.PER_DAY - 1);
  assert.deepEqual([st.players[TA].raidDay, st.players[TA].raidsToday], ["2026-11-01", 1]);
  // refused raids don't use one up
  const st2 = raidWorld();
  raid(st2, TA, TB, 1, 2);
  assert.equal(S.raidStatus(st2, st2.players[TA], T0).raidsLeft, RA.PER_DAY);
});

test("raid window: only while he runs (idle -> hamster_asleep), fresh chain read in live mode", () => {
  assert.deepEqual(S.raidWindow(T0 - 60_000, T0), { open: true, reason: null });
  assert.deepEqual(S.raidWindow(T0 - BALANCE.IDLE_AFTER_MS, T0), { open: false, reason: "hamster_asleep" });
  assert.equal(S.raidWindow(T0 - BALANCE.IDLE_AFTER_MS + 1, T0).open, true);
  assert.equal(S.raidWindow(null, T0).reason, "chain_unknown");
  assert.equal(S.raidWindow(T0 - 60_000, T0, T0 - 10_000).open, true); // live, fresh read
  assert.equal(S.raidWindow(T0 - 60_000, T0, T0 - S.CHAIN_FRESH_MS).open, true);
  assert.equal(S.raidWindow(T0 - 60_000, T0, T0 - S.CHAIN_FRESH_MS - 1).reason, "chain_stale");
  assert.equal(S.raidWindow(T0 - 60_000, T0, 0).reason, "chain_stale");
  const st = raidWorld();
  st.lastAdvanceAt = T0 - BALANCE.IDLE_AFTER_MS - 60_000;
  const r = raid(st, TA, TB, 100, 2);
  assert.deepEqual([r.ok, r.error], [false, "hamster_asleep"]);
  assert.deepEqual(S.raidStatus(st, st.players[TA], T0), { open: false, raidsLeft: RA.PER_DAY, perDay: RA.PER_DAY, resetMs: 86_400_000 - (T0 % 86_400_000) });
  const body = { target: pidOf(TB), stake: 100, mult: 2 };
  assert.equal(S.applyRaid(st, TA, body, T0, { chainReadAt: T0 - 600_000 }).error, "chain_stale");
  st.lastAdvanceAt = T0 - 5000; // a block settles: the window opens (given a fresh chain read)
  assert.equal(S.applyRaid(st, TA, body, T0, { chainReadAt: T0 - 600_000 }).error, "chain_stale");
  assert.ok(S.applyRaid(st, TA, body, T0, { chainReadAt: T0 - 5000, rng: seq(LOSE) }).ok);
  assert.equal(S.applyRaid(st, "z".repeat(32), body, T0).error, "unknown_player");
});

test("raid eligibility: punch-up only (target >= 70% of your balance), never yourself", () => {
  const st = raidWorld();
  assert.equal(raid(st, TA, TC, 100, 2).error, "not_eligible"); // 1k < 7k
  assert.ok(raid(st, TC, TA, 100, 2).ok); // the poor room may hit the rich one
  assert.equal(raid(st, TB, TB, 100, 2).error, "self_target");
  for (const target of ["nope", 42, undefined, "__proto__", "x".repeat(100)]) {
    assert.equal(S.applyRaid(st, TB, { target, stake: 100, mult: 2 }, T0).error, "bad_target", `${target}`);
  }
  const edge = raidWorld({ def: { watts: 7000 } });
  assert.equal(S.raidEligibility(edge.players[TA], edge.players[TB], T0).ok, true); // exactly 70%
  edge.players[TB].watts = 6999;
  assert.equal(S.raidEligibility(edge.players[TA], edge.players[TB], T0).error, "not_eligible");
  // a target that joined after the publicId index was built is still found
  const late = "d".repeat(32);
  st.players[late] = Object.assign(S.newPlayer(1000, T0, late), { watts: 50_000 });
  assert.equal(S.tokenForPublicId(st, pidOf(late)), late);
  assert.ok(raid(st, TB, late, 100, 2).ok);
});

test("raid revenge: waives the 70% rule once per provocation, expires after 24 h", () => {
  const st = raidWorld();
  const [rich, poor] = [st.players[TA], st.players[TC]];
  const at = (t) => ((st.lastAdvanceAt = t - 1000), t);
  assert.equal(raid(st, TA, TC, 100, 2, at(T0)).error, "not_eligible");
  assert.ok(raid(st, TC, TA, 100, 2, at(T0), seq(LOSE)).ok); // poor provokes (and fails)
  assert.deepEqual(rich.raidedBy, [{ pid: poor.publicId, at: T0, avenged: false }]);
  const row = S.leaderboard(st, TA, T0 + 1000).rows.find((r) => r.publicId === poor.publicId);
  assert.deepEqual([row.raidable, row.revenge], [true, true]);
  const r = raid(st, TA, TC, 100, 2, at(T0 + 1000), seq(LOSE));
  assert.equal(r.ok, true);
  assert.equal(r.result.revenge, true);
  assert.equal(rich.raidedBy[0].avenged, true); // consumed
  rich.lastRaidAt = 0;
  assert.equal(raid(st, TA, TC, 100, 2, at(T0 + 2000)).error, "not_eligible"); // only once
  // a fresh provocation grants a fresh revenge
  poor.lastRaidAt = 0;
  assert.ok(raid(st, TC, TA, 100, 2, at(T0 + 3000), seq(LOSE)).ok);
  rich.lastRaidAt = 0;
  assert.equal(raid(st, TA, TC, 100, 2, at(T0 + 4000), seq(LOSE)).result.revenge, true);
  // expiry: 24 h after the provocation it is gone
  const st2 = raidWorld();
  const at2 = (t) => ((st2.lastAdvanceAt = t - 1000), t);
  assert.ok(raid(st2, TC, TA, 100, 2, at2(T0), seq(LOSE)).ok);
  assert.equal(raid(st2, TA, TC, 100, 2, at2(T0 + RA.REVENGE_WINDOW_MS)).error, "not_eligible");
  assert.equal(S.leaderboard(st2, TA, T0 + RA.REVENGE_WINDOW_MS).rows.find((x) => x.publicId === pidOf(TC)).raidable, false);
  assert.equal(raid(st2, TA, TC, 100, 2, at2(T0 + RA.REVENGE_WINDOW_MS - 1), seq(LOSE)).result.revenge, true);
  // a raid that didn't need the waiver leaves the provocation pending
  const st3 = raidWorld();
  assert.ok(raid(st3, TB, TA, 100, 2, T0, seq(LOSE)).ok);
  const plain = raid(st3, TA, TB, 100, 2, T0, seq(LOSE));
  assert.equal(plain.result.revenge, false);
  assert.equal(st3.players[TA].raidedBy[0].avenged, false);
});

test("raid ring buffers: raidedBy keeps 20 (24 h), the feed keeps 50", () => {
  const st = raidWorld({ def: { watts: 1e9 } });
  for (let i = 0; i < 60; i++) {
    st.players[TA].raidsToday = 0;
    assert.ok(raid(st, TA, TB, 100 + i, 2, T0 + i, seq(LOSE)).ok);
  }
  const d = st.players[TB];
  assert.equal(d.raidedBy.length, RA.RAIDED_BY_MAX);
  assert.equal(d.raidedBy.at(-1).at, T0 + 59);
  assert.equal(st.raidFeed.length, RA.FEED_MAX);
  assert.equal(st.raidFeed.at(-1).amount, 159); // newest last
  assert.equal(st.raidFeed[0].amount, 110); // the oldest 10 dropped
  for (const e of st.raidFeed) assert.deepEqual(Object.keys(e).sort(), ["amount", "at", "atk", "atkId", "crit", "def", "defId", "win"]);
  // entries older than the revenge window are pruned on the next raid
  st.players[TC].watts = 1e9;
  const later = T0 + RA.REVENGE_WINDOW_MS + 100;
  st.lastAdvanceAt = later;
  assert.ok(raid(st, TC, TB, 100, 2, later, seq(LOSE)).ok);
  assert.deepEqual(d.raidedBy.map((e) => e.pid), [pidOf(TC)]);
});

test("leaderboard: by balance, shape, per-viewer raidable/you flags, 10 s cache, 200 rows", () => {
  const st = raidWorld({ atk: { lifetimeWatts: 900, roomTier: 2 }, def: { watts: 20_000 }, poor: { watts: 8000 } });
  const lb = S.leaderboard(st, TA, T0);
  assert.deepEqual(lb.rows.map((r) => r.nick), ["def", "atk", "poor"]);
  assert.deepEqual(lb.rows[1], { rank: 2, publicId: pidOf(TA), nick: "atk", name: "atk", verified: false, watts: 10_000, lifetimeWatts: 900, roomTier: 2, raidable: false, revenge: false, you: true });
  assert.deepEqual(lb.rows.map((r) => r.raidable), [true, false, true]); // 8k >= 70% of 10k
  assert.deepEqual(lb.raid, { open: true, raidsLeft: RA.PER_DAY, perDay: RA.PER_DAY, resetMs: 86_400_000 - (T0 % 86_400_000) });
  assert.equal(lb.total, 3);
  assert.ok(!JSON.stringify(lb).includes(TA), "leaderboard must not leak tokens");
  // the richest room has no targets; the poorest can hit everyone
  assert.deepEqual(S.leaderboard(st, TB, T0).rows.map((r) => r.raidable), [false, false, false]);
  assert.deepEqual(S.leaderboard(st, TC, T0).rows.map((r) => r.raidable), [true, true, false]);
  // anonymous viewer: no flags, no raid status
  const anon = S.leaderboard(st, null, T0);
  assert.equal(anon.raid, null);
  assert.ok(anon.rows.every((r) => !r.raidable && !r.you));
  // cached for 10 s ...
  st.players[TC].watts = 99_999;
  assert.equal(S.leaderboard(st, TA, T0 + 9999).rows[0].nick, "def");
  assert.equal(S.leaderboard(st, TA, T0 + 10_000).rows[0].nick, "poor");
  // ... and a raid invalidates it at once
  st.players[TC].watts = 8000;
  S.invalidateLeaderboard(st);
  S.leaderboard(st, TA, T0);
  assert.ok(raid(st, TA, TB, 2000, 10, T0 + 1, seq(WIN, 0.999999, 0.01)).ok); // 9 x 2000 x 1.25 x 1.5 -> capped at 25% of 20k
  const after = S.leaderboard(st, TA, T0 + 2);
  assert.deepEqual(after.rows.map((r) => [r.nick, r.watts]), [["atk", 15_000], ["def", 15_000], ["poor", 8000]]);
  assert.equal(after.raid.raidsLeft, RA.PER_DAY - 1);
  // capped at 200 rows, sorted, ranked
  const big = { lastAdvanceAt: T0, players: {} };
  for (let i = 0; i < 250; i++) {
    const t = `tok${String(i).padStart(4, "0")}`.padEnd(20, "x");
    big.players[t] = Object.assign(S.newPlayer(1000, T0, t), { watts: (i % 50) * 100 });
  }
  const top = S.leaderboard(big, null, T0);
  assert.equal(top.rows.length, RA.LEADERBOARD_MAX);
  assert.equal(top.total, 250);
  for (let i = 1; i < top.rows.length; i++) assert.ok(top.rows[i - 1].watts >= top.rows[i].watts);
  assert.deepEqual(top.rows.map((r) => r.rank), Array.from({ length: 200 }, (_, i) => i + 1));
});

test("raid persistence: new fields default-patched on load, existing values kept", () => {
  const old = fresh({ watts: 5000 });
  delete old.lastRaidAt;
  delete old.raidedBy;
  const keep = fresh({ lastRaidAt: T0, raidedBy: [{ pid: "abc", at: T0, avenged: true }] });
  const st = S.patchState({ height: 10, players: { [TA]: old, [TB]: keep } }, T0);
  assert.deepEqual([old.lastRaidAt, old.raidedBy], [0, []]);
  assert.deepEqual([keep.lastRaidAt, keep.raidedBy], [T0, [{ pid: "abc", at: T0, avenged: true }]]);
  assert.deepEqual([st.burned, st.raidFeed], [0, []]);
  const kept = S.patchState({ height: 10, burned: 1234, raidFeed: [{ at: 1 }], players: {} }, T0);
  assert.deepEqual([kept.burned, kept.raidFeed], [1234, [{ at: 1 }]]);
  const n = S.newPlayer(1000, T0, TA);
  assert.deepEqual([n.lastRaidAt, n.raidedBy], [0, []]);
  // the polled snapshot carries the feed (and, for a viewer, the raid status)
  const snap = S.snapshot();
  assert.ok(Array.isArray(snap.raidFeed));
  assert.equal(snap.raid, null);
  assert.equal(typeof snap.burned, "number");
});

// ---------- wallet sign-in: lib/ethsig.js ----------
const E = require("../lib/ethsig.js");
const nodeCrypto = require("node:crypto");
const KEY_A = 0xa11cen, KEY_B = 0xb0bn, KEY_C = 0xc0ffee1234567890abcdefn;

test("keccak256: fixed Ethereum vectors (not SHA3-256), strings hash as UTF-8 bytes", () => {
  assert.equal(E.keccak256Hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(E.keccak256Hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(E.keccak256Hex("The quick brown fox jumps over the lazy dog"), "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15");
  assert.notEqual(E.keccak256Hex(""), nodeCrypto.createHash("sha3-256").update("").digest("hex"));
  assert.equal(E.keccak256Hex(Buffer.from("abc")), E.keccak256Hex("abc"));
  assert.equal(E.keccak256Hex("—"), E.keccak256Hex(Buffer.from([0xe2, 0x80, 0x94])));
  assert.equal(E.keccak256("x").length, 32);
});

test("keccak sponge: with the SHA3 pad byte it matches node:crypto sha3-256 across block boundaries", () => {
  for (let n = 0; n <= 300; n++) {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + n * 7) & 0xff;
    assert.equal(E.sha3_256(b).toString("hex"), nodeCrypto.createHash("sha3-256").update(b).digest("hex"), `len ${n}`);
  }
});

test("secp256k1: well-known addresses for keys 1..3; public keys match node's ECDH", () => {
  assert.equal(E.addressFromPrivate(1n), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  assert.equal(E.addressFromPrivate(2n), "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf");
  assert.equal(E.addressFromPrivate(3n), "0x6813eb9362372eef6200f3b1dbc3f819671cba69");
  for (const bad of [0n, E.N, -1n, 5]) assert.throws(() => E.addressFromPrivate(bad), `key ${bad}`);
  if (!nodeCrypto.getCurves().includes("secp256k1")) return;
  const ecdh = nodeCrypto.createECDH("secp256k1");
  for (const k of [1n, 2n, KEY_A, KEY_C, E.N - 1n, BigInt("0x" + E.keccak256Hex("seed"))]) {
    ecdh.setPrivateKey(Buffer.from(k.toString(16).padStart(64, "0"), "hex"));
    const [x, y] = E.publicKeyFromPrivate(k);
    assert.equal(ecdh.getPublicKey("hex"), "04" + x.toString(16).padStart(64, "0") + y.toString(16).padStart(64, "0"), `key ${k}`);
  }
});

test("personalDigest: EIP-191 prefix with the UTF-8 byte length", () => {
  const prefixed = (s) => E.keccak256Hex(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(s)}`), Buffer.from(s)]));
  assert.equal(E.personalDigest("hello").toString("hex"), prefixed("hello"));
  assert.equal(E.personalDigest("a — b").toString("hex"), prefixed("a — b")); // 7 bytes, 5 chars
  assert.notEqual(E.personalDigest("a — b").toString("hex"), E.keccak256Hex("\x19Ethereum Signed Message:\n5a — b"));
});

test("signPersonal -> recoverPersonalSig roundtrip; deterministic, low-s; v 0/1 and high-s also accepted", () => {
  const msgs = ["hello", "", "Squeekroom — sign in\nNonce: 00ff", "x".repeat(500)];
  for (const k of [1n, 2n, KEY_A, KEY_B, KEY_C, E.N - 2n]) {
    const addr = E.addressFromPrivate(k);
    for (const m of msgs) {
      const sig = E.signPersonal(m, k);
      assert.match(sig, /^0x[0-9a-f]{128}(1b|1c)$/);
      assert.equal(E.signPersonal(m, k), sig, "deterministic");
      assert.equal(E.recoverPersonalSig(m, sig), addr, `key ${k} msg ${m.length}`);
      const p = E.parseSignature(sig);
      assert.ok(p.s <= E.N / 2n, "low-s");
      // v as 0/1 and without the 0x prefix
      const v01 = sig.slice(0, -2) + (p.recid ? "01" : "00");
      assert.equal(E.recoverPersonalSig(m, v01), addr);
      assert.equal(E.recoverPersonalSig(m, sig.slice(2)), addr);
      // the malleable twin (n - s, flipped parity) recovers the same signer
      const hi = "0x" + sig.slice(2, 66) + (E.N - p.s).toString(16).padStart(64, "0") + (p.recid ? "1b" : "1c");
      assert.equal(E.recoverPersonalSig(m, hi), addr);
      // another message does not recover this signer
      assert.notEqual(E.recoverPersonalSig(m + "!", sig), addr);
    }
  }
});

test("recoverPersonalSig: malformed signatures and out-of-range r/s give null", () => {
  const sig = E.signPersonal("hello", KEY_A);
  const r = sig.slice(2, 66), s = sig.slice(66, 130);
  const h = (v) => v.toString(16).padStart(64, "0");
  for (const bad of [
    undefined, null, 42, {}, "", "0x", sig.slice(0, -2), sig + "00", sig.replace(/.$/, "z"),
    sig.slice(0, -2) + "1d", sig.slice(0, -2) + "02", // v 29 / 2
    "0x" + h(0n) + s + "1b", "0x" + r + h(0n) + "1b", "0x" + h(E.N) + s + "1b", "0x" + r + h(E.N) + "1b",
    "0x" + h(E.N + 5n) + s + "1b", "0x" + "f".repeat(64) + s + "1b",
  ]) assert.equal(E.recoverPersonalSig("hello", bad), null, `${bad}`);
  assert.equal(E.recoverPersonalSig("hello", Buffer.from(sig.slice(2), "hex")), E.addressFromPrivate(KEY_A)); // bytes work too
});

// ---------- wallet sign-in: server flow ----------
function walletWorld() {
  const st = { lastAdvanceAt: T0 - 60_000, burned: 0, raidFeed: [], players: {} };
  for (const [t, nick, watts] of [[TA, "atk", 10_000], [TB, "def", 10_000], [TC, "poor", 1_000]]) {
    st.players[t] = Object.assign(S.newPlayer(1000, T0, t), { nick, watts });
  }
  return st;
}
// Run the full sign-in for `token` with private key `key`; returns verifyWallet's result.
function signIn(st, token, key, now = T0, { address } = {}) {
  const n = S.issueWalletNonce(st, token, now);
  assert.equal(n.ok, true);
  return S.verifyWallet(st, token, { address: address || E.addressFromPrivate(key), signature: E.signPersonal(n.message, key) }, now + 1000);
}

test("wallet nonce: burner warning, publicId, 16-byte hex nonce, ISO time; 10 min; a new one replaces it", () => {
  const st = walletWorld();
  const r = S.issueWalletNonce(st, TA, T0);
  assert.equal(r.ok, true);
  assert.equal(r.expiresAt, T0 + 10 * 60_000);
  assert.equal(S.WALLET.NONCE_TTL_MS, 600_000);
  const lines = r.message.split("\n");
  assert.equal(lines[0], "Squeekroom — sign in");
  assert.ok(lines.includes("EXPERIMENTAL GAME — link a BURNER wallet only."));
  assert.ok(lines.includes(`Room: ${pidOf(TA)}`));
  assert.ok(lines.includes(`Issued At: ${new Date(T0).toISOString()}`));
  const nonce = lines.find((l) => l.startsWith("Nonce: ")).slice(7);
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(st.players[TA].walletNonce, { message: r.message, expiresAt: r.expiresAt }); // stored verbatim
  const again = S.issueWalletNonce(st, TA, T0 + 5);
  assert.notEqual(again.message, r.message, "fresh random nonce each time");
  assert.equal(st.players[TA].walletNonce.message, again.message);
  assert.equal(S.issueWalletNonce(st, TA, T0, "ab".repeat(16)).message, S.walletMessage(pidOf(TA), "ab".repeat(16), T0));
  assert.equal(S.issueWalletNonce(st, "z".repeat(32), T0).error, "unknown_player");
});

test("wallet verify: happy path binds the lowercase address, spends the nonce, shows in the public view", () => {
  const st = walletWorld();
  const addr = E.addressFromPrivate(KEY_A);
  const n = S.issueWalletNonce(st, TA, T0);
  const sig = E.signPersonal(n.message, KEY_A);
  const mixed = "0x" + addr.slice(2).toUpperCase();
  const r = S.verifyWallet(st, TA, { address: mixed, signature: sig }, T0 + 60_000);
  assert.deepEqual(r, { ok: true, wallet: addr });
  const p = st.players[TA];
  assert.equal(p.wallet, addr);
  assert.equal(p.walletNonce, null);
  // single-use: replaying the same proof needs a new message
  assert.equal(S.verifyWallet(st, TA, { address: addr, signature: sig }, T0 + 61_000).error, "no_nonce");
  const pub = S.publicPlayer(p, T0);
  assert.deepEqual([pub.wallet, pub.username, pub.verified], [addr, null, true]);
  assert.ok(!("walletNonce" in pub));
  const anon = S.publicPlayer(st.players[TB], T0);
  assert.deepEqual([anon.wallet, anon.username, anon.verified], [null, null, false]);
});

test("wallet verify: no_nonce, nonce_expired, bad_address, bad_signature, wrong signer -> wallet_mismatch", () => {
  const st = walletWorld();
  const addrA = E.addressFromPrivate(KEY_A);
  assert.equal(S.verifyWallet(st, TA, { address: addrA, signature: "0x00" }, T0).error, "no_nonce");
  // expiry at exactly 10 min; an expired message is dropped
  let n = S.issueWalletNonce(st, TA, T0);
  assert.equal(S.verifyWallet(st, TA, { address: addrA, signature: E.signPersonal(n.message, KEY_A) }, T0 + 600_000).error, "nonce_expired");
  assert.equal(st.players[TA].walletNonce, null);
  n = S.issueWalletNonce(st, TA, T0);
  const good = E.signPersonal(n.message, KEY_A);
  for (const address of [undefined, 42, "0x123", addrA.slice(2), addrA + "0"]) assert.equal(S.verifyWallet(st, TA, { address, signature: good }, T0).error, "bad_address", `${address}`);
  for (const signature of [undefined, "", "0xdead", good.slice(0, -2) + "1d"]) assert.equal(S.verifyWallet(st, TA, { address: addrA, signature }, T0).error, "bad_signature", `${signature}`);
  // signed by B but claiming A; signed by A over some other text
  assert.equal(S.verifyWallet(st, TA, { address: addrA, signature: E.signPersonal(n.message, KEY_B) }, T0).error, "wallet_mismatch");
  assert.equal(S.verifyWallet(st, TA, { address: addrA, signature: E.signPersonal(n.message + " ", KEY_A) }, T0).error, "wallet_mismatch");
  assert.equal(S.verifyWallet(st, TA, { address: addrA, signature: E.signPersonal(S.walletMessage(pidOf(TA), "00".repeat(16), T0), KEY_A) }, T0).error, "wallet_mismatch");
  // a proof for another player's message does not work here either
  const nb = S.issueWalletNonce(st, TB, T0);
  assert.equal(S.verifyWallet(st, TA, { address: addrA, signature: E.signPersonal(nb.message, KEY_A) }, T0).error, "wallet_mismatch");
  assert.equal(st.players[TA].wallet, null);
  // failures keep the pending message: the right signature still works
  assert.ok(S.verifyWallet(st, TA, { address: addrA, signature: good }, T0 + 1).ok);
  assert.equal(S.verifyWallet(st, "z".repeat(32), {}, T0).error, "unknown_player");
});

test("wallet verify: one wallet per player (wallet_taken); re-verifying or switching your own is fine", () => {
  const st = walletWorld();
  assert.ok(signIn(st, TA, KEY_A).ok);
  const r = signIn(st, TB, KEY_A);
  assert.deepEqual([r.ok, r.error], [false, "wallet_taken"]);
  assert.equal(st.players[TB].wallet, null);
  assert.ok(st.players[TB].walletNonce, "a refused bind keeps the pending message");
  assert.ok(signIn(st, TA, KEY_A, T0 + 5000).ok); // same wallet again
  assert.ok(signIn(st, TB, KEY_B).ok);
  assert.ok(signIn(st, TA, KEY_C).ok); // A moves to another wallet ...
  assert.equal(st.players[TA].wallet, E.addressFromPrivate(KEY_C));
  assert.ok(signIn(st, TC, KEY_A).ok); // ... which frees the old one
});

test("wallet username: needs a wallet, 3-16 of [A-Za-z0-9_], unique ignoring case, may change", () => {
  const st = walletWorld();
  assert.equal(S.setUsername(st, TA, { username: "Squeaker" }).error, "wallet_required");
  assert.ok(signIn(st, TA, KEY_A).ok);
  assert.ok(signIn(st, TB, KEY_B).ok);
  for (const username of [undefined, 42, "", "ab", "a".repeat(17), "has space", "dash-ed", "emoji\u{1F600}", "ünï", "semi;colon", ["abc"]]) {
    assert.equal(S.setUsername(st, TA, { username }).error, "bad_username", `${username}`);
  }
  assert.equal(st.players[TA].username, null);
  assert.deepEqual(S.setUsername(st, TA, { username: "Squeaker_01" }), { ok: true, username: "Squeaker_01" });
  assert.ok(S.setUsername(st, TB, { username: "abc" }).ok);
  assert.ok(S.setUsername(st, TB, { username: "a".repeat(16) }).ok);
  assert.equal(S.setUsername(st, TB, { username: "squeaker_01" }).error, "username_taken");
  assert.equal(S.setUsername(st, TB, { username: "SQUEAKER_01" }).error, "username_taken");
  assert.ok(S.setUsername(st, TA, { username: "SQUEAKER_01" }).ok, "re-casing your own name is fine");
  assert.ok(S.setUsername(st, TA, { username: "Wheelie" }).ok);
  assert.ok(S.setUsername(st, TB, { username: "squeaker_01" }).ok, "a released name is free again");
  assert.deepEqual([st.players[TA].username, st.players[TB].username], ["Wheelie", "squeaker_01"]);
  assert.equal(S.WALLET.USERNAME_RE.source, "^[A-Za-z0-9_]{3,16}$");
});

test("leaderboard: verified players show their username as name; others fall back to the nick", () => {
  const st = walletWorld();
  st.players[TB].watts = 20_000;
  const lb0 = S.leaderboard(st, null, T0);
  assert.deepEqual(lb0.rows.map((r) => [r.name, r.verified]), [["def", false], ["atk", false], ["poor", false]]);
  assert.ok(signIn(st, TA, KEY_A).ok);
  assert.ok(S.setUsername(st, TA, { username: "Hammy" }).ok);
  assert.ok(signIn(st, TC, KEY_C).ok); // verified, no username yet
  const lb = S.leaderboard(st, null, T0 + 1); // within the 10 s cache: wallet + username changes invalidate it
  assert.deepEqual(lb.rows.map((r) => [r.name, r.verified, r.nick]), [["def", false, "def"], ["Hammy", true, "atk"], ["poor", true, "poor"]]);
  assert.equal(S.displayName(st.players[TA]), "Hammy");
  assert.equal(S.displayName({ nick: "" }), "anon");
  assert.ok(!JSON.stringify(lb).includes(E.addressFromPrivate(KEY_A)), "rows carry the verified flag, not the address");
});

test("raid feed: records display names at raid time", () => {
  const st = walletWorld();
  assert.ok(signIn(st, TA, KEY_A).ok);
  assert.ok(S.setUsername(st, TA, { username: "Raider" }).ok);
  const r = raid(st, TA, TB, 100, 2, T0, seq(LOSE));
  assert.ok(r.ok);
  assert.deepEqual([r.feed.atk, r.feed.def], ["Raider", "def"]);
  assert.ok(signIn(st, TB, KEY_B).ok);
  assert.ok(S.setUsername(st, TB, { username: "Guard" }).ok);
  st.players[TA].lastRaidAt = 0;
  const r2 = raid(st, TA, TB, 100, 2, T0 + 1, seq(LOSE));
  assert.deepEqual([r2.feed.atk, r2.feed.def], ["Raider", "Guard"]);
  assert.deepEqual([st.raidFeed[0].atk, st.raidFeed[0].def], ["Raider", "def"]); // older entries keep the old name
  for (const e of st.raidFeed) assert.deepEqual(Object.keys(e).sort(), ["amount", "at", "atk", "atkId", "crit", "def", "defId", "win"]);
});

test("wallet persistence + config: fields default to null on load, kept when present; rules published", () => {
  const n = S.newPlayer(1000, T0, TA);
  assert.deepEqual([n.wallet, n.username, n.walletNonce], [null, null, null]);
  const old = fresh({ watts: 5000 });
  for (const k of ["wallet", "username", "walletNonce"]) delete old[k];
  const keep = fresh({ wallet: "0xabc", username: "Kept", walletNonce: { message: "m", expiresAt: T0 } });
  S.patchState({ height: 10, players: { [TA]: old, [TB]: keep } }, T0);
  assert.deepEqual([old.wallet, old.username, old.walletNonce, old.watts], [null, null, null, 5000]);
  assert.deepEqual([keep.wallet, keep.username, keep.walletNonce], ["0xabc", "Kept", { message: "m", expiresAt: T0 }]);
  const cfg = S.configPayload();
  assert.equal(cfg.wallet.enabled, true);
  assert.equal(cfg.wallet.burnerWarning, true);
  assert.equal(new RegExp(cfg.wallet.usernameRe).test("Ok_name"), true);
  assert.equal(new RegExp(cfg.wallet.usernameRe).test("no"), false);
});

// ---------- replay mode (simulated Squeektoshi on her real rhythm, sped up) ----------
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const SCHED = S.replaySchedule(3);
const EP = SCHED.epochMs;
const segAt = (sc, label, k = 0) => sc.segments.filter((s) => s.label === label)[k];
const replayWorld = (players = {}) => S.patchState({ players });

test("replay schedule: 3x = an 8 h night of 1,078 blocks; runs 10-30 min, rests 20-60 min, alternating", () => {
  assert.equal(SCHED.speed, 3);
  assert.equal(SCHED.cycleMs, 8 * HOUR);
  assert.equal(SCHED.blocksPerCycle, 1078);
  assert.equal(SCHED.blocksPerDay, 3234);
  assert.equal(SCHED.segments.reduce((a, s) => a + s.blocks, 0), 1078);
  SCHED.segments.forEach((s, i) => {
    if (i) assert.notEqual(s.kind, SCHED.segments[i - 1].kind, "runs and rests alternate");
    if (s.kind === "run") {
      assert.ok(s.ms >= 10 * MIN && s.ms <= 30 * MIN, `run ${s.label} ${s.ms / MIN} min`);
      assert.ok(s.blocks >= 1);
    } else {
      assert.ok(s.ms >= 20 * MIN && s.ms <= 60 * MIN, `rest ${s.ms / MIN} min`);
      assert.ok(s.ms >= BALANCE.IDLE_AFTER_MS + 10 * MIN, "every rest leaves >= 10 min of real sleep");
      assert.equal(s.blocks, 0);
    }
  });
  // the real night's shape: the 22:00-02:00 runs carry most of the work, the stirs almost none
  const runs = SCHED.segments.filter((s) => s.kind === "run").sort((a, b) => b.blocks - a.blocks);
  assert.deepEqual(runs.slice(0, 2).map((s) => s.label).sort(), ["after midnight", "peak"]);
  assert.ok(runs.slice(0, 3).reduce((a, s) => a + s.blocks, 0) / 1078 > 0.75);
  // at 1x the same night spans a real day, starting at her real 21:00 UTC
  const one = S.replaySchedule(1);
  assert.equal(one.cycleMs, DAY);
  assert.equal(one.blocksPerCycle, 1078);
  assert.equal(new Date(EP).getUTCHours(), 21);
  // high speeds keep the rest floor (still past IDLE_AFTER_MS)
  for (const s of S.replaySchedule(24).segments) if (s.kind === "sleep") assert.ok(s.ms >= S.REPLAY_MIN_SLEEP_MS);
});

test("cumulativeBlocks: deterministic, monotonic at the 10 s poll, 1,078 x SPEED a day (+-5%)", () => {
  const t = EP + 3 * DAY + 12_345_678;
  assert.equal(S.cumulativeBlocks(t, SCHED), S.cumulativeBlocks(t, S.replaySchedule(3)), "pure function of t");
  assert.equal(S.cumulativeBlocks(t, SCHED), S.replayCumulativeBlocks(t, SCHED));
  assert.equal(S.cumulativeBlocks(EP - DAY, SCHED), 0); // before the epoch nothing has settled
  assert.equal(S.cumulativeBlocks(EP, SCHED), 0);
  let prev = S.cumulativeBlocks(t, SCHED);
  let maxStep = 0;
  for (let x = t; x <= t + 2 * DAY; x += 10_000) {
    const c = S.cumulativeBlocks(x, SCHED);
    assert.ok(Number.isInteger(c) && c >= prev, `went back at ${x}`);
    maxStep = Math.max(maxStep, c - prev);
    prev = c;
  }
  assert.ok(maxStep <= 5, `at most a few blocks per poll (${maxStep})`);
  assert.equal(S.cumulativeBlocks(EP + 5 * DAY, SCHED) - S.cumulativeBlocks(EP + 4 * DAY, SCHED), 3234);
  for (const sp of [1, 2, 3, 6, 12]) {
    const sc = S.replaySchedule(sp);
    for (const start of [EP + 1_234_567, EP + 9.5 * DAY]) {
      const perDay = (S.cumulativeBlocks(start + 4 * DAY, sc) - S.cumulativeBlocks(start, sc)) / 4;
      const want = 1078 * sp;
      assert.ok(Math.abs(perDay - want) <= want * 0.05, `x${sp}: ${perDay}/day vs ${want}`);
    }
  }
});

test("replay alternation: each day brings many run windows and sleeps that outlast IDLE_AFTER_MS", () => {
  for (const sp of [1, 3, 6]) {
    const sc = S.replaySchedule(sp);
    const start = EP + 2 * DAY + 17 * MIN;
    const spans = []; // [running, ms] of contiguous stretches, sampled every 30 s
    let cur = null;
    for (let x = start; x <= start + DAY; x += 30_000) {
      const running = S.replayReading(x, sc).running;
      if (!cur || cur[0] !== running) spans.push((cur = [running, 0]));
      else cur[1] += 30_000;
    }
    const whole = spans.slice(1, -1); // drop the cut-off first and last stretch
    const runs = whole.filter((s) => s[0]);
    const sleeps = whole.filter((s) => !s[0]);
    assert.ok(runs.length >= 7 * sp, `x${sp}: ${runs.length} runs a day`);
    assert.ok(sleeps.every((s) => s[1] >= BALANCE.IDLE_AFTER_MS), `x${sp}: every sleep passes IDLE_AFTER_MS`);
    assert.ok(sleeps.length >= 7 * sp);
    if (sp === 3) assert.ok(Math.max(...sleeps.map((s) => s[1])) <= 60 * MIN, "no sleep past an hour at 3x");
  }
});

test("replay tick: raids close 10 min into every sleep, reopen on a run's first poll; bed only while asleep", () => {
  const st = replayWorld({ [TOKEN]: S.newPlayer(null, EP, TOKEN) });
  const p = st.players[TOKEN];
  const t0 = EP + 2 * DAY + 3 * MIN + 3_700; // off the minute grid: polls never land exactly on a boundary
  let bed = 0;
  let checkedOpen = 0, checkedClosed = 0;
  let prevSeg = null;
  for (let x = t0; x <= t0 + SCHED.cycleMs + HOUR; x += 10_000) {
    S.replayTick(st, x, SCHED, 5204);
    const idle = S.chainIdle(st.lastAdvanceAt, x);
    const got = S.accrueBed(st, idle, x);
    bed += got;
    const loc = S.replayLocate(x, SCHED);
    const segKey = `${loc.n}/${loc.i}`;
    const w = S.raidWindow(st.lastAdvanceAt, x);
    if (loc.seg.kind === "run" && loc.u > 0) {
      assert.equal(w.open, true, `raids open in run ${loc.seg.label} at ${new Date(x).toISOString()}`);
      if (segKey !== prevSeg) checkedOpen++; // the first poll of this run
      assert.equal(got, 0, "no bed income while she runs");
    } else if (loc.seg.kind === "sleep" && prevSeg !== null) {
      const into = x - (loc.cycleStart + loc.seg.start);
      if (into >= BALANCE.IDLE_AFTER_MS) {
        assert.equal(idle, true, `asleep ${into / MIN} min into ${loc.seg.label}`);
        assert.equal(w.reason, "hamster_asleep");
        checkedClosed++;
      } else assert.equal(w.open, true, `the first 10 min of a rest still count as running (${into / 1000} s)`);
    }
    prevSeg = segKey;
  }
  assert.ok(checkedOpen >= 8, `every run reopened raids (${checkedOpen})`);
  assert.ok(checkedClosed > 0 && bed > 0);
  // the books balance: 10 W per settled block since joining + the bed trickle
  assert.equal(p.lifetimeWatts, (st.height - p.joinHeight) * 10 + bed);
  assert.equal(p.watts, BALANCE.WELCOME_WATTS + p.lifetimeWatts);
});

test("replay restart safety: height = offset + cumulativeBlocks(t) from the persisted offset; never back, never paid twice", () => {
  const t1 = EP + 3 * DAY + 13 * HOUR + 47 * MIN;
  const st = replayWorld();
  S.replayTick(st, t1, SCHED, 5204); // fresh state: height = REPLAY_START_HEIGHT + cumulativeBlocks(t)
  assert.equal(st.height, 5204 + S.cumulativeBlocks(t1, SCHED));
  assert.equal(st.startHeight, st.height); // first sighting is the baseline, as in live mode
  assert.equal(st.replay.offset, 5204);
  st.players[TOKEN] = S.newPlayer(st.height, t1, TOKEN);
  const t2 = t1 + 2 * HOUR;
  S.replayTick(st, t2, SCHED, 5204);
  const w2 = st.players[TOKEN].watts;
  assert.equal(w2, BALANCE.WELCOME_WATTS + (S.cumulativeBlocks(t2, SCHED) - S.cumulativeBlocks(t1, SCHED)) * 10);
  // restart: state.json round trip, 5 h of downtime; a different start-height env does not matter
  const st2 = S.patchState(JSON.parse(JSON.stringify(st)));
  const t3 = t2 + 5 * HOUR;
  S.replayTick(st2, t3, SCHED, 99_999);
  assert.equal(st2.height, 5204 + S.cumulativeBlocks(t3, SCHED));
  assert.equal(st2.players[TOKEN].watts, w2 + (S.cumulativeBlocks(t3, SCHED) - S.cumulativeBlocks(t2, SCHED)) * 10, "downtime caught up once");
  const w3 = st2.players[TOKEN].watts;
  S.replayTick(st2, t3, SCHED); // same t again
  S.replayTick(st2, t3 - 90_000, SCHED); // clock stepped back
  assert.equal(st2.height, 5204 + S.cumulativeBlocks(t3, SCHED), "never backward");
  assert.equal(st2.players[TOKEN].watts, w3, "never paid twice");
  // a restart into a sleep: the sleep clock starts when the last run ended, not at the boot poll
  const sleep = segAt(SCHED, "day sleep");
  const tSleep = EP + 12 * SCHED.cycleMs + sleep.start + 25 * MIN; // after t3
  S.replayTick(st2, tSleep, SCHED);
  assert.equal(st2.lastAdvanceAt, EP + 12 * SCHED.cycleMs + sleep.start);
  assert.equal(S.chainIdle(st2.lastAdvanceAt, tSleep), true);
  // ...and a brand-new server booting mid-sleep knows she is asleep (bed income, raids closed) at once
  const born = replayWorld();
  S.replayTick(born, tSleep, SCHED);
  assert.equal(born.height, born.startHeight);
  assert.equal(S.raidWindow(born.lastAdvanceAt, tSleep).reason, "hamster_asleep");
  const bornRun = replayWorld();
  const tPeak = EP + 12 * SCHED.cycleMs + segAt(SCHED, "peak").start + 5 * MIN;
  S.replayTick(bornRun, tPeak, SCHED);
  assert.equal(bornRun.lastAdvanceAt, tPeak); // booting mid-run: raids open
  // from any later t, recomputing never goes backward
  let h = st2.height;
  for (let x = tSleep; x < tSleep + 3 * DAY; x += 7 * MIN + 13_337) {
    S.replayTick(st2, x, SCHED);
    assert.ok(st2.height >= h);
    assert.equal(st2.height, 5204 + S.cumulativeBlocks(x, SCHED));
    h = st2.height;
  }
});

test("replay switch-over: an existing live state continues (no windfall); speed change and back to live re-anchor", () => {
  const t = EP + 4 * DAY + 2 * HOUR;
  const st = replayWorld({ [TOKEN]: S.newPlayer(9000, t, TOKEN) });
  Object.assign(st, { startHeight: 8000, height: 9000, lastAccruedHeight: 9000, lastAdvanceAt: t - MIN });
  S.replayTick(st, t, SCHED);
  assert.equal(st.height, 9000);
  assert.equal(st.players[TOKEN].watts, BALANCE.WELCOME_WATTS, "switching sources pays nothing");
  S.replayTick(st, t + HOUR, SCHED);
  assert.equal(st.height, 9000 + S.cumulativeBlocks(t + HOUR, SCHED) - S.cumulativeBlocks(t, SCHED));
  // REPLAY_SPEED changed between boots: re-anchored where it stood
  const h = st.height, wBefore = st.players[TOKEN].watts;
  S.replayTick(st, t + HOUR, S.replaySchedule(6));
  assert.equal(st.height, h);
  assert.equal(st.players[TOKEN].watts, wBefore);
  assert.match(st.replay.key, /x6/);
  // back to the real chain at a lower height: fresh baseline, joinHeights clamped, no stall
  S.leaveReplay(st, 6000, t + 2 * HOUR);
  assert.equal(st.height, 6000);
  assert.equal(st.replay, undefined);
  assert.equal(st.players[TOKEN].joinHeight, 6000);
  assert.equal(st.players[TOKEN].watts, wBefore);
  S.advanceTo(6010, t + 2 * HOUR + MIN, st);
  assert.equal(st.players[TOKEN].watts, wBefore + 100);
});

test("replay reading: ACTIVE at 0.8-1.6 m/s while she runs, IDLE at 0 while she sleeps; tagged as the room server's", () => {
  const peak = segAt(SCHED, "peak");
  const tRun = EP + 2 * SCHED.cycleMs + peak.start + 15 * MIN;
  const r = S.replayReading(tRun, SCHED);
  assert.equal(r.running, true);
  assert.equal(r.hamster.coreStatus, "ACTIVE");
  assert.equal(r.hamster.key, "running");
  assert.equal(r.hamster.active, true);
  assert.equal(r.hamster.source, "replay"); // not "live": the client labels it "via room server"
  assert.ok(r.hamster.speedMmPerSecond >= 800 && r.hamster.speedMmPerSecond <= 1600);
  assert.equal(r.hamster.speed, r.hamster.speedMmPerSecond);
  assert.ok(r.hamster.rpm > 0 && r.hamster.freshness === "online");
  assert.ok(r.progress >= 0 && r.progress < 1);
  const lull = segAt(SCHED, "lull");
  const tSleep = EP + 2 * SCHED.cycleMs + lull.start + 5 * MIN;
  const z = S.replayReading(tSleep, SCHED);
  assert.equal(z.running, false);
  assert.equal(z.hamster.coreStatus, "IDLE");
  assert.equal(z.hamster.key, "idle");
  assert.equal(z.hamster.speedMmPerSecond, 0);
  assert.equal(z.nextRunAt, EP + 2 * SCHED.cycleMs + lull.end);
  const speeds = new Set();
  for (let x = tRun - 6 * HOUR; x < tRun + 18 * HOUR; x += MIN) {
    const q = S.replayReading(x, SCHED);
    if (q.running) {
      assert.ok(q.hamster.speedMmPerSecond >= 800 && q.hamster.speedMmPerSecond <= 1600);
      speeds.add(Math.round(q.hamster.speedMmPerSecond / 50));
    } else assert.equal(q.hamster.speedMmPerSecond, 0);
  }
  assert.ok(speeds.size >= 6, "speed varies");
  // the tick publishes it as the snapshot's chain + hamster
  const st = replayWorld();
  S.replayTick(st, tRun, SCHED);
  assert.equal(st.chain.rpc, "replay");
  assert.equal(st.chain.blockHeight, st.height);
  assert.equal(st.chain.replay.segment, "run");
  assert.deepEqual(st.hamster, r.hamster);
});

test("replay config: api is a same-origin base without /status, so the browser keeps the server's reading", () => {
  const live = S.configPayload();
  assert.equal(live.replay, null);
  assert.match(live.api, /^https:\/\//);
  const cfg = S.configPayload({ replay: true, sched: SCHED });
  assert.equal(cfg.api, S.REPLAY_API_SINK);
  assert.ok(cfg.api, "truthy: the client ignores a falsy api and would keep fetching the real one");
  assert.ok(cfg.api.startsWith("/api/"), "same origin");
  assert.equal(cfg.replay.speed, 3);
  assert.equal(cfg.replay.blocksPerDay, 3234);
  assert.equal(cfg.replay.cycleMs, 8 * HOUR);
  assert.equal(cfg.demo, false);
});

// ---------- speed bonus (the chain's own cadence) ----------
const SPD = { windowMs: 600_000, baseBpm: 4, maxPct: 150, warmupMs: 120_000 };
const at = (msAgo, h) => ({ t: T0 - msAgo, h });

test("speed: balance knobs", () => {
  assert.deepEqual(BALANCE.SPEED, { WINDOW_MS: 600_000, BASE_BPM: 4, MAX_PCT: 150, WARMUP_MS: 120_000 });
  // the server's own path maps the knobs onto speedPctFrom's options (not a bare spread of BALANCE.SPEED)
  assert.deepEqual(S.speedOpts(BALANCE.SPEED.BASE_BPM), SPD);
  assert.equal(S.speedPctFrom([at(600_000, 0), at(0, 50)], T0, S.speedOpts(4)), 125);
});

test("speedPctFrom: no samples or under the warmup -> 100 (restart, catch-up after downtime)", () => {
  assert.equal(S.speedPctFrom([], T0, SPD), 100);
  assert.equal(S.speedPctFrom(null, T0, SPD), 100);
  // only samples older than the window: nothing to measure
  assert.equal(S.speedPctFrom([at(700_000, 0), at(650_000, 500)], T0, SPD), 100);
  // 1,000 blocks in 60 s (a catch-up burst right after boot) is still 100: span < WARMUP_MS
  assert.equal(S.speedPctFrom([at(60_000, 0), at(0, 1000)], T0, SPD), 100);
  assert.equal(S.speedPctFrom([at(119_999, 0), at(0, 1000)], T0, SPD), 100);
  assert.equal(S.speedPctFrom([at(120_000, 0), at(0, 1000)], T0, SPD), 150, "exactly the warmup counts");
});

test("speedPctFrom: blocks/min from the oldest sample inside the window to the newest", () => {
  // the 15-min-old sample is outside the window; the 10-min one sits on its edge (inclusive)
  const ring = [at(900_000, 0), at(600_000, 10), at(300_000, 30), at(0, 60)];
  assert.equal(S.speedPctFrom(ring, T0, SPD), 125); // 50 blocks / 10 min = 5 bpm vs 4
  assert.equal(S.speedPctFrom([at(300_000, 0), at(0, 24)], T0, SPD), 120); // 24 / 5 min = 4.8 bpm
  assert.equal(S.speedPctFrom([at(300_000, 0), at(0, 23)], T0, SPD), 115); // 4.6 bpm -> 115
  // the window keeps ageing on poll samples that did not advance: 5 min after a burst it reads lower
  assert.equal(S.speedPctFrom([at(600_000, 0), at(300_000, 60), at(0, 60)], T0, SPD), 150); // 6 bpm
  assert.equal(S.speedPctFrom([at(600_000, 0), at(300_000, 25), at(0, 25)], T0, SPD), 100); // 2.5 bpm
  // a sample from "the future" (clock step) is ignored
  assert.equal(S.speedPctFrom([at(300_000, 0), at(0, 24), at(-5_000, 999)], T0, SPD), 120);
});

test("speedPctFrom: clamped to [100, MAX_PCT], never below, never above", () => {
  assert.equal(S.speedPctFrom([at(600_000, 0), at(0, 0)], T0, SPD), 100); // stalled
  assert.equal(S.speedPctFrom([at(600_000, 50), at(0, 10)], T0, SPD), 100); // height went back
  assert.equal(S.speedPctFrom([at(600_000, 0), at(0, 10)], T0, SPD), 100); // 1 bpm, slower than base
  assert.equal(S.speedPctFrom([at(600_000, 0), at(0, 100_000)], T0, SPD), 150);
  assert.equal(S.speedPctFrom([at(600_000, 0), at(0, 100_000)], T0, { ...SPD, maxPct: 130 }), 130);
  for (let n = 0; n <= 200; n += 7) {
    const pct = S.speedPctFrom([at(600_000, 0), at(0, n)], T0, SPD);
    assert.ok(Number.isInteger(pct) && pct >= 100 && pct <= 150, `${n} blocks -> ${pct}`);
  }
});

test("speed replay baseline: the schedule's mean run cadence, scaling with REPLAY_SPEED", () => {
  const near1 = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  // 3x: 1,078 blocks over 145 run-minutes (20 + 30 + 30 + 15 + 15 + 15 + 10 + 10)
  near1(S.replayRunMeanBpm(S.replaySchedule(3)), 1078 / 145);
  // 6x: runs halve to 72.5 min; rests floor at 20 min (267.5 min cycle) -> round(1078 x 6 x 267.5 / 1440) = 1202
  const six = S.replaySchedule(6);
  assert.equal(six.blocksPerCycle, 1202);
  near1(S.replayRunMeanBpm(six), 1202 / 72.5);
  assert.ok(S.replayRunMeanBpm(six) > 2 * S.replayRunMeanBpm(S.replaySchedule(3)) * 0.95, "about 2x the 3x baseline");
  // the same cadence pays less bonus against a faster replay's baseline
  const ring = [at(600_000, 0), at(0, 120)]; // 12 bpm
  const at3 = S.speedPctFrom(ring, T0, { ...SPD, baseBpm: S.replayRunMeanBpm(S.replaySchedule(3)) });
  const at6 = S.speedPctFrom(ring, T0, { ...SPD, baseBpm: S.replayRunMeanBpm(six) });
  assert.equal(at3, 150);
  assert.equal(at6, 100);
});

test("speed in replay: mid-run ramps reach the cap, every long sleep brings it back to 100", () => {
  const sched = S.replaySchedule(3);
  const opts = { ...SPD, baseBpm: S.replayRunMeanBpm(sched) };
  const ring = [];
  let max = 0, sawBonus = false;
  const t0 = sched.epochMs + 1;
  for (let t = t0; t < t0 + sched.cycleMs; t += 10_000) {
    S.recordSpeedSample(sched.blocksPerCycle + S.replayCumulativeBlocks(t, sched), t, ring, opts.windowMs);
    const pct = S.speedPctFrom(ring, t, opts);
    max = Math.max(max, pct);
    if (pct > 100) sawBonus = true;
    const p = S.replayLocate(t, sched);
    // 10+ minutes into any sleep the window holds no new block
    if (p.seg.kind === "sleep" && t - (p.cycleStart + p.seg.start) >= opts.windowMs) assert.equal(pct, 100, `sleep at ${t - t0}`);
  }
  assert.ok(sawBonus && max === 150, `max ${max}`);
  assert.ok(ring.length <= (2 * opts.windowMs) / 10_000 + 1, "ring keeps only 2 x WINDOW_MS");
});

test("accrue: scales with speedPct (wheel only), defaults to 100", () => {
  assert.equal(accrue(fresh(), 10, T0), 100);
  assert.equal(accrue(fresh(), 10, T0, 100), 100);
  assert.equal(accrue(fresh(), 10, T0, 150), 150);
  assert.equal(accrue(fresh(), 10, T0, 125), 125);
  // stacks with tier and watching: 10 x 10 x 1.25 x 1.2 x 1.5 = 225
  assert.equal(accrue(fresh({ wheelTier: 1, lastHeartbeat: T0 }), 10, T0, 150), 225);
  assert.equal(accrue(fresh({ wheelTier: 1 }), 1, T0, 130), 16); // 16.25 -> 16, integers only
  // it credits through the same path as every wheel watt (balance + lifetime -> the earn popups)
  const p = fresh();
  accrue(p, 4, T0, 150);
  assert.equal(p.watts, W0 + 60);
  assert.equal(p.lifetimeWatts, 60);
  const st = { lastAccruedHeight: 1000, height: 1000, players: { a: fresh(), b: fresh({ wheelTier: 2 }) } };
  S.accrueAll(st, 1010, T0, 150);
  assert.equal(st.players.a.watts, W0 + 150);
  assert.equal(st.players.b.watts, W0 + 240);
  S.accrueAll(st, 1020, T0);
  assert.equal(st.players.a.watts, W0 + 250, "accrueAll defaults to 100");
});

test("speed: bed income ignores it; a state other than the server's own never gets it; snapshot reports it", () => {
  // bed: 1.5 W/min whatever the cadence (bedCredit/accrueBed take no speed input)
  const p = fresh();
  assert.equal(S.bedCredit(p, 120_000, T0), 3);
  const st = { lastAccruedHeight: 1000, height: 1000, lastBedTickAt: T0 - 60_000, players: { a: fresh() } };
  assert.equal(S.accrueBed(st, true, T0), 1); // 1.5 W (carry .5)
  // advanceTo on a test state: plain income however fast the height moves
  const own = { startHeight: 1000, height: 1000, lastAccruedHeight: 1000, players: { a: fresh() } };
  for (let i = 1; i <= 12; i++) S.advanceTo(1000 + 100 * i, T0 + i * 60_000, own);
  assert.equal(own.players.a.watts, W0 + 12_000);
  // the server's own ring is empty here (nothing advanced it): no bonus, and the field is published
  assert.equal(S.snapshot().speedPct, 100);
});

test("fixtures: the wheel and the bed move on open floor tiles, 2 tiles apart", () => {
  const p = S.newPlayer(1000, T0, TA);
  assert.deepEqual(p.fixtures, { wheel: { i: 1, j: 5, flip: false }, bed: { i: 7, j: 2, flip: false } });
  assert.deepEqual(S.moveFixture(p, { which: "wheel", i: 4, j: 4, flip: true }), { ok: true, fixture: { i: 4, j: 4, flip: true } });
  assert.deepEqual(S.moveFixture(p, { which: "bed", i: 2, j: 8 }).fixture, { i: 2, j: 8, flip: false }); // flip optional
  assert.equal(S.moveFixture(p, { which: "bed", i: 5, j: 5 }).error, "too_close"); // diagonal neighbour of the wheel
  assert.equal(S.moveFixture(p, { which: "bed", i: 6, j: 4 }).ok, true); // two tiles off
  for (const [i, j] of [[0, 3], [3, 0], [11, 2], [2, 10], [10, 5], [1.5, 2], ["2", 3]]) assert.equal(S.moveFixture(p, { which: "wheel", i, j }).error, "out_of_bounds", `${i},${j}`);
  assert.equal(S.moveFixture(p, { which: "sofa", i: 2, j: 2 }).error, "bad_fixture");
  assert.equal(S.moveFixture(p, { which: "wheel", i: 2, j: 2, flip: "yes" }).error, "bad_flip");
  // older saves (and broken ones) get the defaults
  const old = S.newPlayer(1000, T0, TB);
  delete old.fixtures;
  S.patchPlayer(old, TB);
  assert.equal(S.validFixtures(old.fixtures), true);
  old.fixtures.bed = { i: 1, j: 5, flip: false }; // on top of the wheel
  S.patchPlayer(old, TB);
  assert.deepEqual(old.fixtures.bed, { i: 7, j: 2, flip: false });
  assert.deepEqual(S.publicPlayer(p).fixtures, p.fixtures);
});

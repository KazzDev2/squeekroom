// Economy + rules tests. Run from the repo root: node --test squeekroom/test/
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server.js");
require("./alert.test.js"); // security alerts; Node 22+ runs only this file for `node --test test/` (see package.json)
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
  const free = CATALOG.filter((i) => i.price === 0 && !i.crate).map((i) => i.id).sort();
  assert.deepEqual(free, ["fl_pine", "fl_straw", "skin_classic", "wp_dirt", "wp_plain"]);
  const wheels = CATALOG.filter((i) => i.cat === "wheel");
  assert.deepEqual(wheels.map((w) => w.tier), [1, 2, 3, 4, 5]);
  assert.deepEqual(wheels.map((w) => w.price), [10000, 36000, 100000, 280000, 800000]);
  assert.deepEqual(wheels.map((w) => w.multPct), [125, 160, 200, 260, 350]);
  const seed = S.CATALOG_BY_ID.get("fur_seed_bowl");
  assert.equal(seed.price, 1200);
  assert.equal(seed.w, 1);
  assert.equal(seed.h, 1);
  assert.equal(S.CATALOG_BY_ID.get("wall_tv").animated, true);
});

// ---------- accrual ----------
test("new player: 10,000 W welcome grant (a first purchase right away), tier 0, defaults owned", () => {
  const p = fresh();
  assert.equal(W0, 10_000);
  assert.equal(p.watts, W0);
  const cheapest = Math.min(...CATALOG.filter((i) => i.price > 0).map((i) => i.price));
  assert.equal(cheapest, 300); // v3: several small things on day one
  assert.ok(canBuy(p, "fur_seed_bowl").ok, "the 1,200 W seed bowl is affordable on arrival");
  assert.equal(p.wheelTier, 0);
  assert.equal(p.skin, "skin_classic");
  assert.equal(p.wallpaper, "wp_plain");
  assert.equal(p.floor, "fl_straw");
  for (const id of ["wp_dirt", "fl_pine"]) assert.equal(p.owned[id], 1, `${id} stays free to switch to`);
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
  const r = canBuy(fresh(), "fur_golden_statue"); // 150,000 > 10,000
  assert.equal(r.ok, false);
  assert.equal(r.error, "poor");
  assert.equal(r.need, 140_000);
});

test("buy: deducts server-side price, placeables stack", () => {
  const p = fresh({ watts: 4000 });
  assert.ok(S.applyBuy(p, "fur_seed_bowl").ok);
  assert.ok(S.applyBuy(p, "fur_seed_bowl").ok);
  assert.equal(p.watts, 1600);
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
  assert.equal(p.watts, 1_000_000 - 10_000 - 36_000);
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
  assert.equal(p.watts, 100_000 - 20_000 - 2400 - 2400);
});

// ---------- placement ----------
const R = S.ROOM;
// fresh() rooms have the wheel on tile (1, 5) and the bed on (7, 2)
test("placement: floor furniture stands on tiles (back tile + a chain along i, or along j flipped)", () => {
  const p = own(fresh(), "fur_sofa"); // 3 long
  const v = validatePlacement(p, "fur_sofa", 3, 0);
  assert.equal(v.ok, true);
  assert.deepEqual([v.x, v.y], [3, 0]);
  assert.ok(validatePlacement(p, "fur_sofa", 3, 4).ok, "the middle of the floor");
  assert.ok(validatePlacement(p, "fur_sofa", 0, 0, null, true).ok, "along the left wall");
  assert.equal(validatePlacement(p, "fur_sofa", -1, 0).error, "out_of_bounds");
  assert.equal(validatePlacement(p, "fur_sofa", 9, 0).error, "out_of_bounds"); // i 9..11 runs off the floor
  assert.ok(validatePlacement(p, "fur_sofa", 0, 8).ok);
  assert.equal(validatePlacement(p, "fur_sofa", 0, 8, null, true).error, "out_of_bounds"); // flipped: j 8..10
  assert.equal(validatePlacement(p, "fur_sofa", 6, 8).error, "out_of_bounds"); // past the front edge (i + j > 14)
  assert.ok(validatePlacement(own(fresh(), "fur_seed_bowl"), "fur_seed_bowl", 10, 0).ok);
});

test("placement: non-integer coords rejected", () => {
  const p = own(fresh(), "fur_seed_bowl");
  for (const [x, y] of [[1.5, 0], ["1", 0], [1, null], [NaN, 0], [1, Infinity]]) {
    assert.equal(validatePlacement(p, "fur_seed_bowl", x, y).error, "bad_coords", `${x},${y}`);
  }
});

test("placement: furniture keeps off the wheel's and the bed's tiles; rugs can lie under them; fixtures keep off furniture", () => {
  const p = own(own(own(fresh(), "fur_seed_bowl"), "fur_sofa"), "rug_rag");
  assert.deepEqual(validatePlacement(p, "fur_seed_bowl", 1, 5), { ok: false, error: "fixture", which: "wheel" });
  assert.deepEqual(validatePlacement(p, "fur_sofa", 5, 2), { ok: false, error: "fixture", which: "bed" }); // i 5..7 reaches the bed
  assert.ok(validatePlacement(p, "fur_sofa", 4, 2).ok, "i 4..6 stops short of the bed");
  assert.ok(validatePlacement(p, "rug_rag", 1, 4).ok, "a rug under the wheel");
  p.placed.push({ pid: "s1", item: "fur_sofa", x: 3, y: 7, flip: false }); // tiles (3..5, 7)
  assert.deepEqual(S.moveFixture(p, { which: "wheel", i: 4, j: 7 }), { ok: false, error: "occupied", with: "fur_sofa" });
  assert.ok(S.moveFixture(p, { which: "wheel", i: 4, j: 8 }).ok);
});

test("placement: floor overlap is 2-D over tiles", () => {
  const p = own(own(own(fresh(), "fur_sofa"), "fur_seed_bowl", 2), "fur_bookshelf");
  p.placed.push({ pid: "s1", item: "fur_sofa", x: 4, y: 4, flip: false }); // tiles (4..6, 4)
  assert.equal(validatePlacement(p, "fur_seed_bowl", 5, 4).error, "overlap");
  assert.ok(validatePlacement(p, "fur_seed_bowl", 5, 5).ok);
  assert.ok(validatePlacement(p, "fur_seed_bowl", 5, 3).ok);
  assert.equal(validatePlacement(p, "fur_bookshelf", 6, 3, null, true).error, "overlap"); // flipped: (6, 3..4)
  assert.ok(validatePlacement(p, "fur_bookshelf", 7, 3, null, true).ok);
  // moving the sofa onto itself (shifted by one) is fine, and so is turning it in place
  assert.ok(validatePlacement(p, "fur_sofa", 5, 4, "s1").ok);
  assert.ok(validatePlacement(p, "fur_sofa", 4, 4, "s1", true).ok);
});

test("placement: wall zone is 2-D on rows 2-7 and ignores the floor", () => {
  const p = own(own(fresh(), "wall_window", 2), "wall_pennant", 2); // window 2x2
  assert.ok(validatePlacement(p, "wall_window", 3, 2).ok);
  assert.equal(validatePlacement(p, "wall_window", 3, 1).error, "out_of_bounds");
  assert.equal(validatePlacement(p, "wall_window", 3, 7).error, "out_of_bounds"); // would cover row 8
  assert.ok(validatePlacement(p, "wall_window", 3, 6).ok);
  assert.equal(validatePlacement(p, "wall_window", 19, 3).error, "out_of_bounds");
  p.placed.push({ pid: "w1", item: "wall_window", x: 5, y: 3, flip: false }); // cols 5-6, rows 3-4
  assert.equal(validatePlacement(p, "wall_pennant", 6, 4).error, "overlap");
  assert.ok(validatePlacement(p, "wall_pennant", 6, 5).ok);
  assert.ok(validatePlacement(p, "wall_pennant", 7, 3).ok);
  // a floor item on a tile with the same numbers does not collide with wall decor
  own(p, "fur_seed_bowl");
  assert.ok(validatePlacement(p, "fur_seed_bowl", 5, 3).ok);
});

test("placement: rugs lie 2 tiles deep and collide only with rugs", () => {
  const p = own(own(own(fresh(), "rug_persian"), "rug_rag", 2), "fur_sofa");
  p.placed.push({ pid: "f1", item: "fur_sofa", x: 4, y: 4, flip: false });
  assert.ok(validatePlacement(p, "rug_persian", 4, 4).ok); // under furniture is fine
  p.placed.push({ pid: "r1", item: "rug_persian", x: 4, y: 4, flip: false }); // tiles i 4..7, j 4..5
  assert.equal(validatePlacement(p, "rug_rag", 7, 5).error, "overlap");
  assert.equal(validatePlacement(p, "rug_rag", 6, 3).error, "overlap"); // its second row (j 4) touches
  assert.ok(validatePlacement(p, "rug_rag", 8, 4).ok);
  assert.ok(validatePlacement(p, "rug_rag", 2, 2, null, true).ok); // flipped: i 2..3, j 2..3
  assert.equal(validatePlacement(p, "rug_rag", 0, 9).error, "out_of_bounds"); // 2 deep: j 9..10
});

test("placement: unowned, unknown and non-placeable items", () => {
  const p = fresh();
  assert.equal(validatePlacement(p, "fur_seed_bowl", 0, 0).error, "unowned");
  own(p, "fur_seed_bowl", 1);
  p.placed.push({ pid: "b1", item: "fur_seed_bowl", x: 0, y: 0, flip: false });
  assert.equal(validatePlacement(p, "fur_seed_bowl", 1, 0).error, "unowned"); // only one copy
  assert.ok(validatePlacement(p, "fur_seed_bowl", 1, 0, "b1").ok); // but it can move
  assert.equal(validatePlacement(p, "nope", 0, 0).error, "unknown_item");
  assert.equal(validatePlacement(p, "skin_classic", 0, 0).error, "not_placeable");
  assert.equal(validatePlacement(p, "wheel_t1", 0, 0).error, "not_placeable");
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
  assert.equal(certEligible(fresh({ lifetimeWatts: 499_999, activeDays: 30 })), false);
  assert.equal(certEligible(fresh({ lifetimeWatts: 1_000_000, activeDays: 6 })), false);
  assert.equal(certEligible(fresh({ lifetimeWatts: 500_000, activeDays: 7 })), true);
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
  Object.assign(p, { lifetimeWatts: 600_000, activeDays: 9, wheelTier: 3 });
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
  assert.deepEqual(c.room, { wallpaper: "wp_plain", floor: "fl_straw", placed: [{ item: "fur_sofa", x: 8, y: 11, flip: true }] });
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
  assert.equal(BALANCE.IDLE_AFTER_MS, 90_000);
  for (const k of Object.keys(BALANCE)) assert.ok(!k.startsWith("MANUAL_"), `wheel duty key ${k} is gone`);
  assert.equal(chainIdle(T0 - 60_000, T0), false); // a block 1 min ago
  assert.equal(chainIdle(null, T0), false); // height never observed
  assert.equal(chainIdle(T0 - BALANCE.IDLE_AFTER_MS + 1, T0), false);
  assert.equal(chainIdle(T0 - BALANCE.IDLE_AFTER_MS, T0), true); // exactly 90 s quiet
  const asleep = T0 - BALANCE.IDLE_AFTER_MS - 60_000;
  assert.equal(chainIdle(asleep, T0, T0 - 10_000), true); // live mode, fresh chain read
  assert.equal(chainIdle(asleep, T0, T0 - 600_000), false); // live mode, stale read
  assert.equal(chainIdle(asleep, T0, 0), false);
  assert.equal(chainIdle(asleep, T0, null), true); // demo mode: no freshness check
});

// ---------- bed income ----------
test("bed: balance constants", () => {
  assert.equal(BALANCE.BED_AWAKE_PCT, 50);
  assert.deepEqual(BALANCE.BED_MULT_PCT, [100, 125, 160, 200, 260, 350]);
  assert.equal(BALANCE.BED_TICK_MAX_MS, 60_000);
  assert.equal(S.bedWattsPerMin(fresh()), 20); // 50% of 10 W/block x the 4 blocks/min live baseline
  assert.equal(S.bedWattsPerMin(fresh({ bedTier: 5 })), 70);
  assert.equal(S.bedMultPct(fresh({ bedTier: 3 })), 200);
});

test("bed: 20 W/min (live baseline) x bed multiplier x watching bonus", () => {
  const ten = 10 * 60_000;
  assert.equal(S.bedCredit(fresh(), ten, T0), 200);
  for (const [tier, per10] of [[1, 250], [2, 320], [3, 400], [4, 520], [5, 700]]) {
    const p = fresh({ bedTier: tier });
    assert.equal(S.bedCredit(p, ten, T0), per10, `tier ${tier}`);
    assert.equal(p.lifetimeWatts, per10);
  }
  const w = fresh({ lastHeartbeat: T0 - 30_000 }); // watching: 1.2x
  assert.equal(S.bedCredit(w, ten, T0), 240);
  const w5 = fresh({ bedTier: 5, lastHeartbeat: T0 });
  assert.equal(S.bedCredit(w5, ten, T0), 840); // 20 x 3.5 x 1.2 x 10
  assert.equal(S.bedCredit(fresh(), 0, T0), 0);
  assert.equal(S.bedCredit(fresh(), -5, T0), 0);
});

test("bed: fractional carry is exact (integers only, nothing lost)", () => {
  const p = fresh();
  assert.equal(S.bedCredit(p, 1_500, T0), 0); // 0.5 W -> nothing now, 0.5 carried
  assert.equal(p.bedFrac, S.BED_FRAC_DEN / 2);
  assert.equal(S.bedCredit(p, 1_500, T0), 1); // 0.5 + 0.5
  assert.equal(p.bedFrac, 0);
  assert.equal(p.watts, W0 + 1);
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
    const exact = (ms * 200 * BALANCE.BED_MULT_PCT[tier] * bonus * 100) / S.BED_FRAC_DEN; // x100: no Deep Sleep
    assert.equal(q.lifetimeWatts, Math.floor(exact), `tier ${tier}`);
    assert.equal(q.watts, W0 + q.lifetimeWatts);
  }
});

test("accrueBed: every player while asleep, 60 s cap per tick, nothing while awake", () => {
  const st = { lastBedTickAt: null, players: { a: fresh(), b: fresh({ bedTier: 3 }), live: fresh({ lastHeartbeat: T0 }) } };
  assert.equal(S.accrueBed(st, true, T0), 0); // first tick only starts the clock
  assert.equal(st.lastBedTickAt, T0);
  S.accrueBed(st, true, T0 + 60_000);
  assert.equal(st.players.a.lifetimeWatts, 20);
  assert.equal(st.players.b.lifetimeWatts, 40); // 20 x 2
  assert.equal(st.players.live.lifetimeWatts, 24); // 20 x 1.2
  // a 10-minute gap credits only 60 s
  S.accrueBed(st, true, T0 + 11 * 60_000);
  assert.equal(st.players.b.lifetimeWatts, 80);
  assert.equal(st.lastBedTickAt, T0 + 11 * 60_000);
  // awake: no watts, but the clock moves (the awake stretch is never paid later)
  assert.equal(S.accrueBed(st, false, T0 + 20 * 60_000), 0);
  assert.equal(st.players.b.lifetimeWatts, 80);
  S.accrueBed(st, true, T0 + 20 * 60_000 + 30_000); // asleep again: only the last 30 s count
  assert.equal(st.players.b.lifetimeWatts, 100); // + 20
  // a clock that steps backwards credits nothing
  const before = st.players.b.lifetimeWatts;
  assert.equal(S.accrueBed(st, true, T0), 0);
  assert.equal(st.players.b.lifetimeWatts, before);
});

// ---------- bed + room ladders ----------
test("catalog: bed and room ladders (tiers 1..5, not placeable); teacup bed stays a cosmetic", () => {
  const beds = CATALOG.filter((i) => i.cat === "bed");
  assert.deepEqual(beds.map((b) => b.id), ["bed_t1", "bed_t2", "bed_t3", "bed_t4", "bed_t5"]);
  assert.deepEqual(beds.map((b) => b.price), [6000, 20000, 60000, 160000, 400000]);
  assert.deepEqual(beds.map((b) => b.multPct), [125, 160, 200, 260, 350]);
  const rooms = CATALOG.filter((i) => i.cat === "room");
  assert.deepEqual(rooms.map((r) => r.tier), [1, 2, 3, 4, 5]);
  assert.deepEqual(rooms.map((r) => r.price), [20000, 60000, 160000, 400000, 900000]);
  assert.deepEqual(rooms.map((r) => r.material), ["Stone", "Iron", "Silver", "Gold", "Diamond"]);
  for (const i of [...beds, ...rooms]) assert.equal(i.zone, null);
  const teacup = S.CATALOG_BY_ID.get("fur_teacup_bed");
  assert.equal(teacup.cat, "furniture");
  assert.equal(teacup.price, 7000);
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
  assert.equal(p.watts, 1_000_000 - 6000 - 20000);
  assert.equal(p.wheelTier, 0); // ladders are independent
  assert.equal(p.roomTier, 0);
  assert.equal(validatePlacement(p, "bed_t1", 0, 11).error, "not_placeable");
  const r = canBuy(fresh(), "bed_t3");
  assert.equal(r.error, "wrong_tier"); // tier order is checked before price
  assert.equal(canBuy(fresh({ bedTier: 2 }), "bed_t3").need, 60_000 - W0);
  // the new bed raises bed income right away
  assert.equal(S.bedCredit(p, 10 * 60_000, T0), 320);
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
  assert.equal(p.watts, 1_000_000 - 20000 - 60000);
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
  assert.equal(pub.bedWattsPerMin, 32);
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
// Three rooms while he runs: atk and def at 10k, poor at 1k, each having earned exactly enough to raid.
function raidWorld(over = {}) {
  const st = { lastAdvanceAt: T0 - 60_000, burned: 0, raidFeed: [], players: {} };
  for (const [t, nick, watts] of [[TA, "atk", 10_000], [TB, "def", 10_000], [TC, "poor", 1_000]]) {
    st.players[t] = Object.assign(S.newPlayer(1000, T0, t), { nick, watts, lifetimeWatts: RA.MIN_EARNED }, over[nick] || {});
  }
  return st;
}
const supply = (st) => Object.values(st.players).reduce((s, p) => s + p.watts, 0) + st.burned;
const raid = (st, token, target, stake, mult, now = T0, rng = seq(LOSE)) => S.applyRaid(st, token, { target: pidOf(target), stake, mult }, now, { rng });

test("raid: balance knobs", () => {
  assert.equal(RA.EDGE_PCT, 110);
  assert.deepEqual(RA.MULT_PCT, [150, 200, 300, 500, 1000]);
  assert.deepEqual(RA.DEFENSE_PCT, [0, 5, 10, 15, 20, 25]);
  assert.equal(RA.DEF_SHARE_PCT, undefined); // failed raids pay the defender nothing
  assert.equal(RA.MIN_EARNED, 5000);
  assert.deepEqual([RA.TILT_EXP, RA.TILT_MIN_PCT, RA.TILT_MAX_PCT, RA.P_MIN_PCT, RA.P_MAX_PCT], [0.25, 75, 175, 2, 90]);
  assert.deepEqual([RA.LOOT_U_MIN_PCT, RA.LOOT_U_MAX_PCT, RA.CRIT_CHANCE_PCT, RA.CRIT_MULT_PCT], [75, 125, 5, 150]);
  assert.deepEqual([RA.STAKE_MIN, RA.STAKE_MIN_BAL_PCT, RA.LOOT_MAX_DEF_PCT, RA.ELIGIBLE_MIN_PCT], [50, 5, 25, 70]);
  assert.equal(RA.STAKE_MAX, undefined); // the max comes from the balance and the target's loot cap
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
  const tilt = S.wealthTilt(10_000, 8000); // a poorer target: no punch-up floor
  for (let tier = 0; tier <= 5; tier++) {
    const d = fresh({ watts: 8000, roomTier: tier });
    near(S.raidChance(a, d, 200), 0.55 * (1 - [0, 0.05, 0.1, 0.15, 0.2, 0.25][tier]) * tilt, `tier ${tier}`);
  }
});

test("raidChance: punching up (target >= your watts) never drops below 1/M", () => {
  const a = fresh({ watts: 10_000 });
  for (const m of RA.MULT_PCT) {
    for (let tier = 0; tier <= 5; tier++) {
      const raw = (1.1 / (m / 100)) * (1 - RA.DEFENSE_PCT[tier] / 100);
      near(S.raidChance(a, fresh({ watts: 10_000, roomTier: tier }), m), Math.max(raw, 100 / m), `equal M=${m} T${tier}`);
      // one watt poorer: a peer raid, the floor is off
      const peer = S.raidChance(a, fresh({ watts: 9999, roomTier: tier }), m);
      near(peer, raw * S.wealthTilt(10_000, 9999), `peer M=${m} T${tier}`);
    }
  }
  // a diamond room at equal wealth: the floor wins at every multiplier
  for (const m of RA.MULT_PCT) near(S.raidChance(a, fresh({ watts: 10_000, roomTier: 5 }), m), 100 / m);
  // revenge on a much poorer diamond room stays below 1/M
  near(S.raidChance(a, fresh({ watts: 100, roomTier: 5 }), 200), 0.55 * 0.75 * 0.75);
  // a rich wood target is already above the floor: unchanged
  near(S.raidChance(a, fresh({ watts: 20_000 }), 300), (1.1 / 3) * Math.pow(2, 0.25));
  // raidOdds without the flag is the plain formula
  near(S.raidOdds(1000, 25, 1), 0.0825);
  near(S.raidOdds(1000, 25, 1, true), 0.1);
});

test("raidChance: wealth tilt (def/atk)^0.25, capped to [0.75, 1.75]", () => {
  near(S.wealthTilt(1000, 1000), 1);
  near(S.wealthTilt(1000, 2000), Math.pow(2, 0.25));
  near(S.wealthTilt(2000, 1000), Math.pow(0.5, 0.25));
  near(S.wealthTilt(1000, 9000), Math.pow(9, 0.25)); // 1.732: just under the cap
  assert.equal(S.wealthTilt(1000, 16_000), 1.75); // 16^.25 = 2 -> cap
  assert.equal(S.wealthTilt(1000, 1e12), 1.75);
  assert.equal(S.wealthTilt(16_000, 1000), 0.75); // 0.5 -> floor
  assert.equal(S.wealthTilt(1e12, 1), 0.75);
  assert.equal(S.wealthTilt(0, 500), 1.75); // broke attacker: Infinity -> cap
  assert.equal(S.wealthTilt(500, 0), 0.75);
  assert.equal(S.wealthTilt(0, 0), 1);
  // through raidChance: a 10x punch-up at M=10 in a wood room = 0.11 x 1.75
  near(S.raidChance(fresh({ watts: 1000 }), fresh({ watts: 10_000 }), 1000), 0.1925);
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
  for (let tier = 0; tier <= 5; tier++) {
    const loss = S.resolveRaid(a, fresh({ watts: 10_000, roomTier: tier }), 999, 300, seq(LOSE));
    assert.deepEqual(loss, { win: false, p: loss.p, stakeLost: 999 }, `tier ${tier}`); // no share at any tier
  }
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

test("applyRaid: a loss burns the stake (a wood room gets nothing)", () => {
  const st = raidWorld({ atk: { lifetimeWatts: 5000, activeDays: 3 }, def: { watts: 100_000 } });
  const before = supply(st);
  const r = raid(st, TA, TB, 2000, 10, T0, seq(LOSE));
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { win: false, p: S.raidChance(fresh({ watts: 10_000 }), fresh({ watts: 100_000 }), 1000), stakeLost: 2000, stake: 2000, multPct: 1000, revenge: false, raidsLeft: RA.PER_DAY - 1 });
  assert.equal(st.players[TA].watts, 8000);
  assert.equal(st.players[TB].watts, 100_000);
  assert.equal(st.burned, 2000);
  assert.equal(supply(st), before);
  assert.deepEqual([st.players[TA].lifetimeWatts, st.players[TA].activeDays], [5000, 3]);
  assert.deepEqual([r.feed.win, r.feed.amount, r.feed.crit, r.feed.share], [false, 2000, false, undefined]);
  assert.equal(st.players[TB].raidedBy.length, 1); // a failed raid still counts as a provocation
  // a state object without the raid fields still works (burned/raidFeed start lazily)
  const bare = raidWorld();
  delete bare.burned;
  delete bare.raidFeed;
  assert.ok(raid(bare, TA, TB, 500, 2).ok);
  assert.equal(bare.burned, 500);
  assert.equal(bare.raidFeed.length, 1);
});

test("applyRaid: a failed raid pays the defender 0 at every room tier; the whole wager burns", () => {
  for (let tier = 0; tier <= 5; tier++) {
    const st = raidWorld({ def: { watts: 100_000, roomTier: tier, lifetimeWatts: 7000 } });
    const before = supply(st);
    const r = raid(st, TA, TB, 2001, 3, T0, seq(LOSE));
    assert.equal(r.ok, true);
    assert.deepEqual([r.result.win, r.result.stakeLost, r.result.defShare, r.feed.share, r.feed.amount], [false, 2001, undefined, undefined, 2001], `tier ${tier}`);
    assert.equal(st.players[TA].watts, 10_000 - 2001);
    assert.equal(st.players[TB].watts, 100_000, `tier ${tier}: defender unpaid`);
    assert.equal(st.burned, 2001);
    assert.equal(supply(st), before);
    assert.equal(st.players[TB].lifetimeWatts, 7000);
  }
});

// Expected value of one raid, through the real resolveRaid: the win roll forced, the loot roll U
// integrated at N midpoints (the floor() steps included), crit and no-crit weighted by their odds.
function raidEV(atkW, defW, tier, stake, m, N = 2000) {
  const a = fresh({ watts: atkW }), d = fresh({ watts: defW, roomTier: tier });
  const p = S.raidChance(a, d, m);
  const crit = RA.CRIT_CHANCE_PCT / 100;
  let loot = 0;
  for (let k = 0; k < N; k++) {
    const u = (k + 0.5) / N;
    loot += (1 - crit) * S.resolveRaid(a, d, stake, m, seq(WIN, u, 0.99)).loot + crit * S.resolveRaid(a, d, stake, m, seq(WIN, u, 0)).loot;
  }
  loot /= N;
  return { atk: p * loot - (1 - p) * stake, def: -p * loot, p }; // a failed raid pays the defender nothing
}
// every allowed stake shape: the minimum, the middle, the maximum, and odd values near both
const stakesFor = (b) => (b.max < b.min ? [] : [...new Set([b.min, b.min + 1, Math.floor((b.min + b.max) / 2), b.max - 1, b.max].filter((s) => s >= b.min && s <= b.max))]);

test("raid EV: punching up is never -EV for the attacker, whatever the tier, multiplier or stake", () => {
  let checked = 0;
  for (const atkW of [1000, 10_000, 1_000_000]) {
    for (const ratio of [1, 1.0001, 1.2, 1.5, 2, 4, 9.4, 50]) {
      const defW = Math.ceil(atkW * ratio);
      for (let tier = 0; tier <= 5; tier++) {
        for (const m of RA.MULT_PCT) {
          for (const s of stakesFor(S.stakeBounds(atkW, defW, m))) {
            const ev = raidEV(atkW, defW, tier, s, m, s < 200 ? 4000 : 400);
            assert.ok(ev.atk > 0, `atk=${atkW} def=${defW} T${tier} M=${m} S=${s}: EV ${ev.atk}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 500, `${checked} cases`);
  // the worst spot (the floor binds, smallest stake, 1.5x) is still just above break-even
  const worst = raidEV(1000, 1000, 5, 50, 150, 20_000);
  assert.ok(worst.atk > 0 && worst.atk < 0.2, `worst ${worst.atk}`);
  // below your own watts the floor is off: a strong peer room or a poor revenge target can cost you
  assert.ok(raidEV(10_000, 9000, 5, 1000, 300).atk < 0);
  assert.ok(raidEV(10_000, 3000, 0, 500, 150).atk < 0);
});

test("raid EV: being raided is never +EV for the defender", () => {
  let checked = 0;
  for (const atkW of [1000, 10_000, 1_000_000]) {
    for (const ratio of [0.13, 0.3, 0.7, 1, 2, 9.4, 50]) { // below 0.7 = revenge raids
      const defW = Math.ceil(atkW * ratio);
      for (let tier = 0; tier <= 5; tier++) {
        for (const m of RA.MULT_PCT) {
          for (const s of stakesFor(S.stakeBounds(atkW, defW, m))) {
            const ev = raidEV(atkW, defW, tier, s, m, 400);
            assert.ok(ev.def < 0, `atk=${atkW} def=${defW} T${tier} M=${m} S=${s}: defender EV ${ev.def}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 500, `${checked} cases`);
});

test("applyRaid fuzz: watts + burned conserved, integers only, lifetime never moves", () => {
  const rng = prng(42);
  const tokens = Array.from({ length: 8 }, (_, i) => String.fromCharCode(97 + i).repeat(20) + "x".repeat(12));
  const st = { lastAdvanceAt: T0 - 60_000, burned: 0, raidFeed: [], players: {} };
  for (const [i, t] of tokens.entries()) st.players[t] = Object.assign(S.newPlayer(1000, T0, t), { watts: 2000 + i * 3000, lifetimeWatts: RA.MIN_EARNED + 100 * i, activeDays: i, roomTier: i % 6 });
  const supply0 = supply(st);
  const life = tokens.map((t) => st.players[t].lifetimeWatts);
  let wins = 0, losses = 0;
  for (let n = 0; n < 2000; n++) {
    const atk = tokens[Math.floor(rng() * tokens.length)];
    const def = tokens[Math.floor(rng() * tokens.length)];
    st.players[atk].raidsToday = 0; // skip the daily allowance for the fuzz
    for (const t of tokens) st.players[t].shield.until = 0; // and the bruise shields (all raids share one instant)
    const mult = RA.MULT_PCT[Math.floor(rng() * 5)];
    const { min, max } = S.stakeBounds(st.players[atk].watts, st.players[def].watts, mult);
    // mostly in range (some at either bound); every 10th draw is anywhere, so refusals get fuzzed too
    const stake = n % 10 === 9 ? Math.floor(rng() * 3 * (max + 1)) : min + Math.floor(rng() * Math.max(1, max - min + 1));
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

test("raid stake bounds: min max(50, 5% of balance); max the balance or the target's loot cap", () => {
  // balance only
  assert.deepEqual(S.stakeBounds(10_000), { min: 500, max: 10_000, limit: "balance" });
  assert.deepEqual(S.stakeBounds(10_004.7), { min: 501, max: 10_004, limit: "balance" }); // floor, then 5% rounded up
  assert.deepEqual(S.stakeBounds(1e9), { min: 5e7, max: 1e9, limit: "balance" });
  assert.deepEqual(S.stakeBounds(999), { min: 50, max: 999, limit: "balance" }); // 5% < 50
  assert.deepEqual(S.stakeBounds(1001), { min: 51, max: 1001, limit: "balance" });
  assert.deepEqual(S.stakeBounds(49), { min: 50, max: 49, limit: "balance" }); // too poor to raid
  // with a target: cap 25k (100k room) / ((M - 1) x 1.25)
  assert.deepEqual(S.stakeBounds(10_000, 100_000, 1000), { min: 500, max: 2222, limit: "target" });
  assert.deepEqual(S.stakeBounds(10_000, 100_000, 500), { min: 500, max: 5000, limit: "target" });
  assert.deepEqual(S.stakeBounds(10_000, 100_000, 300), { min: 500, max: 10_000, limit: "balance" }); // exactly 10k
  assert.deepEqual(S.stakeBounds(10_000, 100_000, 150), { min: 500, max: 10_000, limit: "balance" });
  assert.deepEqual(S.stakeBounds(10_000, 10_000, 1000), { min: 500, max: 222, limit: "target" }); // no 10x into a peer
  assert.deepEqual(S.stakeBounds(10_000, 0, 200), { min: 500, max: 0, limit: "target" });
  // at max the top loot roll fits under the cap; one more watt would not
  for (const defW of [1, 199, 4800, 10_000, 77_777, 1e6, 123_456_789]) {
    for (const m of RA.MULT_PCT) {
      const { max } = S.stakeBounds(1e12, defW, m), cap = S.lootCap(defW);
      assert.ok((m - 100) * max * RA.LOOT_U_MAX_PCT <= cap * 10_000, `fits def=${defW} M=${m}`);
      assert.ok((m - 100) * (max + 1) * RA.LOOT_U_MAX_PCT > cap * 10_000, `tight def=${defW} M=${m}`);
      if (max > 0) assert.ok(S.resolveRaid(fresh({ watts: 1e12 }), fresh({ watts: defW }), max, m, seq(WIN, 0.999999999, 0.99)).loot <= cap);
    }
  }
  const st = raidWorld(); // 10k vs 10k at 2x: [500, 2000]
  for (const s of [499, 0, -100, 2001, 10_001]) {
    const r = raid(st, TA, TB, s, 2);
    assert.deepEqual([r.ok, r.error, r.min, r.max, r.limit], [false, "stake_out_of_range", 500, 2000, "target"], `stake ${s}`);
  }
  for (const s of [500.5, "500", null, undefined, NaN, Infinity]) {
    const r = raid(st, TA, TB, s, 2);
    assert.deepEqual([r.error, r.min, r.max, r.limit], ["bad_stake", 500, 2000, "target"], `stake ${s}`);
  }
  assert.deepEqual([raid(st, TA, TB, 500, 10).error, raid(st, TA, TB, 500, 10).max], ["stake_out_of_range", 222]); // 10x is out of reach here
  assert.equal(st.players[TA].watts, 10_000); // nothing moved on a refusal
  assert.equal(st.players[TA].raidsToday, 0);
  assert.ok(raid(st, TA, TB, 500, 2).ok); // the minimum
  assert.ok(raid(st, TA, TB, 2000, 2).ok); // the target-limited maximum
  const rich = raidWorld({ def: { watts: 1e9 } });
  assert.ok(raid(rich, TA, TB, 10_000, 2).ok); // all in, when the target is rich enough
  assert.equal(rich.players[TA].watts, 0);
  const broke = raidWorld({ atk: { watts: 40 }, def: { watts: 200 } });
  assert.deepEqual([raid(broke, TA, TB, 50, 2).error, raid(broke, TA, TB, 50, 2).limit], ["stake_out_of_range", "balance"]);
});

test("raid multiplier: 1.5/2/3/5/10 or their percentages, nothing else", () => {
  for (const [v, pct] of [[1.5, 150], [2, 200], [3, 300], [5, 500], [10, 1000], [150, 150], [1000, 1000]]) assert.equal(S.parseMultPct(v), pct, `${v}`);
  for (const v of [1, 4, 1.25, 100, 2.0001, "2", null, NaN, Infinity, -2]) assert.equal(S.parseMultPct(v), null, `${v}`);
  const st = raidWorld();
  assert.equal(raid(st, TA, TB, 500, 4).error, "bad_mult");
  assert.equal(raid(st, TA, TB, 500, "3").error, "bad_mult");
  assert.equal(raid(st, TA, TB, 500, 1.5).result.multPct, 150);
});

test("raid allowance: 10 per attacker per UTC day, being raided is unlimited", () => {
  const st = raidWorld({ def: { watts: 1e9 } });
  const day = Date.UTC(2026, 9, 31, 10, 0, 0);
  const at = (t) => ((st.lastAdvanceAt = t - 1000), t); // keep him running
  for (let n = 0; n < RA.PER_DAY; n++) assert.ok(raid(st, TA, TB, 500, 2, at(day + n)).ok, `raid ${n}`);
  const r = raid(st, TA, TB, 500, 2, at(day + 20));
  assert.deepEqual([r.ok, r.error, r.resetMs], [false, "no_raids_left", 14 * 3600_000 - 20]);
  assert.deepEqual(S.raidStatus(st, st.players[TA], day + 60_000), { open: true, raidsLeft: 0, perDay: RA.PER_DAY, resetMs: 14 * 3600_000 - 60_000, ready: true, earned: RA.MIN_EARNED, needEarned: RA.MIN_EARNED, shielded: false });
  // others can still raid the same room
  for (let n = 0; n < 3; n++) assert.ok(raid(st, TC, TB, 100, 2, at(day + 100 + n)).ok);
  // the count resets at 00:00 UTC
  const next = Date.UTC(2026, 10, 1, 0, 0, 0);
  assert.equal(S.raidsLeft(st.players[TA], next - 1), 0);
  assert.equal(S.raidsLeft(st.players[TA], next), RA.PER_DAY);
  const ok = raid(st, TA, TB, 250, 2, at(next)); // 10 lost stakes left 5000: the 5% minimum is now 250
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
  assert.deepEqual(S.raidStatus(st, st.players[TA], T0), { open: false, raidsLeft: RA.PER_DAY, perDay: RA.PER_DAY, resetMs: 86_400_000 - (T0 % 86_400_000), ready: true, earned: RA.MIN_EARNED, needEarned: RA.MIN_EARNED, shielded: false });
  const body = { target: pidOf(TB), stake: 500, mult: 2 };
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
  st.players[late] = Object.assign(S.newPlayer(1000, T0, late), { watts: 50_000, lifetimeWatts: RA.MIN_EARNED });
  assert.equal(S.tokenForPublicId(st, pidOf(late)), late);
  assert.ok(raid(st, TB, late, 500, 2).ok);
});

test("raid revenge: waives the 70% rule once per provocation, expires after 24 h", () => {
  const st = raidWorld({ poor: { watts: 5000 } }); // under 70% of 10k, big enough for a 500 W revenge at 2x
  const [rich, poor] = [st.players[TA], st.players[TC]];
  const at = (t) => ((st.lastAdvanceAt = t - 1000), t);
  assert.equal(raid(st, TA, TC, 500, 2, at(T0)).error, "not_eligible");
  assert.ok(raid(st, TC, TA, 500, 2, at(T0), seq(LOSE)).ok); // poor provokes (and fails)
  assert.deepEqual(rich.raidedBy, [{ pid: poor.publicId, at: T0, avenged: false }]);
  const row = S.leaderboard(st, TA, T0 + 1000).rows.find((r) => r.publicId === poor.publicId);
  assert.deepEqual([row.raidable, row.revenge], [true, true]);
  const r = raid(st, TA, TC, 500, 2, at(T0 + 1000), seq(LOSE));
  assert.equal(r.ok, true);
  assert.equal(r.result.revenge, true);
  assert.equal(rich.raidedBy[0].avenged, true); // consumed
  rich.lastRaidAt = 0;
  assert.equal(raid(st, TA, TC, 500, 2, at(T0 + 2000)).error, "not_eligible"); // only once
  // a fresh provocation grants a fresh revenge
  poor.lastRaidAt = 0;
  assert.ok(raid(st, TC, TA, 500, 2, at(T0 + 3000), seq(LOSE)).ok);
  rich.lastRaidAt = 0;
  assert.equal(raid(st, TA, TC, 500, 2, at(T0 + 4000), seq(LOSE)).result.revenge, true);
  // expiry: 24 h after the provocation it is gone
  const st2 = raidWorld({ poor: { watts: 5000 } });
  const at2 = (t) => ((st2.lastAdvanceAt = t - 1000), t);
  assert.ok(raid(st2, TC, TA, 500, 2, at2(T0), seq(LOSE)).ok);
  assert.equal(raid(st2, TA, TC, 500, 2, at2(T0 + RA.REVENGE_WINDOW_MS)).error, "not_eligible");
  assert.equal(S.leaderboard(st2, TA, T0 + RA.REVENGE_WINDOW_MS).rows.find((x) => x.publicId === pidOf(TC)).raidable, false);
  assert.equal(raid(st2, TA, TC, 500, 2, at2(T0 + RA.REVENGE_WINDOW_MS - 1), seq(LOSE)).result.revenge, true);
  // a raid that didn't need the waiver leaves the provocation pending
  const st3 = raidWorld();
  assert.ok(raid(st3, TB, TA, 500, 2, T0, seq(LOSE)).ok);
  const plain = raid(st3, TA, TB, 500, 2, T0, seq(LOSE));
  assert.equal(plain.result.revenge, false);
  assert.equal(st3.players[TA].raidedBy[0].avenged, false);
  // revenge on a far poorer room: eligible, but its loot cap leaves no stake at or above your minimum
  const st4 = raidWorld(); // poor: 900 W after its failed raid, cap 225, so even 1.5x stops at 360 W (< 500 W min)
  assert.ok(raid(st4, TC, TA, 100, 2, T0, seq(LOSE)).ok);
  assert.equal(S.raidEligibility(st4.players[TA], st4.players[TC], T0).ok, true);
  for (const m of RA.MULT_PCT) {
    const b = S.stakeBounds(st4.players[TA].watts, st4.players[TC].watts, m);
    assert.ok(b.max < b.min && b.limit === "target", `M=${m}`);
  }
  assert.deepEqual([raid(st4, TA, TC, 500, 1.5).error, st4.players[TA].raidedBy[0].avenged], ["stake_out_of_range", false]); // not used up
});

test("raid ring buffers: raidedBy keeps 20 (24 h), the feed keeps 50", () => {
  const st = raidWorld({ def: { watts: 1e9 } });
  for (let i = 0; i < 60; i++) {
    st.players[TA].raidsToday = 0;
    st.players[TA].watts = 10_000; // keep the 5% minimum at 500
    assert.ok(raid(st, TA, TB, 500 + i, 2, T0 + i, seq(LOSE)).ok);
  }
  const d = st.players[TB];
  assert.equal(d.raidedBy.length, RA.RAIDED_BY_MAX);
  assert.equal(d.raidedBy.at(-1).at, T0 + 59);
  assert.equal(st.raidFeed.length, RA.FEED_MAX);
  assert.equal(st.raidFeed.at(-1).amount, 559); // newest last
  assert.equal(st.raidFeed[0].amount, 510); // the oldest 10 dropped
  for (const e of st.raidFeed) assert.deepEqual(Object.keys(e).sort(), ["amount", "at", "atk", "atkId", "crit", "def", "defId", "win"]);
  // entries older than the revenge window are pruned on the next raid
  const later = T0 + RA.REVENGE_WINDOW_MS + 100;
  st.lastAdvanceAt = later;
  assert.ok(raid(st, TC, TB, 100, 2, later, seq(LOSE)).ok);
  assert.deepEqual(d.raidedBy.map((e) => e.pid), [pidOf(TC)]);
});

test("leaderboard: by balance, shape, per-viewer raidable/you flags, 10 s cache, 200 rows", () => {
  const st = raidWorld({ atk: { lifetimeWatts: 9000, roomTier: 2 }, def: { watts: 20_000 }, poor: { watts: 8000 } });
  const lb = S.leaderboard(st, TA, T0);
  assert.deepEqual(lb.rows.map((r) => r.nick), ["def", "atk", "poor"]);
  assert.deepEqual(lb.rows[1], { rank: 2, publicId: pidOf(TA), nick: "atk", name: "atk", verified: false, watts: 10_000, lifetimeWatts: 9000, roomTier: 2, fresh: false, shielded: false, raidable: false, revenge: false, you: true });
  assert.deepEqual(lb.rows.map((r) => r.raidable), [true, false, true]); // 8k >= 70% of 10k
  assert.deepEqual(lb.raid, { open: true, raidsLeft: RA.PER_DAY, perDay: RA.PER_DAY, resetMs: 86_400_000 - (T0 % 86_400_000), ready: true, earned: 9000, needEarned: RA.MIN_EARNED, shielded: false });
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
  assert.ok(raid(st, TA, TB, 1000, 5, T0 + 1, seq(WIN, 0.999999, 0.01)).ok); // 4 x 1000 x 1.25 x 1.5 -> capped at 25% of 20k
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
    st.players[t] = Object.assign(S.newPlayer(1000, T0, t), { nick, watts, lifetimeWatts: RA.MIN_EARNED });
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

test("username: no wallet needed, 3-16 of [A-Za-z0-9_], unique ignoring case, may change", () => {
  const st = walletWorld();
  assert.ok(S.setUsername(st, TC, { username: "NoWallet" }).ok, "no wallet needed for a username");
  assert.equal(st.players[TC].wallet, null);
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
  const r = raid(st, TA, TB, 500, 2, T0, seq(LOSE));
  assert.ok(r.ok);
  assert.deepEqual([r.feed.atk, r.feed.def], ["Raider", "def"]);
  assert.ok(signIn(st, TB, KEY_B).ok);
  assert.ok(S.setUsername(st, TB, { username: "Guard" }).ok);
  st.players[TA].lastRaidAt = 0;
  const r2 = raid(st, TA, TB, 500, 2, T0 + 1, seq(LOSE));
  assert.deepEqual([r2.feed.atk, r2.feed.def], ["Raider", "Guard"]);
  assert.deepEqual([st.raidFeed[0].atk, st.raidFeed[0].def], ["Raider", "def"]); // older entries keep the old name
  for (const e of st.raidFeed) assert.deepEqual(Object.keys(e).sort(), ["amount", "at", "atk", "atkId", "crit", "def", "defId", "win"]);
});

// ---------- v3 patch 1: earned-watts floor for raids ----------
test("raid floor: a den raids and can be raided only after earning MIN_EARNED (welcome watts don't count)", () => {
  // a brand-new den holds the welcome grant but has earned nothing
  const n = S.newPlayer(1000, T0, TA);
  assert.deepEqual([n.watts, n.lifetimeWatts, S.raidReady(n)], [BALANCE.WELCOME_WATTS, 0, false]);
  // fresh attacker: refused, nothing moves, no raid used
  const st = raidWorld({ atk: { lifetimeWatts: RA.MIN_EARNED - 1 } });
  const r = raid(st, TA, TB, 500, 2);
  assert.deepEqual([r.ok, r.error, r.reason, r.needEarned, r.earned], [false, "not_eligible", "fresh_attacker", 5000, 4999]);
  assert.deepEqual([st.players[TA].watts, st.players[TA].raidsToday, st.burned], [10_000, 0, 0]);
  assert.deepEqual(S.raidStatus(st, st.players[TA], T0).ready, false);
  // fresh target: refused and not offered as a target, even to a revenge
  const st2 = raidWorld({ def: { lifetimeWatts: 0, watts: 50_000 } });
  const r2 = raid(st2, TA, TB, 500, 2);
  assert.deepEqual([r2.ok, r2.error, r2.reason], [false, "not_eligible", "fresh_target"]);
  assert.deepEqual([st2.players[TA].watts, st2.players[TA].raidsToday], [10_000, 0]);
  const row = S.leaderboard(st2, TA, T0).rows.find((x) => x.publicId === pidOf(TB));
  assert.deepEqual([row.fresh, row.raidable], [true, false]);
  st2.players[TA].raidedBy = [{ pid: pidOf(TB), at: T0 - 1000, avenged: false }];
  S.invalidateLeaderboard(st2);
  assert.equal(S.leaderboard(st2, TA, T0).rows.find((x) => x.publicId === pidOf(TB)).raidable, false);
  // a fresh viewer sees no targets at all (the leaderboard itself is unchanged)
  const st3 = raidWorld({ atk: { lifetimeWatts: 10 } });
  const lb = S.leaderboard(st3, TA, T0);
  assert.equal(lb.rows.length, 3);
  assert.ok(lb.rows.every((x) => !x.raidable));
  assert.deepEqual([lb.raid.ready, lb.raid.earned, lb.raid.needEarned], [false, 10, 5000]);
});

test("raid floor: crossing MIN_EARNED through income makes a den eligible both ways", () => {
  const st = raidWorld({ atk: { lifetimeWatts: 0 }, def: { lifetimeWatts: 0 } });
  const a = st.players[TA], d = st.players[TB];
  assert.equal(raid(st, TA, TB, 500, 2).reason, "fresh_attacker");
  // 499 blocks at tier 0 x 10 W, not watching: 4,990 W earned
  S.accrue(a, 499, T0);
  assert.deepEqual([a.lifetimeWatts, S.raidReady(a)], [4990, false]);
  S.accrue(a, 1, T0);
  assert.deepEqual([a.lifetimeWatts, S.raidReady(a)], [5000, true]);
  assert.equal(raid(st, TA, TB, 500, 2).reason, "fresh_target"); // the target still hasn't earned enough
  S.bedCredit(d, 300 * 60_000, T0); // bed income counts too (20 W/min live at tier 0)
  assert.ok(d.lifetimeWatts >= RA.MIN_EARNED, String(d.lifetimeWatts));
  assert.ok(raid(st, TA, TB, 1000, 2).ok); // earning lifted the balance to 15k: the 5% minimum is 750
  // raid loot is not earnings: a den can't reach the floor by being handed watts
  const st2 = raidWorld({ poor: { lifetimeWatts: 0, watts: 1e6 } });
  assert.equal(S.raidReady(st2.players[TC]), false);
});

test("raid floor: existing dens are backfilled from their lifetime on load", () => {
  const vet = fresh({ watts: 9000, lifetimeWatts: 120_000 });
  const newb = fresh({ watts: 9000, lifetimeWatts: 300 });
  const broken = fresh({ watts: 9000 });
  delete broken.lifetimeWatts;
  S.patchState({ height: 10, players: { [TA]: vet, [TB]: newb, [TC]: broken } }, T0);
  assert.deepEqual([S.raidReady(vet), S.raidReady(newb), S.raidReady(broken), broken.lifetimeWatts], [true, false, false, 0]);
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
  // the real night's shape: the 22:00-02:00 runs carry most of the work, the stirs a little (~4%:
  // just dense enough that no gap inside a run reaches IDLE_AFTER_MS)
  const runs = SCHED.segments.filter((s) => s.kind === "run").sort((a, b) => b.blocks - a.blocks);
  assert.deepEqual(runs.slice(0, 2).map((s) => s.label).sort(), ["after midnight", "peak"]);
  assert.ok(runs.slice(0, 3).reduce((a, s) => a + s.blocks, 0) / 1078 > 0.7);
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
  // bed: 20 W/min whatever the cadence (bedCredit/accrueBed take no speed input)
  const p = fresh();
  assert.equal(S.bedCredit(p, 120_000, T0), 40);
  const st = { lastAccruedHeight: 1000, height: 1000, lastBedTickAt: T0 - 60_000, players: { a: fresh() } };
  assert.equal(S.accrueBed(st, true, T0), 20);
  // advanceTo on a test state: plain income however fast the height moves
  const own = { startHeight: 1000, height: 1000, lastAccruedHeight: 1000, players: { a: fresh() } };
  for (let i = 1; i <= 12; i++) S.advanceTo(1000 + 100 * i, T0 + i * 60_000, own);
  assert.equal(own.players.a.watts, W0 + 12_000);
  // the server's own ring is empty here (nothing advanced it): no bonus, and the field is published
  assert.equal(S.snapshot().speedPct, 100);
});

test("fixtures: the wheel and the bed move on open floor tiles, 2 tiles apart", () => {
  const p = S.newPlayer(1000, T0, TA);
  assert.deepEqual(p.fixtures, { wheel: { i: 1, j: 5, flip: true }, bed: { i: 7, j: 2, flip: false } });
  assert.deepEqual(S.moveFixture(p, { which: "wheel", i: 4, j: 4, flip: true }), { ok: true, fixture: { i: 4, j: 4, flip: true } });
  assert.deepEqual(S.moveFixture(p, { which: "bed", i: 2, j: 8 }).fixture, { i: 2, j: 8, flip: false }); // flip optional
  assert.equal(S.moveFixture(p, { which: "bed", i: 5, j: 5 }).error, "too_close"); // diagonal neighbour of the wheel
  assert.equal(S.moveFixture(p, { which: "bed", i: 6, j: 4 }).ok, true); // two tiles off
  for (const [i, j] of [[-1, 3], [3, -1], [11, 2], [2, 10], [10, 5], [1.5, 2], ["2", 3]]) assert.equal(S.moveFixture(p, { which: "wheel", i, j }).error, "out_of_bounds", `${i},${j}`);
  for (const [i, j] of [[0, 3], [0, 0]]) assert.ok(S.validFixtures({ ...p.fixtures, wheel: { i, j, flip: false } }), `against the wall ${i},${j}`);
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

// ---------- sleep by the live reading ----------
const reading = (status, at, freshness = "online") => ({ coreStatus: status, freshness, updatedAt: new Date(at).toISOString() });

test("asleep: a fresh live reading decides (asleep 20 s after it stops saying ACTIVE); else the chain", () => {
  const st = { lastAdvanceAt: T0 - 5_000, players: {} };
  // no reading: the chain alone
  assert.equal(S.asleep(st, T0), false);
  assert.equal(S.asleep({ ...st, lastAdvanceAt: T0 - BALANCE.IDLE_AFTER_MS }, T0), true);
  // running
  st.hamster = reading("ACTIVE", T0);
  S.noteStatus(st, T0);
  assert.equal(st.lastStatusActiveAt, T0);
  assert.equal(S.asleep(st, T0), false);
  // he stops: a pause for STATUS_PAUSE_MS, then asleep although the last block is recent
  st.hamster = reading("IDLE", T0 + 10_000);
  S.noteStatus(st, T0 + 10_000);
  assert.equal(st.lastStatusActiveAt, T0, "an IDLE reading doesn't move the clock");
  assert.equal(S.STATUS_PAUSE_MS, 20_000);
  assert.equal(S.asleep(st, T0 + 19_999), false);
  assert.equal(S.asleep(st, T0 + 20_000), true);
  // ACTIVE again wakes him at once, whatever the chain says
  st.hamster = reading("ACTIVE", T0 + 600_000);
  assert.equal(S.asleep(st, T0 + 600_000), false);
  // a reading older than 2 min, or marked stale, is ignored: the chain decides
  st.hamster = reading("ACTIVE", T0);
  assert.equal(S.asleep(st, T0 + 200_000), true); // no block for 205 s
  st.hamster = reading("IDLE", T0 + 30_000, "stale");
  assert.equal(S.asleep({ ...st, lastAdvanceAt: T0 + 25_000 }, T0 + 30_000), false); // a block 5 s ago
  assert.equal(S.statusFresh(null, T0), false);
});

test("raids and bed income follow asleep(): closed 20 s after he stops, not 90 s", () => {
  const st = { lastAdvanceAt: T0, lastBedTickAt: null, players: { a: fresh() }, hamster: reading("ACTIVE", T0) };
  S.noteStatus(st, T0);
  assert.equal(S.raidWindow(st.lastAdvanceAt, T0 + 1_000, null, st).open, true);
  st.hamster = reading("IDLE", T0 + 25_000);
  assert.deepEqual(S.raidWindow(st.lastAdvanceAt, T0 + 25_000, null, st), { open: false, reason: "hamster_asleep" });
  assert.equal(S.raidWindow(st.lastAdvanceAt, T0 + 25_000).open, true, "the chain alone would still say open");
  assert.equal(S.raidStatus(st, st.players.a, T0 + 25_000).open, false);
  S.accrueBed(st, S.asleep(st, T0 + 25_000), T0 + 25_000);
  S.accrueBed(st, S.asleep(st, T0 + 85_000), T0 + 85_000);
  assert.equal(st.players.a.lifetimeWatts, 20, "a minute of bed income at 20 W/min");
});

test("replay: asleep within 30 s of every run's end, awake from every run's start", () => {
  const st = replayWorld({ [TOKEN]: S.newPlayer(null, EP, TOKEN) });
  const t0 = EP + 2 * DAY + 3 * MIN + 3_700;
  let sawSleep = 0, sawRun = 0;
  for (let x = t0; x <= t0 + SCHED.cycleMs; x += 10_000) {
    S.replayTick(st, x, SCHED, 5204);
    const loc = S.replayLocate(x, SCHED), z = S.asleep(st, x);
    if (loc.seg.kind === "run" && loc.u > 0) { assert.equal(z, false, `awake in ${loc.seg.label}`); sawRun++; }
    else if (loc.seg.kind === "sleep" && x - (loc.cycleStart + loc.seg.start) >= S.STATUS_PAUSE_MS + 10_000) { assert.equal(z, true, `asleep in ${loc.seg.label}`); sawSleep++; }
  }
  assert.ok(sawRun > 0 && sawSleep > 0);
});

test("replay nonstop: the real runs stretched over the whole cycle, same blocks a day, never asleep", () => {
  const ns = S.replaySchedule(3, EP, true);
  assert.ok(ns.segments.every((x) => x.kind === "run"));
  assert.equal(ns.cycleMs, SCHED.cycleMs);
  assert.equal(ns.blocksPerCycle, SCHED.blocksPerCycle);
  assert.notEqual(ns.key, SCHED.key, "switching re-anchors the offset (continuously)");
  const st = replayWorld({ [TOKEN]: S.newPlayer(null, EP, TOKEN) });
  for (let x = EP + DAY + 3_700; x <= EP + DAY + ns.cycleMs; x += 10_000) {
    S.replayTick(st, x, ns, 5204);
    assert.equal(S.asleep(st, x), false);
  }
});

// ---------- v3 patch 2: Raid Shield, boosts, lucky crates, golden blocks ----------
const SH = BALANCE.SHIELD, BO = BALANCE.BOOSTS, CR = BALANCE.CRATES, GO = BALANCE.GOLDEN;
const H1 = 3_600_000;
const okRaid = (st, a, d, now = T0) => raid(st, a, d, 1000, 2, now, seq(LOSE));
// Boost and shield sales are switched off for now (BALANCE.BOOSTS_FOR_SALE); these tests cover the
// purchase rules for when they're switched back on.
function saleTest(name, fn) {
  test(`${name} (with sales on)`, () => {
    const was = BALANCE.BOOSTS_FOR_SALE;
    BALANCE.BOOSTS_FOR_SALE = true;
    try { fn(); } finally { BALANCE.BOOSTS_FOR_SALE = was; }
  });
}

test("v3 balance knobs: shield, boosts, crates, golden", () => {
  assert.deepEqual(SH, { MS: 3 * H1, PER_DAY: 1, PRICE_MIN: 500, PRICE_PCT: 3, BRUISE_MS: 600_000 });
  assert.deepEqual(BO, {
    double_wheel: { PRICE: 2000, MS: H1, PCT: 200 },
    deep_sleep: { PRICE: 3000, MS: 8 * H1, PCT: 150 },
    lucky_whisker: { PRICE: 1500, ODDS_PTS: 10 },
    wager_insurance: { PRICE: 1000, REFUND_PCT: 50 },
  });
  assert.deepEqual([CR.CHANCE_PCT, CR.PER_DAY, CR.MAX_UNOPENED, CR.WATTS_MIN, CR.WATTS_MAX, CR.DUP_WATTS], [1, 5, 3, 200, 800, 800]);
  assert.deepEqual(CR.TABLE_PCT, { watts: 60, boost: 25, shield: 10, decor: 5 });
  assert.ok(CR.ROLLS_MAX >= 1);
  assert.deepEqual(GO, { ONE_IN: 150, MULT_PCT: 1000 });
  assert.deepEqual(S.BOOST_KINDS, ["double_wheel", "deep_sleep", "lucky_whisker", "wager_insurance"]);
  assert.deepEqual(S.configPayload().balance.SHIELD, SH); // shipped to the client with the rest of BALANCE
  assert.equal(BALANCE.BOOSTS_FOR_SALE, false); // for now: crates only
});

test("sales off: boosts and the shield can't be bought, only used from crate finds", () => {
  const p = fresh({ watts: 100_000 }), st = { lastAdvanceAt: T0, players: { [TA]: p } };
  for (const k of S.BOOST_KINDS) assert.equal(S.useBoost(st, TA, { kind: k, from: "watts" }, T0).error, "not_for_sale", k);
  assert.equal(S.raiseShield(st, TA, { from: "watts" }, T0).error, "not_for_sale");
  assert.equal(p.watts, 100_000);
  assert.deepEqual([p.effects.double_wheel, p.shield.until, p.shieldDay], [0, 0, null]);
  // crate finds still work
  p.items.double_wheel = 1;
  p.items.shield_token = 1;
  assert.ok(S.useBoost(st, TA, { kind: "double_wheel", from: "item" }, T0).ok);
  assert.ok(S.raiseShield(st, TA, { from: "token" }, T0).ok);
  assert.deepEqual([p.items.double_wheel, p.items.shield_token, p.watts, p.shield.kind], [0, 0, 100_000, "bought"]);
  // and the bruise shield after a lost defence is free as ever
  const w = raidWorld({ def: { watts: 50_000 } });
  raid(w, TA, TB, 1000, 2, T0, seq(WIN, 0.5, 0.99));
  assert.equal(w.players[TB].shield.kind, "bruise");
});

saleTest("shield: price max(500, 3% of the balance), burned; 3 h; once per UTC day; tokens waive the price", () => {
  assert.equal(S.shieldPrice(fresh({ watts: 0 })), 500);
  assert.equal(S.shieldPrice(fresh({ watts: 16_666 })), 500); // 3% = 499.98
  assert.equal(S.shieldPrice(fresh({ watts: 16_667 })), 500);
  assert.equal(S.shieldPrice(fresh({ watts: 100_000 })), 3000);
  assert.equal(S.shieldPrice(fresh({ watts: 1_234_567 })), 37_037);
  const st = raidWorld({ def: { watts: 100_000 } });
  const d = st.players[TB];
  assert.deepEqual(S.raiseShield(st, TB, { from: "nope" }, T0).error, "bad_from");
  const r = S.raiseShield(st, TB, { from: "watts" }, T0);
  assert.equal(r.ok, true);
  assert.deepEqual(d.shield, { until: T0 + 3 * H1, kind: "bought" });
  assert.equal(d.watts, 97_000);
  // once per UTC day, even after it ran out; a token doesn't get round the cap
  d.items.shield_token = 1;
  assert.equal(S.raiseShield(st, TB, { from: "token" }, T0 + H1).error, "shield_used_today");
  const next = Date.UTC(2026, 9, 31, 0, 0, 0); // T0 is 30 Oct 22:00 UTC
  assert.equal(S.raiseShield(st, TB, { from: "watts" }, next - 1).error, "shield_used_today");
  // past midnight with the bought shield still up (it started 22:00): no stacking
  assert.equal(S.raiseShield(st, TB, { from: "watts" }, next + 1000).error, "shield_active");
  const t = S.raiseShield(st, TB, { from: "token" }, T0 + 5 * H1);
  assert.equal(t.ok, true);
  assert.deepEqual([d.items.shield_token, d.watts, d.shield.until], [0, 97_000, T0 + 8 * H1]); // free with a token
  assert.equal(S.raiseShield(st, TB, { from: "token" }, Date.UTC(2026, 10, 1, 10)).error, "no_item");
  const poor = raidWorld({ poor: { watts: 300 } });
  assert.deepEqual([S.raiseShield(poor, TC, { from: "watts" }, T0).error, S.raiseShield(poor, TC, { from: "watts" }, T0).need], ["poor", 200]);
});

saleTest("shield: blocks raids in (excluded from targets, no raid used) and out (turtle mode)", () => {
  const st = raidWorld({ def: { watts: 50_000 } });
  assert.ok(S.raiseShield(st, TB, { from: "watts" }, T0).ok);
  const r = okRaid(st, TA, TB);
  assert.deepEqual([r.ok, r.error, r.until], [false, "target_shielded", T0 + 3 * H1]);
  assert.equal(st.players[TA].raidsToday, 0);
  assert.equal(st.players[TA].watts, 10_000);
  let row = S.leaderboard(st, TA, T0).rows.find((x) => x.publicId === pidOf(TB));
  assert.deepEqual([row.shielded, row.raidable], [true, false]);
  assert.equal("shieldUntil" in row, false);
  // turtle mode: the shielded den can't raid out either
  const out = okRaid(st, TB, TA);
  assert.deepEqual([out.ok, out.error], [false, "shielded"]);
  assert.equal(st.players[TB].raidsToday, 0);
  assert.equal(S.raidStatus(st, st.players[TB], T0).shielded, true);
  assert.ok(S.leaderboard(st, TB, T0).rows.every((x) => !x.raidable));
  // it wears off on time, even through the leaderboard cache
  const later = T0 + 3 * H1;
  st.lastAdvanceAt = later - 1000;
  row = S.leaderboard(st, TA, later).rows.find((x) => x.publicId === pidOf(TB));
  assert.deepEqual([row.shielded, row.raidable], [false, true]);
  assert.ok(okRaid(st, TA, TB, later).ok);
});

saleTest("shield: a successful raid bruises the defender for 10 min (free, raids out still allowed); a failed one doesn't", () => {
  const st = raidWorld({ def: { watts: 50_000 } });
  assert.ok(okRaid(st, TA, TB).ok); // a loss
  assert.deepEqual(st.players[TB].shield, { until: 0, kind: null });
  const w = raid(st, TA, TB, 1000, 2, T0 + 1, seq(WIN, 0.5, 0.99));
  assert.equal(w.result.win, true);
  assert.deepEqual(st.players[TB].shield, { until: T0 + 1 + SH.BRUISE_MS, kind: "bruise" });
  assert.equal(st.players[TB].shieldDay, null); // the daily activation is untouched
  assert.equal(raid(st, TC, TB, 100, 2, T0 + 2).error, "target_shielded");
  assert.equal(S.raidStatus(st, st.players[TB], T0 + 2).shielded, false);
  assert.ok(raid(st, TB, TA, 2450, 1.5, T0 + 3, seq(LOSE)).ok); // the bruised den may still raid (revenge; 5% of 49k)
  st.lastAdvanceAt = T0 + SH.BRUISE_MS; // still running 10 min later
  assert.equal(raid(st, TC, TB, 100, 2, T0 + SH.BRUISE_MS, seq(LOSE)).error, "target_shielded");
  assert.ok(raid(st, TC, TB, 100, 2, T0 + 1 + SH.BRUISE_MS, seq(LOSE)).ok); // over after 10 min
  // buying a shield replaces a bruise
  const st2 = raidWorld({ def: { watts: 50_000 } });
  raid(st2, TA, TB, 1000, 2, T0, seq(WIN, 0.5, 0.99));
  assert.ok(S.raiseShield(st2, TB, { from: "watts" }, T0 + 5).ok);
  assert.deepEqual(st2.players[TB].shield, { until: T0 + 5 + 3 * H1, kind: "bought" });
});

saleTest("shield: visible in the den's own snapshot (publicPlayer) and to everyone on the leaderboard", () => {
  const p = Object.assign(S.newPlayer(1000, T0, TA), { watts: 40_000 });
  let me = S.publicPlayer(p, T0);
  assert.deepEqual(me.shield, { until: 0, kind: null, usedToday: false, price: 1200 });
  const st = { lastAdvanceAt: T0, players: { [TA]: p } };
  assert.ok(S.raiseShield(st, TA, { from: "watts" }, T0).ok);
  me = S.publicPlayer(p, T0 + 1);
  assert.deepEqual(me.shield, { until: T0 + 3 * H1, kind: "bought", usedToday: true, price: 1164 });
  assert.equal(S.publicPlayer(p, T0 + 3 * H1).shield.kind, null);
  assert.equal(S.leaderboard(st, null, T0 + 1).rows[0].shielded, true); // anonymous viewers see it too
});

saleTest("boosts: buy (price burns) or use a crate copy; one active per kind, never stacked", () => {
  const st = { lastAdvanceAt: T0, players: { [TA]: fresh({ watts: 20_000 }) } };
  const p = st.players[TA];
  assert.equal(S.useBoost(st, TA, { kind: "nope", from: "watts" }, T0).error, "bad_boost");
  assert.equal(S.useBoost(st, TA, { kind: "double_wheel" }, T0).error, "bad_from");
  assert.equal(S.useBoost(st, TA, { kind: "double_wheel", from: "item" }, T0).error, "no_item");
  let r = S.useBoost(st, TA, { kind: "double_wheel", from: "watts" }, T0);
  assert.equal(r.ok, true);
  assert.deepEqual([p.watts, p.effects.double_wheel], [18_000, T0 + H1]);
  r = S.useBoost(st, TA, { kind: "double_wheel", from: "watts" }, T0 + H1 - 1);
  assert.deepEqual([r.ok, r.error, r.until, p.watts], [false, "boost_active", T0 + H1, 18_000]);
  p.items.double_wheel = 1;
  assert.equal(S.useBoost(st, TA, { kind: "double_wheel", from: "item" }, T0 + 10).error, "boost_active"); // a held copy waits too
  assert.ok(S.useBoost(st, TA, { kind: "double_wheel", from: "item" }, T0 + H1).ok); // expired: a fresh hour, from the item
  assert.deepEqual([p.items.double_wheel, p.watts, p.effects.double_wheel], [0, 18_000, T0 + 2 * H1]);
  for (const k of ["deep_sleep", "lucky_whisker", "wager_insurance"]) assert.ok(S.useBoost(st, TA, { kind: k, from: "watts" }, T0).ok, k);
  assert.equal(p.watts, 18_000 - 3000 - 1500 - 1000);
  assert.deepEqual([p.effects.deep_sleep, p.effects.lucky_whisker, p.effects.wager_insurance], [T0 + 8 * H1, true, true]);
  for (const k of ["lucky_whisker", "wager_insurance"]) assert.equal(S.useBoost(st, TA, { kind: k, from: "watts" }, T0 + 9 * H1).error, "boost_active", k); // armed until a raid uses it
  const broke = { lastAdvanceAt: T0, players: { [TB]: fresh({ watts: 1999 }) } };
  const pr = S.useBoost(broke, TB, { kind: "double_wheel", from: "watts" }, T0);
  assert.deepEqual([pr.error, pr.need, broke.players[TB].watts], ["poor", 1, 1999]);
});

test("boosts: Double Wheel x2 wheel watts for an hour; Deep Sleep +50% bed for 8 h", () => {
  const p = fresh({ wheelTier: 2 });
  const base = S.accrue(fresh({ wheelTier: 2 }), 10, T0); // 10 x 10 x 1.6 = 160
  assert.equal(base, 160);
  p.effects.double_wheel = T0 + H1;
  assert.equal(S.accrue(p, 10, T0), 320);
  assert.equal(S.accrue(p, 10, T0 + H1 - 1), 320);
  assert.equal(S.accrue(p, 10, T0 + H1), 160); // expired
  assert.equal(S.wattsFor(10, 0, 120, 150, 200), 360); // stacks with watching and speed: 100 x 1.2 x 1.5 x 2
  const q = fresh(), r = fresh();
  q.effects.deep_sleep = T0 + 8 * H1;
  assert.equal(S.bedCredit(r, 60_000, T0), 20); // live: 20 W/min at tier 0
  assert.equal(S.bedCredit(q, 60_000, T0), 30);
  assert.equal(S.bedCredit(q, 60_000, T0 + 8 * H1), 20);
  assert.equal(S.accrue(q, 10, T0), 100); // Deep Sleep doesn't touch the wheel
});

test("boosts: Lucky Whisker +10 points on the next raid (capped at P_MAX), spent win or lose", () => {
  const st = raidWorld({ def: { watts: 100_000 } });
  const a = st.players[TA], d = st.players[TB];
  const p0 = S.raidChance(a, d, 1000); // 0.1925 at 10x against a 10x-richer den
  near(S.resolveRaid(a, d, 100, 1000, seq(LOSE), 10).p, p0 + 0.1);
  near(S.resolveRaid(a, d, 100, 150, seq(LOSE), 10).p, Math.min(0.9, S.raidChance(a, d, 150) + 0.1));
  near(S.resolveRaid(fresh({ watts: 100 }), fresh({ watts: 1e9 }), 100, 150, seq(LOSE), 10).p, 0.9); // already at P_MAX
  a.effects.lucky_whisker = true;
  // a roll between p0 and p0 + 0.10 wins only thanks to the whisker
  const r = raid(st, TA, TB, 500, 10, T0, seq(p0 + 0.05, 0.5, 0.99));
  assert.deepEqual([r.result.win, r.result.lucky, a.effects.lucky_whisker], [true, true, false]);
  near(r.result.p, p0 + 0.1);
  st.players[TB].shield.until = 0; // skip the bruise
  const r2 = raid(st, TA, TB, 800, 10, T0 + 1, seq(p0 + 0.05));
  assert.deepEqual([r2.result.win, r2.result.lucky], [false, undefined]); // spent: back to the plain odds
  a.effects.lucky_whisker = true;
  assert.equal(raid(st, TA, TB, 1000, 2, T0 + 2, seq(LOSE)).result.lucky, true);
  assert.equal(a.effects.lucky_whisker, false); // a loss spends it too
  // already at the 90% cap: the whisker can't help, so it isn't spent
  const st2 = raidWorld({ atk: { watts: 1000 }, def: { watts: 1e9 } });
  const b = st2.players[TA];
  b.effects.lucky_whisker = true;
  assert.equal(S.raidChance(b, st2.players[TB], 150), 0.9);
  const r3 = raid(st2, TA, TB, 50, 1.5, T0, seq(LOSE));
  assert.deepEqual([r3.ok, r3.result.lucky, b.effects.lucky_whisker], [true, undefined, true]);
});

test("boosts: Wager Insurance refunds half the next FAILED wager, survives wins", () => {
  const st = raidWorld({ def: { watts: 100_000 } });
  const a = st.players[TA];
  a.effects.wager_insurance = true;
  const w = raid(st, TA, TB, 1000, 2, T0, seq(WIN, 0.5, 0.99));
  assert.deepEqual([w.result.win, w.result.refund, a.effects.wager_insurance], [true, undefined, true]);
  st.players[TB].shield.until = 0;
  const before = supply(st), atkW = a.watts;
  const l = raid(st, TA, TB, 1001, 2, T0 + 1, seq(LOSE));
  assert.deepEqual([l.result.win, l.result.refund, a.effects.wager_insurance], [false, 500, false]);
  assert.equal(l.feed.amount, 501); // the feed shows what burned
  assert.equal(a.watts, atkW - 501);
  assert.equal(st.burned, 501);
  assert.equal(supply(st), before);
  const l2 = raid(st, TA, TB, 1000, 2, T0 + 2, seq(LOSE));
  assert.equal(l2.result.refund, undefined); // spent
});

saleTest("boosts + shield persist across a restart (JSON round trip + patchState) and old dens are backfilled", () => {
  const p = fresh({ watts: 50_000, lastHeartbeat: T0 });
  const st = { lastAdvanceAt: T0, players: { [TA]: p } };
  S.useBoost(st, TA, { kind: "double_wheel", from: "watts" }, T0);
  S.useBoost(st, TA, { kind: "wager_insurance", from: "watts" }, T0);
  S.raiseShield(st, TA, { from: "watts" }, T0);
  p.items.deep_sleep = 2;
  S.rollCrates(p, 1, T0, seq(0, 0.1, 0.5, 0.5));
  const back = S.patchState(JSON.parse(JSON.stringify({ height: 10, players: { [TA]: p } })), T0 + 1).players[TA];
  assert.deepEqual(back.effects, { double_wheel: T0 + H1, deep_sleep: 0, lucky_whisker: false, wager_insurance: true });
  assert.deepEqual(back.items, { double_wheel: 0, deep_sleep: 2, lucky_whisker: 0, wager_insurance: 0, shield_token: 0 });
  assert.deepEqual(back.shield, { until: T0 + 3 * H1, kind: "bought" });
  assert.equal(back.shieldDay, "2026-10-30");
  assert.equal(back.crates.length, 1);
  assert.equal(S.accrue(Object.assign(back, { lastHeartbeat: 0 }), 10, T0 + 2), 200); // still doubled after the "restart"
  // a den saved before v3: every new field gets its default; junk is dropped
  const old = fresh();
  for (const k of ["items", "effects", "shield", "shieldDay", "crates", "crateDay", "cratesToday"]) delete old[k];
  old.items = { double_wheel: 3, bogus: 9, deep_sleep: -1 };
  old.effects = { lucky_whisker: "yes", deep_sleep: T0 };
  S.patchPlayer(old, TA);
  assert.deepEqual(old.items, { double_wheel: 3, deep_sleep: 0, lucky_whisker: 0, wager_insurance: 0, shield_token: 0 });
  assert.deepEqual(old.effects, { double_wheel: 0, deep_sleep: T0, lucky_whisker: false, wager_insurance: false });
  assert.deepEqual([old.shield, old.shieldDay, old.crates, old.crateDay, old.cratesToday], [{ until: 0, kind: null }, null, [], null, 0]);
});

test("crates: contents table 60/25/10/5 (rolled at drop time), watts 200..800", () => {
  const p = fresh();
  assert.deepEqual(S.rollCrateContents(p, seq(0, 0)), { kind: "watts", watts: 200 });
  assert.deepEqual(S.rollCrateContents(p, seq(0.5999, 0.999999)), { kind: "watts", watts: 800 });
  assert.deepEqual(S.rollCrateContents(p, seq(0.60, 0)), { kind: "boost", boost: "double_wheel" });
  assert.deepEqual(S.rollCrateContents(p, seq(0.84, 0.99)), { kind: "boost", boost: "wager_insurance" });
  assert.deepEqual(S.rollCrateContents(p, seq(0.85)), { kind: "shield" });
  assert.deepEqual(S.rollCrateContents(p, seq(0.9499)), { kind: "shield" });
  // the decor slot: a crate-only item, or 800 W when it's owned or already waiting in another crate
  const fake = { id: "test_crate_decor", name: "Test", cat: "wall", price: 0, w: 1, h: 1, zone: "wall", sprite: "test_crate_decor", crate: true };
  CATALOG.push(fake); S.CATALOG_BY_ID.set(fake.id, fake);
  try {
    const decorIds = CATALOG.filter((i) => i.crate).map((i) => i.id);
    const roll = (q) => S.rollCrateContents(q, seq(0.95, (decorIds.indexOf(fake.id) + 0.5) / decorIds.length));
    assert.deepEqual(roll(p), { kind: "decor", item: fake.id });
    p.crates = [{ id: "x", c: { kind: "decor", item: fake.id } }];
    assert.deepEqual(roll(p), { kind: "watts", watts: 800, dup: fake.id });
    p.crates = [];
    p.owned[fake.id] = 1;
    assert.deepEqual(roll(p), { kind: "watts", watts: 800, dup: fake.id });
  } finally {
    CATALOG.pop(); S.CATALOG_BY_ID.delete(fake.id);
  }
  // seeded odds over many rolls (the decor slot is "decor" or its 800 W duplicate)
  const rng = prng(7), n = 40_000, count = { watts: 0, boost: 0, shield: 0, decor: 0 };
  for (let i = 0; i < n; i++) {
    const c = S.rollCrateContents(fresh(), rng);
    count[c.kind === "decor" || (c.kind === "watts" && c.watts === 800 && (c.dup || !CATALOG.some((x) => x.crate))) ? (c.kind === "decor" || c.dup ? "decor" : "watts") : c.kind]++;
  }
  const share = (k) => count[k] / n;
  assert.ok(Math.abs(share("boost") - 0.25) < 0.01, JSON.stringify(count));
  assert.ok(Math.abs(share("shield") - 0.10) < 0.01, JSON.stringify(count));
  assert.ok(Math.abs(share("watts") + share("decor") - 0.65) < 0.01, JSON.stringify(count));
});

test("crates: only dens watching roll, 1% a settled block (seeded), 5 a UTC day, at most 3 unopened", () => {
  const st = { lastAccruedHeight: 1000, lastAdvanceAt: T0, players: { [TA]: fresh({ lastHeartbeat: T0 }), [TB]: fresh() } };
  S.accrueAll(st, 1001, T0, 100, () => 0); // every roll hits
  assert.equal(st.players[TA].crates.length, 1);
  assert.equal(st.players[TB].crates.length, 0); // not watching: no crate, ever
  S.accrueAll(st, 1001 + 10, T0, 100, () => 0);
  assert.equal(st.players[TA].crates.length, 3); // capped while unopened
  assert.equal(st.players[TA].cratesToday, 3);
  // seeded 1% odds
  const p = fresh({ lastHeartbeat: T0 }), rng = prng(99);
  let drops = 0;
  for (let i = 0; i < 20_000; i++) { p.crates = []; p.cratesToday = 0; drops += S.rollCrates(p, 1, T0, rng); }
  assert.ok(Math.abs(drops / 20_000 - 0.01) < 0.002, String(drops));
  // the daily cap: open them as they come, still 5 a day, then a fresh count after 00:00 UTC
  const q = fresh({ lastHeartbeat: T0 }), qs = { players: { [TC]: q } };
  for (let i = 0; i < 20; i++) { S.rollCrates(q, 1, T0, () => 0); for (const c of [...q.crates]) S.openCrate(qs, TC, { id: c.id }, T0); }
  assert.equal(q.cratesToday, 5);
  assert.equal(S.rollCrates(q, 10, Date.UTC(2026, 9, 31, 0, 0, 1), () => 0), 3); // new day, but the 3-unopened cap still applies
  assert.equal(S.publicPlayer(q, Date.UTC(2026, 9, 31, 1)).cratesToday, 3);
});

test("crates: dropped on a free floor tile; contents stay secret until opened; opening pays out", () => {
  const p = fresh({ lastHeartbeat: T0 });
  p.placed = [{ pid: "s1", item: "fur_sofa", x: 3, y: 3, flip: false }];
  own(p, "fur_sofa");
  for (let k = 0; k < 200; k++) {
    const t = S.crateTile(p, prng(k));
    assert.ok(t.i + t.j <= S.ROOM.FIX_MAX_SUM && t.i >= 0 && t.j >= 0 && t.i < S.ROOM.ISO_NI && t.j < S.ROOM.ISO_NJ);
    assert.ok(!(t.j === 3 && t.i >= 3 && t.i <= 5), "not under the sofa");
    for (const f of Object.values(p.fixtures)) assert.ok(!(f.i === t.i && f.j === t.j), "not on a fixture");
  }
  const st = { players: { [TA]: p } };
  S.rollCrates(p, 1, T0, seq(0, 0.10, 0.5, 0.3)); // drop -> watts, 200 + floor(0.5 x 601) = 500
  const crate = p.crates[0];
  const pub = S.publicPlayer(p, T0).crates;
  assert.deepEqual(pub, [{ id: crate.id, at: T0, i: crate.i, j: crate.j }]);
  assert.ok(!JSON.stringify(S.publicPlayer(p, T0)).includes("\"c\":"), "contents never leave the server");
  const w0 = p.watts, life0 = p.lifetimeWatts;
  assert.equal(S.openCrate(st, TA, { id: "nope" }, T0).error, "unknown_crate");
  const o = S.openCrate(st, TA, { id: crate.id }, T0);
  assert.deepEqual(o, { ok: true, got: { kind: "watts", watts: 500 } });
  assert.deepEqual([p.watts, p.lifetimeWatts, p.crates.length], [w0 + 500, life0, 0]); // balance only, not earnings
  assert.equal(S.openCrate(st, TA, { id: crate.id }, T0).error, "unknown_crate"); // once
  p.crates.push({ id: "kb", at: T0, i: 1, j: 1, c: { kind: "boost", boost: "deep_sleep" } });
  assert.deepEqual(S.openCrate(st, TA, { id: "kb" }, T0).got, { kind: "boost", boost: "deep_sleep" });
  assert.equal(p.items.deep_sleep, 1);
  p.crates.push({ id: "ks", at: T0, i: 1, j: 1, c: { kind: "shield" } });
  assert.deepEqual(S.openCrate(st, TA, { id: "ks" }, T0).got, { kind: "shield" });
  assert.equal(p.items.shield_token, 1);
  // decor that became owned while the crate waited turns into DUP_WATTS on opening
  p.crates.push({ id: "kd", at: T0, i: 1, j: 1, c: { kind: "decor", item: "fur_sofa" } });
  const w1 = p.watts;
  assert.deepEqual(S.openCrate(st, TA, { id: "kd" }, T0).got, { kind: "watts", watts: 800, dup: "fur_sofa" });
  assert.equal(p.watts, w1 + 800);
});

test("golden blocks: deterministic from the height (~1 in 150), 10x wheel watts only for dens watching", () => {
  const golden = [];
  for (let h = 1; h <= 150_000; h++) if (S.isGoldenBlock(h)) golden.push(h);
  assert.ok(golden.length > 850 && golden.length < 1150, String(golden.length));
  assert.ok(golden.slice(0, 20).every((h) => S.isGoldenBlock(h))); // same answer every call
  assert.deepEqual(S.goldenBetween(0, 150_000), golden);
  assert.equal(S.isGoldenBlock(0), false);
  assert.equal(S.isGoldenBlock(-golden[0]), false);
  const g = golden[0];
  const st = { lastAccruedHeight: g - 1, players: { [TA]: fresh({ lastHeartbeat: T0, joinHeight: 0 }), [TB]: fresh({ joinHeight: 0 }), [TC]: fresh({ lastHeartbeat: T0, joinHeight: g }) } };
  S.accrueAll(st, g, T0, 100, () => 1);
  assert.equal(st.players[TA].lifetimeWatts, 120); // 10 x 10 x 1.2 (watching)
  assert.equal(st.players[TB].lifetimeWatts, 10); // not watching: normal rate
  assert.equal(st.players[TC].lifetimeWatts, 0); // joined at that block: never paid for it
  assert.deepEqual(st.lastGolden, { height: g, at: T0 });
  const plain = g + 1;
  assert.equal(S.isGoldenBlock(plain), false);
  S.accrueAll(st, plain, T0, 100, () => 1);
  assert.equal(st.players[TA].lifetimeWatts, 132);
  // a range with a golden block inside (a catch-up): only that block is 10x
  const st2 = { lastAccruedHeight: g - 3, players: { [TA]: fresh({ lastHeartbeat: T0, joinHeight: 0 }) } };
  S.accrueAll(st2, g + 2, T0, 100, () => 1); // 5 blocks, 1 golden: (5 + 9) x 12
  assert.equal(st2.players[TA].lifetimeWatts, 168);
  assert.ok("golden" in S.snapshot(null));
});

// ---------- v3 patch 3: decor wave and colourways ----------
// Load every sprite file the page loads (in its order) into a sandbox, to check the catalog against the art.
function loadSprites() {
  const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
  const pub = path.join(__dirname, "..", "public");
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
  const files = [...html.matchAll(/<script src="(sprites[^"]*\.js)"><\/script>/g)].map((m) => m[1]);
  const warns = [];
  const ctx = { console: { log() {}, warn: (m) => warns.push(String(m)), error: (m) => warns.push(String(m)) }, document: { createElement: () => ({ getContext: () => null }) }, performance: { now: () => 0 } };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(pub, f), "utf8"), ctx, { filename: f });
  return { SPR: ctx.SPRITES, files, warns };
}

test("v3 catalog: the new items, prices, sizes and zones", () => {
  const want = {
    wall_paw_stickers: [300, 1, 1, "wall"], wall_run_poster: [400, 1, 2, "wall"], wall_doodle: [500, 1, 1, "wall"], wall_polaroids: [800, 3, 1, "wall"],
    wall_mirror: [900, 2, 2, "wall"], wall_ivy: [1000, 2, 2, "wall"], wall_portrait: [1200, 2, 2, "wall"], wall_fairy_lights: [1800, 4, 1, "wall"], wall_fish_tank: [22_000, 2, 2, "wall"],
    fur_mushroom: [300, 1, 1, "floor"], fur_yarn: [400, 1, 1, "floor"], fur_water_bottle: [500, 1, 2, "floor"], fur_fern: [600, 1, 2, "floor"], fur_stool: [700, 1, 1, "floor"],
    fur_melon_cushion: [900, 1, 1, "floor"], fur_box_house: [1500, 2, 2, "floor"], fur_hammock: [14_000, 2, 2, "floor"],
    rug_doormat: [500, 2, 1, "rug"], rug_leaves: [600, 2, 1, "rug"], rug_sand: [800, 3, 1, "rug"],
  };
  for (const [id, [price, w, h, zone]] of Object.entries(want)) {
    const it = S.CATALOG_BY_ID.get(id);
    assert.ok(it, id);
    assert.deepEqual([it.price, it.w, it.h, it.zone, it.sprite, !!it.crate], [price, w, h, zone, id, false], id);
  }
  assert.equal(S.CATALOG_BY_ID.get("wall_fairy_lights").animated, true);
  assert.equal(S.CATALOG_BY_ID.get("wall_fish_tank").animated, true);
  const cheap = CATALOG.filter((i) => i.price >= 300 && i.price <= 2000 && !i.colorOf).length;
  assert.ok(cheap >= 20, `${cheap} items in the 300-2,000 W band`);
  // the crate-only jackpots: never sold, never a free default, but in the crate decor table
  const crate = CATALOG.filter((i) => i.crate).map((i) => i.id).sort();
  assert.deepEqual(crate, ["fur_clover_jar", "fur_sunflower", "wall_lucky_lantern", "wall_shooting_star"]);
  for (const id of crate) {
    assert.equal(S.CATALOG_BY_ID.get(id).price, 0);
    assert.ok(!S.FREE_IDS.includes(id), id);
    assert.ok(!(id in S.newPlayer(1000, T0).owned), id);
  }
  assert.equal(S.CATALOG_BY_ID.get("fur_sunflower").zone, "floor");
  assert.equal(S.CATALOG_BY_ID.get("wall_lucky_lantern").animated, true);
});

test("v3 catalog integrity: unique ids, valid zones, every sprite exists (flat always, iso for floor items)", () => {
  const ids = CATALOG.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  const { SPR, files, warns } = loadSprites();
  assert.deepEqual(warns, [], "sprite rows all the right length");
  assert.ok(files.includes("sprites_crate.js") && files.includes("sprites_v3_floor_b.js"), files.join(","));
  for (const it of CATALOG) {
    assert.ok([null, "floor", "wall", "rug"].includes(it.zone), it.id);
    if (it.zone) {
      assert.ok(Number.isInteger(it.w) && it.w >= 1 && Number.isInteger(it.h) && it.h >= 1, it.id);
      if (it.zone === "wall") assert.ok(it.h <= S.ROOM.WALL_BOTTOM - S.ROOM.WALL_TOP + 1 && it.w <= S.ROOM.COLS, it.id);
    }
    if (!it.zone && !["wallpaper", "floor"].includes(it.cat) && it.cat !== "skin") continue; // ladders draw their own art
    const flat = SPR[it.sprite];
    assert.ok(flat, `flat sprite ${it.sprite} for ${it.id}`);
    if (it.zone === "rug" || it.zone === "wall" || it.zone === "floor") {
      if (typeof flat !== "function") {
        const want = it.zone === "rug" ? [16 * it.w, 10] : [16 * it.w, 16 * it.h];
        assert.deepEqual([flat.w, flat.h], want, `${it.id} flat size`);
      }
    }
    if (it.zone === "floor") {
      const iso = SPR["iso_" + it.sprite];
      assert.ok(iso && iso.iso, `iso sprite iso_${it.sprite} for ${it.id}`);
      const W = 16 * (it.w + 1), H = 16 * it.h + 8 * (it.w + 1);
      assert.deepEqual([iso.w, iso.h, iso.iso.ax, iso.iso.ay], [W, H, W - 16, H], `${it.id} iso geometry`);
    }
  }
  assert.ok(SPR.crate && SPR.iso_crate && SPR.iso_crate.iso, "the crate parcel");
});

test("v3 colourways: share the base art, valid palette remaps, same price; fairy lights + melon keep their swap colours apart", () => {
  const cw = CATALOG.filter((i) => i.colorOf);
  assert.equal(cw.length, 12);
  const per = {};
  for (const it of cw) {
    const base = S.CATALOG_BY_ID.get(it.colorOf);
    assert.ok(base && !base.colorOf, it.id);
    assert.deepEqual([it.sprite, it.price, it.zone, it.w, it.h, it.cat], [base.sprite, base.price, base.zone, base.w, base.h, base.cat], it.id);
    assert.ok(Array.isArray(it.remap) && it.remap.length > 0, it.id);
    for (const [a, b] of it.remap) assert.ok(Number.isInteger(a) && Number.isInteger(b) && a >= 2 && a <= 15 && b >= 1 && b <= 15, `${it.id} ${a}->${b}`);
    per[it.colorOf] = (per[it.colorOf] || 0) + 1;
  }
  assert.deepEqual(per, { rug_rag: 3, wall_pennant: 3, wall_fairy_lights: 2, fur_melon_cushion: 2, fur_sofa: 2 }); // 4, 4, 3, 3, 3 colours with the base
  // every colour a remap touches is actually in the base art (so each colourway looks different)
  const { SPR } = loadSprites();
  const used = (id) => { const s = new Set(); for (const fr of SPR[id].rows) for (const r of fr) for (const ch of r) if (ch !== ".") s.add(parseInt(ch, 16)); return s; };
  for (const it of cw) for (const [a] of it.remap) assert.ok(used(it.sprite).has(a), `${it.id}: ${a.toString(16)} not in ${it.sprite}`);
  // the swap colours of the new art sit only where they should
  const lights = used("wall_fairy_lights");
  assert.deepEqual([...lights].sort((a, b) => a - b), [1, 2, 6, 7, 9, 11, 14]);
  for (const id of ["fur_melon_cushion", "iso_fur_melon_cushion"]) assert.deepEqual([...used(id)].sort((a, b) => a - b), [1, 2, 9, 10, 11, 12], id);
  // colourways sit right after their base in the shop
  const order = CATALOG.map((i) => i.id);
  assert.deepEqual(order.slice(order.indexOf("rug_rag"), order.indexOf("rug_rag") + 4), ["rug_rag", "rug_rag_sea", "rug_rag_meadow", "rug_rag_ember"]);
});

test("crate-only decor can't be bought, but drops from crates and places like any other item", () => {
  const p = fresh({ watts: 1e9 });
  for (const id of ["fur_sunflower", "fur_clover_jar", "wall_lucky_lantern", "wall_shooting_star"]) {
    assert.deepEqual(S.canBuy(p, id), { ok: false, error: "crate_only" }, id);
    assert.equal(S.applyBuy(p, id).error, "crate_only");
  }
  assert.equal(p.watts, 1e9);
  // the decor slot of the crate table hands one out (seeded), then rerolls duplicates to 800 W
  const decor = CATALOG.filter((i) => i.crate).map((i) => i.id);
  const q = fresh({ lastHeartbeat: T0 }), st = { players: { [TA]: q } };
  S.rollCrates(q, 1, T0, seq(0, 0.97, (decor.indexOf("fur_sunflower") + 0.5) / decor.length, 0.5));
  assert.equal(q.crates.length, 1);
  assert.deepEqual(S.openCrate(st, TA, { id: q.crates[0].id }, T0).got, { kind: "decor", item: "fur_sunflower" });
  assert.equal(q.owned.fur_sunflower, 1);
  assert.deepEqual(S.rollCrateContents(q, seq(0.97, (decor.indexOf("fur_sunflower") + 0.5) / decor.length)), { kind: "watts", watts: 800, dup: "fur_sunflower" });
  const v = S.validatePlacement(q, "fur_sunflower", 2, 6, null, false);
  assert.equal(v.ok, true);
  const w = S.validatePlacement(q, "wall_lucky_lantern", 4, 3);
  assert.equal(w.error, "unowned");
});

// ---------- v4 feature 1: no den until a username; nameless dens purged ----------
test("names first: the snapshot never creates a den; a fresh token gets needsName", () => {
  const tok = "fresh_token_" + "z".repeat(20);
  const snap = S.snapshot(tok, "203.0.113.9");
  assert.deepEqual([snap.me, snap.meError, snap.needsName], [null, null, true]);
  assert.equal(S.snapshot(tok).needsName, true); // still nothing, however often it polls
  const bad = S.snapshot("x", null);
  assert.deepEqual([bad.me, bad.meError, bad.needsName], [null, "bad_token", false]);
  assert.equal(S.snapshot(null).needsName, false);
});

test("names first: createDen makes the den only with a valid, free username", () => {
  const st = { height: 1000, players: {} };
  const ip = "198.51.100.77";
  assert.equal(S.createDen(st, "short", { username: "Alice" }, T0, { ip }).error, "bad_token");
  assert.equal(S.createDen(st, TA, { username: "a" }, T0, { ip }).error, "bad_username");
  assert.equal(S.createDen(st, TA, {}, T0, { ip }).error, "bad_username");
  assert.deepEqual(Object.keys(st.players), []); // a refused name leaves nothing behind
  const r = S.createDen(st, TA, { username: "Alice" }, T0, { ip });
  assert.equal(r.ok, true);
  const p = st.players[TA];
  assert.deepEqual([p.username, p.watts, p.lifetimeWatts, p.joinHeight, p.publicId], ["Alice", BALANCE.WELCOME_WATTS, 0, 1000, pidOf(TA)]);
  assert.equal(S.tokenForPublicId(st, pidOf(TA)), TA);
  assert.equal(S.createDen(st, TA, { username: "Alice2" }, T0, { ip }).error, "den_exists");
  assert.equal(S.createDen(st, TB, { username: "alice" }, T0, { ip }).error, "username_taken"); // case-insensitive
  assert.deepEqual(Object.keys(st.players), [TA]);
  assert.equal(S.createDen(st, TB, { username: "Bob" }, T0, { ip, count: S.MAX_PLAYERS }).error, "server_full");
  assert.ok(S.createDen(st, TB, { username: "Bob" }, T0, { ip }).ok);
  // renaming an existing den still goes through setUsername
  assert.ok(S.setUsername(st, TB, { username: "Bobby" }).ok);
  assert.equal(S.setUsername(st, TB, { username: "ALICE" }).error, "username_taken");
});

test("names first: the new-den rate limit applies when a den is created", () => {
  const st = { height: 1, players: {} };
  const ip = "192.0.2.123";
  let made = 0, limited = 0;
  for (let i = 0; i < 70; i++) {
    const t = `ratelimit_${String(i).padStart(3, "0")}`.padEnd(20, "q");
    const r = S.createDen(st, t, { username: `rl_user_${i}` }, T0, { ip });
    if (r.ok) made++;
    else if (r.error === "too_many_dens") limited++;
  }
  assert.deepEqual([made, limited], [60, 10]);
});

test("purge: nameless dens go (with their feed lines and revenge entries); named dens stay; runs once", () => {
  const st = raidWorld();
  st.players[TA].username = "Keeper";
  st.players[TB].username = null; // nameless, even with a nick and a wallet
  st.players[TB].nick = "bob";
  st.players[TB].wallet = "0x" + "1".repeat(40);
  st.players[TC].username = "";
  st.players[TA].raidedBy = [{ pid: pidOf(TB), at: T0, avenged: false }, { pid: "someone", at: T0, avenged: false }];
  st.raidFeed = [{ at: 1, atkId: pidOf(TB), defId: pidOf(TA) }, { at: 2, atkId: "x", defId: "y" }, { at: 3, atkId: pidOf(TA), defId: pidOf(TC) }];
  S.tokenForPublicId(st, pidOf(TB)); // build the index first
  const removed = S.purgeNameless(st);
  assert.deepEqual(Object.keys(removed).sort(), [TB, TC].sort());
  assert.deepEqual(Object.keys(st.players), [TA]);
  assert.deepEqual(st.players[TA].raidedBy.map((e) => e.pid), ["someone"]);
  assert.deepEqual(st.raidFeed.map((e) => e.at), [2]);
  assert.equal(S.tokenForPublicId(st, pidOf(TB)), null);
  assert.equal(S.leaderboard(st, null, T0).total, 1);
  // the migration wrapper: flagged, logged, backed up, idempotent
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-purge-"));
  const bak = path.join(dir, "state.anon-purge.bak.json");
  const st2 = raidWorld();
  st2.players[TA].username = "Keeper";
  const lines = [];
  assert.equal(S.runMigrations(st2, T0, { backupFile: bak, log: (m) => lines.push(m) }), true);
  assert.deepEqual(Object.keys(st2.players), [TA]);
  assert.equal(st2.migrations.anonPurge1, new Date(T0).toISOString());
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(bak, "utf8")).players).sort(), [TB, TC].sort());
  assert.match(lines[0], /2 nameless dens deleted/);
  st2.players[TB] = Object.assign(S.newPlayer(1, T0, TB), { username: null }); // a later nameless den is NOT purged again
  assert.equal(S.runMigrations(st2, T0 + 1, { backupFile: bak, log: () => {} }), false);
  assert.ok(st2.players[TB]);
  fs.rmSync(dir, { recursive: true, force: true });
});

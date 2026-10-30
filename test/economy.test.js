// Economy + rules tests. Run from the repo root: node --test squeekroom/test/
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server.js");
const { BALANCE, CATALOG, accrue, canBuy, validatePlacement, certEligible } = S;

const T0 = Date.UTC(2026, 9, 30, 22, 0, 0);
const fresh = (over = {}) => Object.assign(S.newPlayer(1000, T0), over);
const own = (p, id, n = 1) => ((p.owned[id] = (p.owned[id] || 0) + n), p);
const TOKEN = "a".repeat(32);

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
    assert.ok(["wheel", "wallpaper", "floor", "rug", "furniture", "wall", "skin"].includes(i.cat));
  }
  const free = CATALOG.filter((i) => i.price === 0).map((i) => i.id).sort();
  assert.deepEqual(free, ["fl_pine", "skin_classic", "wp_plain"]);
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
test("new player: 400 W welcome grant, tier 0, defaults owned", () => {
  const p = fresh();
  assert.equal(p.watts, 400);
  assert.equal(p.wheelTier, 0);
  assert.equal(p.skin, "skin_classic");
  assert.equal(p.wallpaper, "wp_plain");
  assert.equal(p.floor, "fl_pine");
});

test("accrual: delta x 10 x tier multiplier", () => {
  const p = fresh();
  assert.equal(accrue(p, 10, T0), 100);
  assert.equal(p.watts, 500);
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
  assert.equal(p.watts, 400);
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
  assert.equal(st.players.a.watts, 400 + 5000);
  assert.equal(st.players.b.watts, 400 + 8000);
  assert.equal(st.players.late.watts, 400 + 1000); // only blocks after it joined
  // no double counting
  S.accrueAll(st, 1500, T0);
  S.accrueAll(st, 1490, T0);
  assert.equal(st.players.a.watts, 5400);
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
  const r = canBuy(fresh(), "fur_seed_bowl"); // 600 > 400
  assert.equal(r.ok, false);
  assert.equal(r.error, "poor");
  assert.equal(r.need, 200);
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
  for (const id of ["skin_classic", "wp_plain", "fl_pine"]) assert.equal(canBuy(p, id).error, "already_owned");
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

test("placement: reserved wheel (3-6) and burrow (16-18) columns", () => {
  const p = own(fresh(), "fur_bookshelf", 1); // 2 wide
  for (const x of [2, 3, 4, 5, 6, 15, 16, 17, 18]) assert.equal(validatePlacement(p, "fur_bookshelf", x, 11).error, "reserved", `x=${x}`);
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
  assert.equal(validatePlacement(p, "rug_rag", 5, 11).error, "reserved");
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
  assert.deepEqual(c.room, { wallpaper: "wp_plain", floor: "fl_pine", placed: [{ item: "fur_sofa", x: 8, y: 11, flip: true }] });
  assert.ok(!JSON.stringify(c).includes(TOKEN), "cert must not leak the token");

  // re-claim later: same cert, no new serial
  st.height = 9500;
  const again = S.claimCommemorative(st, TOKEN, T0 + 86_400_000);
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.deepEqual(again.cert, c);
  assert.equal(st.certSerial, 1);
});

// ---------- wheel duty (manual spinning while he sleeps) ----------
const TS = Date.UTC(2026, 9, 30, 12, 0, 0);
const ASLEEP = TS - BALANCE.MANUAL_IDLE_AFTER_MS - 60_000; // last block 11 min before TS
const freshS = (over = {}) => Object.assign(S.newPlayer(1000, TS), over);
const { applySpin, chainIdle } = S;
// Tick every `every` ms for `ms` in total, after a first (clock-starting) tick at `start`.
function spinFor(p, ms, every = 5000, start = TS, lastAdvanceAt = ASLEEP) {
  let t = start, credited = 0;
  assert.equal(applySpin(p, lastAdvanceAt, t).credited, 0); // starts the clock
  for (let left = ms; left > 0; left -= every) {
    t += Math.min(every, left);
    credited += applySpin(p, lastAdvanceAt, t).credited;
  }
  return { credited, t };
}

test("wheel duty: balance constants", () => {
  assert.equal(BALANCE.MANUAL_WATTS_PER_MIN, 15);
  assert.equal(BALANCE.MANUAL_DAILY_CAP_MIN, 120);
  assert.equal(BALANCE.MANUAL_IDLE_AFTER_MS, 600_000);
  assert.equal(BALANCE.MANUAL_TICK_MAX_MS, 10_000);
  assert.equal(BALANCE.MANUAL_TICK_MIN_MS, 2_000);
});

test("wheel duty: 15 W/min at tier 0, 24 W/min at T2 (wheel multiplier applies)", () => {
  const p = freshS();
  const r = spinFor(p, 60_000);
  assert.equal(r.credited, 15);
  assert.equal(p.watts, 400 + 15);
  assert.equal(p.lifetimeWatts, 15);
  assert.equal(applySpin(p, ASLEEP, r.t + 5000).wattsPerMin, 15);

  const q = freshS({ wheelTier: 2 });
  assert.equal(spinFor(q, 60_000).credited, 24);
  assert.equal(q.lifetimeWatts, 24);
  const t1 = freshS({ wheelTier: 1 }); // 18.75 W/min: fractions carry over exactly
  assert.equal(spinFor(t1, 4 * 60_000).credited, 75);
});

test("wheel duty: 0.2x a running hamster at the same tier", () => {
  // Settling, the hamster earns ~1.25 W/s at tier 0 (7.5 blocks a minute x BASE_WATTS_PER_BLOCK).
  const hamsterWPerMin = 1.25 * 60;
  assert.equal(7.5 * BALANCE.BASE_WATTS_PER_BLOCK, hamsterWPerMin);
  assert.equal(BALANCE.MANUAL_WATTS_PER_MIN / hamsterWPerMin, 0.2);
  // the multiplier scales both the same way, so the ratio holds at every tier
  for (let tier = 0; tier <= 5; tier++) {
    const p = freshS({ wheelTier: tier });
    const wpm = applySpin(p, ASLEEP, TS).wattsPerMin;
    assert.equal(wpm / ((hamsterWPerMin * BALANCE.WHEEL_MULT_PCT[tier]) / 100), 0.2, `tier ${tier}`);
  }
});

test("wheel duty: first tick and long gaps restart the clock; a normal 5 s tick credits 5 s", () => {
  const p = freshS();
  const first = applySpin(p, ASLEEP, TS);
  assert.equal(first.ok, true);
  assert.equal(first.credited, 0);
  assert.equal(first.started, true);
  assert.equal(p.lastSpinAt, TS);
  assert.equal(p.manualMsToday, 0);

  // 5 s later: 5 s x 15 W/min = 1.25 W -> 1 W now, 0.25 W carried
  const a = applySpin(p, ASLEEP, TS + 5000);
  assert.equal(a.credited, 1);
  assert.equal(a.creditedMs, 5000);
  assert.equal(a.msUsedToday, 5000);
  assert.equal(p.manualFrac, 0.25 * S.MANUAL_FRAC_DEN);

  // a 60 s gap: credits nothing (not even the 10 s clamp), just restarts the clock
  const gap = applySpin(p, ASLEEP, TS + 65_000);
  assert.equal(gap.credited, 0);
  assert.equal(gap.started, true);
  assert.equal(p.manualMsToday, 5000);
  assert.equal(p.lastSpinAt, TS + 65_000);

  // a late-but-recent tick (15 s) is clamped to MANUAL_TICK_MAX_MS
  const late = applySpin(p, ASLEEP, TS + 80_000);
  assert.equal(late.creditedMs, BALANCE.MANUAL_TICK_MAX_MS);
  assert.equal(p.manualMsToday, 15_000);

  // the page can restart the clock itself when a new spin begins
  const re = applySpin(p, ASLEEP, TS + 85_000, { restart: true });
  assert.equal(re.credited, 0);
  assert.equal(re.started, true);
  assert.equal(p.manualMsToday, 15_000);
});

test("wheel duty: ticks closer than 2 s are no-ops", () => {
  const p = freshS();
  applySpin(p, ASLEEP, TS);
  const early = applySpin(p, ASLEEP, TS + 1500);
  assert.equal(early.ok, true);
  assert.equal(early.noop, true);
  assert.equal(early.credited, 0);
  assert.equal(early.nextMs, 500);
  assert.equal(p.lastSpinAt, TS); // the clock is not moved by a no-op
  // spam cannot add time: the next real tick credits only real elapsed time
  for (let t = 100; t < 2000; t += 100) assert.equal(applySpin(p, ASLEEP, TS + t).noop, true);
  const ok = applySpin(p, ASLEEP, TS + 4000);
  assert.equal(ok.creditedMs, 4000);
  assert.equal(p.manualMsToday, 4000);
});

test("wheel duty: daily cap reached mid-tick credits only the remainder", () => {
  const cap = BALANCE.MANUAL_DAILY_CAP_MIN * 60_000;
  assert.equal(S.MANUAL_CAP_MS, cap);
  const day = new Date(TS).toISOString().slice(0, 10);
  const p = freshS({ manualDay: day, manualMsToday: cap - 3000, lastSpinAt: TS });
  const r = applySpin(p, ASLEEP, TS + 5000);
  assert.equal(r.creditedMs, 3000);
  assert.equal(r.msUsedToday, cap);
  assert.equal(r.msCapLeft, 0);
  assert.equal(p.watts, 400); // 3 s = 0.75 W: carried, not yet a whole watt
  const after = applySpin(p, ASLEEP, TS + 10_000);
  assert.equal(after.ok, true);
  assert.equal(after.creditedMs, 0);
  assert.equal(after.credited, 0);
  assert.equal(after.msCapLeft, 0);
  assert.equal(p.manualMsToday, cap);
  // a full day of honest spinning tops out at the cap: 120 min x 15 W/min
  const q = freshS();
  assert.equal(spinFor(q, cap + 30 * 60_000).credited, 1800);
  assert.equal(q.manualMsToday, cap);
});

test("wheel duty: UTC day rollover resets the cap", () => {
  const midnight = Date.UTC(2026, 9, 31, 0, 0, 0);
  const cap = S.MANUAL_CAP_MS;
  const p = freshS({ manualDay: "2026-10-30", manualMsToday: cap, lastSpinAt: midnight - 2000 });
  assert.equal(S.manualUsedToday(p, midnight - 1), cap);
  assert.equal(S.manualUsedToday(p, midnight), 0); // the page sees a fresh day before any tick
  const r = applySpin(p, midnight - 600_000 * 2, midnight + 3000);
  assert.equal(r.creditedMs, 5000); // the tick that crosses midnight counts toward the new day
  assert.equal(p.manualDay, "2026-10-31");
  assert.equal(r.msUsedToday, 5000);
  assert.equal(r.msCapLeft, cap - 5000);
});

test("wheel duty: hamster_awake while blocks are still settling", () => {
  const p = freshS();
  const recent = applySpin(p, TS - 60_000, TS); // a block 1 min ago
  assert.deepEqual(recent, { ok: false, error: "hamster_awake", idle: false });
  assert.equal(p.lastSpinAt, 0);
  assert.equal(applySpin(p, null, TS).error, "hamster_awake"); // height never observed
  assert.equal(applySpin(p, TS - BALANCE.MANUAL_IDLE_AFTER_MS + 1, TS).error, "hamster_awake");
  assert.equal(applySpin(p, TS - BALANCE.MANUAL_IDLE_AFTER_MS, TS).ok, true); // exactly 10 min quiet
  // live mode: a stale chain reading means we can't tell he's asleep
  assert.equal(chainIdle(ASLEEP, TS, TS - 10_000), true);
  assert.equal(chainIdle(ASLEEP, TS, TS - 600_000), false);
  assert.equal(chainIdle(ASLEEP, TS, 0), false);
  assert.equal(chainIdle(ASLEEP, TS, null), true); // demo mode: no freshness check
});

test("wheel duty: watts stay integers, fractions are never lost, activeDays counts", () => {
  for (let tier = 0; tier <= 5; tier++) {
    const p = freshS({ wheelTier: tier });
    let t = TS;
    applySpin(p, ASLEEP, t);
    let ms = 0;
    for (let i = 0; i < 400; i++) {
      const step = 2000 + ((i * 7919) % 8001); // 2..10 s, irregular
      t += step;
      ms += step;
      applySpin(p, ASLEEP, t);
      assert.ok(Number.isInteger(p.watts) && Number.isInteger(p.lifetimeWatts), `tier ${tier}`);
    }
    const exact = (ms * BALANCE.MANUAL_WATTS_PER_MIN * BALANCE.WHEEL_MULT_PCT[tier]) / S.MANUAL_FRAC_DEN;
    assert.equal(p.lifetimeWatts, Math.floor(exact), `tier ${tier}`);
    assert.equal(p.watts, 400 + p.lifetimeWatts);
    assert.equal(p.activeDays, 1);
  }
});

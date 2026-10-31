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
    assert.ok(["wheel", "bed", "room", "wallpaper", "floor", "rug", "furniture", "wall", "skin"].includes(i.cat));
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
  assert.equal(p.watts, 400 + 3);
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
    assert.equal(q.watts, 400 + q.lifetimeWatts);
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
  assert.equal(r.need, 2600);
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
  assert.deepEqual([RA.STAKE_MIN, RA.STAKE_MAX, RA.STAKE_MAX_BALANCE_PCT, RA.ELIGIBLE_MIN_PCT], [50, 5000, 20, 70]);
  assert.equal(RA.COOLDOWN_MS, 30 * 60_000);
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
  const a = fresh({ watts: 10_000 }), d = fresh({ watts: 10_000 });
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
  assert.equal(d.watts, 10_000);
});

test("resolveRaid: 5% crit x1.5, and loot never exceeds the defender's balance", () => {
  const a = fresh({ watts: 10_000 }), d = fresh({ watts: 10_000 });
  const c = S.resolveRaid(a, d, 1000, 300, seq(WIN, 0.5, 0.01));
  assert.deepEqual([c.loot, c.crit], [3000, true]);
  assert.equal(S.resolveRaid(a, d, 1000, 300, seq(WIN, 0.5, 0.0499)).crit, true);
  assert.equal(S.resolveRaid(a, d, 1000, 300, seq(WIN, 0.5, 0.05)).crit, false);
  const thin = fresh({ watts: 1200 });
  assert.equal(S.resolveRaid(a, thin, 1000, 300, seq(WIN, 0.5, 0.99)).loot, 1200); // 2000 -> capped
  assert.equal(S.resolveRaid(a, thin, 1000, 200, seq(WIN, 0.5, 0.99)).loot, 1000); // under the cap
  const crit = S.resolveRaid(a, thin, 1000, 200, seq(WIN, 0.5, 0.01)); // 1500 -> capped
  assert.deepEqual([crit.loot, crit.crit], [1200, true]);
  const big = fresh({ watts: 1e9 });
  const heist = S.resolveRaid(a, big, 5000, 1000, seq(WIN, 0.999999, 0.01));
  assert.ok(heist.loot <= Math.floor(9 * 5000 * 1.25 * 1.5));
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
  assert.deepEqual(r.result, { win: false, p: S.raidChance(fresh({ watts: 10_000 }), fresh({ watts: 10_000 }), 1000), stakeLost: 2000, stake: 2000, multPct: 1000, revenge: false });
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
    st.players[atk].lastRaidAt = 0; // skip the cooldown for the fuzz
    const { max } = S.stakeBounds(st.players[atk].watts);
    const stake = 50 + Math.floor(rng() * Math.max(1, max - 49));
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

test("raid stake bounds: integer in [50, min(20% of balance, 5000)]", () => {
  assert.deepEqual(S.stakeBounds(10_000), { min: 50, max: 2000 });
  assert.deepEqual(S.stakeBounds(10_004), { min: 50, max: 2000 }); // floor
  assert.deepEqual(S.stakeBounds(25_000), { min: 50, max: 5000 });
  assert.deepEqual(S.stakeBounds(1e9), { min: 50, max: 5000 });
  assert.deepEqual(S.stakeBounds(249), { min: 50, max: 49 }); // too poor to raid
  const st = raidWorld();
  for (const s of [49, 0, -100, 2001, 5000]) {
    const r = raid(st, TA, TB, s, 2);
    assert.deepEqual([r.ok, r.error, r.min, r.max], [false, "stake_out_of_range", 50, 2000], `stake ${s}`);
  }
  for (const s of [100.5, "100", null, undefined, NaN, Infinity]) assert.equal(raid(st, TA, TB, s, 2).error, "bad_stake", `stake ${s}`);
  assert.equal(st.players[TA].watts, 10_000); // nothing moved on a refusal
  assert.equal(st.players[TA].lastRaidAt, 0);
  assert.ok(raid(st, TA, TB, 2000, 2).ok);
  const st2 = raidWorld();
  assert.ok(raid(st2, TA, TB, 50, 2).ok);
  const broke = raidWorld({ atk: { watts: 200 }, def: { watts: 200 } });
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

test("raid cooldown: 30 min per attacker, starts at every resolved raid", () => {
  const st = raidWorld();
  const at = (t) => ((st.lastAdvanceAt = t - 1000), t); // keep him running
  assert.ok(raid(st, TA, TB, 100, 2, at(T0)).ok);
  const r = raid(st, TA, TB, 100, 2, at(T0 + 1000));
  assert.deepEqual([r.ok, r.error, r.cooldownMsLeft], [false, "cooldown", RA.COOLDOWN_MS - 1000]);
  assert.equal(raid(st, TA, TB, 100, 2, at(T0 + RA.COOLDOWN_MS - 1)).error, "cooldown");
  assert.deepEqual(S.raidStatus(st, st.players[TA], T0 + 60_000), { open: true, cooldownMsLeft: RA.COOLDOWN_MS - 60_000 });
  assert.ok(raid(st, TB, TA, 100, 2, at(T0 + 1000)).ok); // other attackers are not blocked
  assert.ok(raid(st, TA, TB, 100, 2, at(T0 + RA.COOLDOWN_MS)).ok);
  assert.equal(st.players[TA].lastRaidAt, T0 + RA.COOLDOWN_MS);
  // refused raids do not start the cooldown
  const st2 = raidWorld();
  raid(st2, TA, TB, 1, 2);
  assert.equal(S.raidStatus(st2, st2.players[TA], T0).cooldownMsLeft, 0);
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
  assert.deepEqual(S.raidStatus(st, st.players[TA], T0), { open: false, cooldownMsLeft: 0 });
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
    st.players[TA].lastRaidAt = 0;
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
  assert.deepEqual(lb.rows[1], { rank: 2, publicId: pidOf(TA), nick: "atk", watts: 10_000, lifetimeWatts: 900, roomTier: 2, raidable: false, revenge: false, you: true });
  assert.deepEqual(lb.rows.map((r) => r.raidable), [true, false, true]); // 8k >= 70% of 10k
  assert.deepEqual(lb.raid, { open: true, cooldownMsLeft: 0 });
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
  assert.ok(raid(st, TA, TB, 2000, 10, T0 + 1, seq(WIN, 0.999999, 0.01)).ok); // 9 x 2000 x 1.25 x 1.5 -> all 20k
  const after = S.leaderboard(st, TA, T0 + 2);
  assert.deepEqual(after.rows.map((r) => [r.nick, r.watts]), [["atk", 30_000], ["poor", 8000], ["def", 0]]);
  assert.equal(after.raid.cooldownMsLeft, RA.COOLDOWN_MS - 1);
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

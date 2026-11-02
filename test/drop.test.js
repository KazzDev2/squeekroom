// Burrow Drop preview: the physics must replay exactly, and the board must take more than it pays.
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../public/drop_sim.js");

test("drop: the same aim and seed give the same path, slot and pickups", () => {
  for (const [x, seed, crate] of [[40, 1, -1], [120, 99, 2], [200, 4242, 0]]) {
    const a = D.simulate(x, seed, { crate }), b = D.simulate(x, seed, { crate });
    assert.deepEqual(a.frames, b.frames);
    assert.deepEqual(a.events, b.events);
    assert.equal(a.slot, b.slot);
  }
  assert.notDeepEqual(D.simulate(120, 1).frames, D.simulate(120, 2).frames); // the hidden wobble
});

test("drop: every drop ends in a chamber, and before the stash a drop pays back less than it costs", () => {
  let pay = 0, n = 0;
  for (let xi = 0; xi < 21; xi++) {
    const x = D.LEFT + 9 + (xi * (D.RIGHT - D.LEFT - 18)) / 20;
    for (let s = 1; s <= 30; s++) {
      const r = D.simulate(x, s * 7919 + xi);
      assert.ok(r.slot >= 0 && r.slot < D.SLOTS.length);
      assert.ok(r.frames.length / 3 < 60 * 25, "never runs out the clock");
      let p = r.slotId === "stash" ? 0 : D.PAY[r.slotId], chain = 0, lastF = -999;
      for (const e of r.events) if (e.kind === "seed") { chain = e.f - lastF < D.PAY.COMBO_FRAMES ? chain + 1 : 1; lastF = e.f; p += (D.PAY.SEED_PCT / 100) * Math.min(chain, D.PAY.COMBO_MAX); }
      pay += p; n++;
    }
  }
  const ev = pay / n;
  assert.ok(ev > 0.7 && ev < 0.95, `EV before the stash ${ev.toFixed(3)}`);
});

// ---------- the real thing: the server rolls every drop ----------
const S = require("../server.js");
const B = S.BALANCE.DROP;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0), TK = "d".repeat(32);
function dropWorld(watts = 100_000, board = { golden: false, crate: -1, prize: null }) {
  const p = Object.assign(S.newPlayer(1000, T0, TK), { watts, username: "Dropper" });
  p.drop = { n: 0, lastAt: 0, board };
  return { st: { players: { [TK]: p }, raidFeed: [], burned: 0 }, p };
}
const findSeed = (aim, opts, want) => { for (let s = 1; s < 20_000; s++) if (want(D.simulate(aim, s, opts))) return s; throw new Error("no seed"); };

test("drop: costs COST, pays what the board pays, and the browser replays the same path from the seed", () => {
  const board = { golden: false, crate: -1, prize: null };
  const seed = findSeed(100, { crate: -1, prize: -1 }, (r) => r.slotId === "pantry" && r.seeds >= 2);
  const { st, p } = dropWorld(100_000, board);
  const r = S.playDrop(st, TK, { aim: 100 }, T0, { seed });
  assert.equal(r.ok, true);
  const R = r.result, sim = D.simulate(R.aim, R.seed, { crate: R.board.crate, prize: -1 });
  assert.equal(sim.slot, R.slot);
  assert.equal(R.land, Math.round(B.COST * D.PAY.pantry));
  assert.ok(R.seeds >= Math.round((B.COST * D.PAY.SEED_PCT * 3) / 100)); // two in a row: 1x then 2x
  assert.equal(p.watts, 100_000 - B.COST + R.total);
  assert.equal(p.lifetimeWatts, S.newPlayer(1000, T0).lifetimeWatts, "drop winnings are not earnings");
  assert.notEqual(r.board, board, "a fresh board after every drop");
  assert.ok(S.validDropBoard(r.board));
  assert.equal(p.drop.n, 1);
});

test("drop: golden boards pay seeds twice; aim is clamped to the rail", () => {
  const seed = findSeed(D.AIM_MAX, { crate: -1, prize: -1 }, (r) => r.seeds >= 1);
  const plain = S.playDrop(dropWorld().st, TK, { aim: 9999 }, T0, { seed }).result;
  const gold = S.playDrop(dropWorld(100_000, { golden: true, crate: -1, prize: null }).st, TK, { aim: 9999 }, T0, { seed }).result;
  assert.equal(plain.aim, D.AIM_MAX);
  assert.equal(gold.slot, plain.slot);
  assert.equal(gold.seeds, plain.seeds * 2);
});

test("drop: hitting the prize wins it; a second copy pays its DUP_WATTS instead", () => {
  const spot = D.PRIZE_SPOTS.findIndex((s) => s.tier === "rare");
  const board = { golden: false, crate: -1, prize: { item: "fur_coin_jar", spot } };
  let aim = 0, seed = 0;
  for (const a of [56, 68, 84, 102, 120]) { try { seed = findSeed(a, { crate: -1, prize: spot }, (r) => r.prizeHit); aim = a; break; } catch {} }
  assert.ok(seed, "some aim reaches the rare spot");
  const { st, p } = dropWorld(100_000, board);
  const r1 = S.playDrop(st, TK, { aim }, T0, { seed });
  assert.deepEqual(r1.result.prize, { item: "fur_coin_jar", rarity: "rare", dup: 0 });
  assert.equal(p.owned.fur_coin_jar, 1);
  p.drop.board = board; // the same board again (as if it came round twice)
  const before = p.watts;
  const r2 = S.playDrop(st, TK, { aim }, T0 + B.MIN_GAP_MS, { seed });
  assert.deepEqual(r2.result.prize, { item: "fur_coin_jar", rarity: "rare", dup: B.DUP_WATTS.rare });
  assert.equal(p.owned.fur_coin_jar, 1);
  assert.equal(p.watts, before - B.COST + r2.result.total);
});

test("drop: a crate knocked loose gives the usual crate contents", () => {
  const seed = findSeed(60, { crate: 0, prize: -1 }, (r) => r.crateHit);
  const { st, p } = dropWorld(100_000, { golden: false, crate: 0, prize: null });
  const r = S.playDrop(st, TK, { aim: 60 }, T0, { seed, rng: () => 0.01 }); // the crate table's first row: watts
  assert.equal(r.result.crate.kind, "watts");
  assert.equal(p.watts, 100_000 - B.COST + r.result.total);
});

test("drop: the stash grows with every drop (no cap) and pays out everything in it on a stash landing", () => {
  const board = { golden: false, crate: -1, prize: null };
  const miss = findSeed(120, { crate: -1, prize: -1 }, (r) => r.slotId !== "stash");
  const { st, p } = dropWorld(1e7, board);
  S.playDrop(st, TK, { aim: 120 }, T0, { seed: miss });
  assert.equal(st.drop.stash, B.COST * B.STASH_START + (B.COST * B.STASH_FEED_PCT) / 100);
  st.drop.stash = 123_456;
  p.drop.board = board;
  S.playDrop(st, TK, { aim: 120 }, T0 + 2000, { seed: miss });
  assert.equal(st.drop.stash, 123_456 + (B.COST * B.STASH_FEED_PCT) / 100, "keeps growing");
  let aim = 0, hit = 0;
  for (const a of [140, 100, 120, 160, 80]) { try { hit = findSeed(a, { crate: -1, prize: -1 }, (r) => r.slotId === "stash"); aim = a; break; } catch {} }
  p.drop.board = board;
  const r = S.playDrop(st, TK, { aim }, T0 + 4000, { seed: hit });
  assert.equal(r.result.slotId, "stash");
  assert.equal(r.result.stashWon, 123_456 + (2 * B.COST * B.STASH_FEED_PCT) / 100, "the whole pot");
  assert.equal(st.drop.stash, B.COST * B.STASH_START);
});

test("drop: a Bounty win is saved and posted in the feed; other drops aren't", () => {
  const board = { golden: false, crate: -1, prize: null };
  const miss = findSeed(120, { crate: -1, prize: -1 }, (r) => r.slotId !== "stash");
  let aim = 0, hit = 0;
  for (const a of [140, 100, 120, 160, 80]) { try { hit = findSeed(a, { crate: -1, prize: -1 }, (r) => r.slotId === "stash"); aim = a; break; } catch {} }
  const { st, p } = dropWorld(1e7, board);
  p.username = "Winner";
  const m = S.playDrop(st, TK, { aim: 120 }, T0, { seed: miss });
  assert.equal(m.lastWin, null, "nobody has won it yet");
  assert.equal((st.drop.wins || []).length, 0);
  assert.equal((st.raidFeed || []).length, 0);

  p.drop.board = board;
  const r = S.playDrop(st, TK, { aim }, T0 + 2000, { seed: hit });
  const amount = r.result.stashWon;
  assert.deepEqual(st.drop.wins, [{ at: T0 + 2000, name: "Winner", pid: p.publicId, amount }]);
  assert.deepEqual(r.lastWin, { name: "Winner", amount, at: T0 + 2000 });
  const feed = st.raidFeed[st.raidFeed.length - 1];
  assert.deepEqual([feed.kind, feed.atk, feed.atkId, feed.defId, feed.amount, feed.win], ["bounty", "Winner", p.publicId, null, amount, true]);

  st.drop.wins = Array.from({ length: B.WINS_MAX }, (_, i) => ({ at: i, name: "old", pid: "x", amount: 1 }));
  p.drop.board = board;
  p.drop.lastAt = 0;
  const again = S.playDrop(st, TK, { aim }, T0 + 4000, { seed: hit });
  assert.equal(st.drop.wins.length, B.WINS_MAX, "only the newest are kept");
  assert.equal(again.lastWin.at, T0 + 4000);
});

test("drop: refusals move nothing (bad aim, too fast, too poor)", () => {
  const { st, p } = dropWorld(100_000);
  for (const aim of [undefined, "50", NaN, Infinity, null]) assert.equal(S.playDrop(st, TK, { aim }, T0).error, "bad_aim");
  assert.ok(S.playDrop(st, TK, { aim: 100 }, T0).ok);
  const w = p.watts, board = p.drop.board;
  assert.equal(S.playDrop(st, TK, { aim: 100 }, T0 + B.MIN_GAP_MS - 1).error, "too_fast");
  assert.equal(p.watts, w);
  assert.equal(p.drop.board, board, "the board waits for a real drop");
  p.watts = B.COST - 1;
  assert.deepEqual(S.playDrop(st, TK, { aim: 100 }, T0 + 10_000), { ok: false, error: "poor", need: 1 });
  assert.equal(S.playDrop(st, "e".repeat(32), { aim: 100 }, T0).error, "unknown_player");
});

test("drop: boards are valid, odds follow PRIZE_PCT, and a stored board is kept until a drop uses it", () => {
  const n = 20_000, count = {};
  for (let k = 0; k < n; k++) {
    const b = S.newDropBoard();
    assert.ok(S.validDropBoard(b));
    const t = S.CATALOG_BY_ID.get(b.prize.item).rarity;
    count[t] = (count[t] || 0) + 1;
  }
  for (const t of S.RARITIES) assert.ok(Math.abs((count[t] / n) * 100 - B.PRIZE_PCT[t]) < 1.5, `${t}: ${count[t]}`);
  const p = S.newPlayer(1000, T0);
  const b1 = S.dropBoard(p);
  assert.equal(S.dropBoard(p), b1);
  assert.ok(!S.validDropBoard({ golden: false, crate: -1, prize: { item: "fur_crystal_geode", spot: 0 } }), "a legendary on a common spot");
  assert.ok(!S.validDropBoard({ golden: false, crate: 9, prize: null }));
  assert.ok(!S.validDropBoard({ golden: false, crate: -1, prize: { item: "fur_sofa", spot: 0 } }), "not a drop item");
});

test("drop: prizes are never sold and never free", () => {
  const ids = S.DROP_ITEMS.map((i) => i.id);
  assert.equal(ids.length, 8);
  for (const r of S.RARITIES) assert.ok(S.DROP_ITEMS.some((i) => i.rarity === r), r);
  for (const id of ids) {
    assert.deepEqual(S.canBuy(S.newPlayer(1000, T0), id), { ok: false, error: "drop_only" });
    assert.ok(!S.FREE_IDS.includes(id) && !(id in S.newPlayer(1000, T0).owned), id);
  }
  for (const t of S.RARITIES) assert.ok(D.PRIZE_SPOTS.some((s) => s.tier === t), `a spot for ${t}`);
});

// ---------- wagers ----------
test("drop wager: chambers and seeds scale, 5% feeds the Bounty, the browser replays it", () => {
  const board = { golden: false, crate: -1, prize: null };
  const seed = findSeed(100, { crate: -1, prize: -1 }, (r) => r.slotId === "pantry" && r.seeds >= 2);
  const small = dropWorld(1e7, board), big = dropWorld(1e7, board);
  const a = S.playDrop(small.st, TK, { aim: 100, wager: 500 }, T0, { seed }).result;
  const b = S.playDrop(big.st, TK, { aim: 100, wager: 5000 }, T0, { seed }).result;
  assert.deepEqual([a.wager, b.wager], [500, 5000]);
  assert.equal(b.slot, a.slot, "no prize on the board: the same path");
  assert.equal(b.land, a.land * 10);
  assert.equal(b.seeds, a.seeds * 10);
  assert.equal(big.p.watts, 1e7 - 5000 + b.total);
  assert.equal(big.st.drop.stash, B.COST * B.STASH_START + 250);
  assert.equal(D.simulate(b.aim, b.seed, { crate: -1, prize: -1, prizeR: D.prizeRadius(b.wager) }).slot, b.slot);
});

test("drop wager: no wager means the minimum; bad or unaffordable wagers move nothing", () => {
  const { st, p } = dropWorld(2000);
  for (const wager of [499, 0, -500, 1000.5, "1000", null, NaN, Infinity]) assert.equal(S.playDrop(st, TK, { aim: 100, wager }, T0).error, "bad_wager", String(wager));
  assert.deepEqual(S.playDrop(st, TK, { aim: 100, wager: 2001 }, T0), { ok: false, error: "poor", need: 1 });
  assert.equal(p.watts, 2000);
  assert.equal(st.drop, undefined, "nothing fed the Bounty");
  assert.equal(S.playDrop(st, TK, { aim: 100 }, T0).result.wager, B.COST);
  const all = dropWorld(2000);
  assert.equal(S.playDrop(all.st, TK, { aim: 100, wager: 2000 }, T0).result.wager, 2000, "all in is allowed");
});

test("drop wager: the Bounty pays the whole pot, whatever the wager", () => {
  const board = { golden: false, crate: -1, prize: null };
  let aim = 0, hit = 0;
  for (const a of [140, 100, 120, 160, 80]) { try { hit = findSeed(a, { crate: -1, prize: -1 }, (r) => r.slotId === "stash"); aim = a; break; } catch {} }
  for (const wager of [500, 40_000]) {
    const { st } = dropWorld(1e6, board);
    st.drop = { stash: 9000 };
    const r = S.playDrop(st, TK, { aim, wager }, T0, { seed: hit }).result;
    assert.equal(r.stashWon, 9000 + Math.round(wager * 0.05));
    assert.equal(st.drop.stash, B.COST * B.STASH_START);
  }
});

test("drop wager: a bigger wager grows the prize target and never changes the board", () => {
  assert.deepEqual([500, 999, 1000, 2500, 5000, 10_000, 1e7].map(D.prizeRadius), [7, 7, 8, 9, 10, 11, 11]);
  const spot = D.PRIZE_SPOTS.findIndex((s) => s.tier === "legendary"), board = { golden: false, crate: -1, prize: { item: "fur_crystal_geode", spot } };
  // a drop that only the big target catches
  let aim = 0, seed = 0;
  outer: for (let a = D.AIM_MIN; a < D.AIM_MAX; a += 6) for (let s = 1; s < 1500; s++) if (D.simulate(a, s, { crate: -1, prize: spot, prizeR: 11 }).prizeHit && !D.simulate(a, s, { crate: -1, prize: spot, prizeR: 7 }).prizeHit) { aim = a; seed = s; break outer; }
  assert.ok(seed, "found one");
  const low = dropWorld(1e6, board), high = dropWorld(1e6, board);
  const lo = S.playDrop(low.st, TK, { aim, wager: 500 }, T0, { seed, rng: () => 0.99 }), hi = S.playDrop(high.st, TK, { aim, wager: 10_000 }, T0, { seed, rng: () => 0.99 });
  assert.equal(lo.result.prize, null);
  assert.equal(hi.result.prize.item, "fur_crystal_geode");
  assert.deepEqual(lo.result.board, hi.result.board, "the same board either way");
  assert.ok(D.simulate(hi.result.aim, hi.result.seed, { crate: -1, prize: spot, prizeR: D.prizeRadius(hi.result.wager) }).prizeHit, "the browser replays the win");
});

test("drop wager: duplicates and crate watts scale, and a big wager still pays back less than it costs", () => {
  const spot = D.PRIZE_SPOTS.findIndex((s) => s.tier === "common"), board = { golden: false, crate: -1, prize: { item: "fur_seed_sack", spot } };
  let aim = 0, seed = 0;
  outer: for (let a = D.AIM_MIN; a < D.AIM_MAX; a += 6) for (let s = 1; s < 400; s++) if (D.simulate(a, s, { crate: -1, prize: spot, prizeR: D.prizeRadius(5000) }).prizeHit) { aim = a; seed = s; break outer; }
  const w = dropWorld(1e6, board);
  w.p.owned.fur_seed_sack = 1;
  assert.equal(S.playDrop(w.st, TK, { aim, wager: 5000 }, T0, { seed }).result.prize.dup, B.DUP_WATTS.common * 10);
  const cs = findSeed(60, { crate: 0, prize: -1 }, (r) => r.crateHit), c = dropWorld(1e6, { golden: false, crate: 0, prize: null });
  const cr = S.playDrop(c.st, TK, { aim: 60, wager: 5000 }, T0, { seed: cs, rng: () => 0.01 }).result;
  assert.equal(cr.crate.kind, "watts");
  assert.ok(cr.crate.watts >= S.BALANCE.CRATES.WATTS_MIN * 10);
  // the house still wins on a big wager, with every prize owned, away from the Bounty
  const { st, p } = dropWorld(1e12);
  for (const it of S.DROP_ITEMS) p.owned[it.id] = 1;
  let inW = 0, out = 0, t = T0;
  for (let k = 0; k < 800; k++) { t += B.MIN_GAP_MS; const r = S.playDrop(st, TK, { aim: D.AIM_MIN + (k % 23) * ((D.AIM_MAX - D.AIM_MIN) / 22), wager: 10_000 }, t).result; inW += r.wager; out += r.total - r.stashWon; }
  assert.ok(out / inW < 1, `returns ${(out / inW).toFixed(3)}`);
});

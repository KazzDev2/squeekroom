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

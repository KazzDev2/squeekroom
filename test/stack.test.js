// Stacking: furniture standing on furniture with a flat top. The server works out every height.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server.js");
const { validatePlacement, stackAbove, moveStack, CATALOG_BY_ID, ROOM } = S;

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const fresh = () => {
  const p = S.newPlayer(1000, T0);
  p.fixtures = { wheel: { i: 9, j: 5, flip: true }, bed: { i: 9, j: 1, flip: false } }; // out of the way
  return p;
};
const put = (p, pid, item, x, y, opts = {}) => {
  p.owned[item] = (p.owned[item] || 0) + 1;
  const e = { pid, item, x, y, flip: !!opts.flip };
  if (opts.z) e.z = opts.z;
  p.placed.push(e);
  return e;
};
const top = (id) => CATALOG_BY_ID.get(id).top;

test("stack: flat tops are only on furniture, and fit their art", () => {
  for (const it of S.CATALOG) {
    if (it.top == null) continue;
    assert.equal(it.zone, "floor", it.id);
    assert.ok(Number.isInteger(it.top) && it.top > 0 && it.top <= 16 * it.h + 8, `${it.id} top ${it.top}`);
  }
  assert.ok(S.CATALOG.filter((i) => i.top && !i.colorOf).length >= 30);
});

test("stack: an item on a table stands at the table's top", () => {
  const p = fresh();
  put(p, "t", "fur_coffee_table", 3, 3); // tiles (3..4, 3)
  p.owned.fur_mug = 1;
  assert.deepEqual(validatePlacement(p, "fur_mug", 3, 3).z, top("fur_coffee_table"));
  assert.deepEqual(validatePlacement(p, "fur_mug", 4, 3).z, top("fur_coffee_table"));
  assert.equal(validatePlacement(p, "fur_mug", 5, 3).z, 0, "beside it: the floor");
});

test("stack: heights add up, and a stack has a limit", () => {
  const p = fresh();
  p.owned.fur_wood_crate = 50;
  let z = 0, n = 0;
  for (;;) {
    const v = validatePlacement(p, "fur_wood_crate", 2, 2);
    if (!v.ok) { assert.equal(v.error, "too_high"); break; }
    assert.equal(v.z, z);
    p.placed.push({ pid: "c" + n++, item: "fur_wood_crate", x: 2, y: 2, flip: false, ...(z ? { z } : {}) });
    z += top("fur_wood_crate");
  }
  assert.ok(n >= 5, `${n} crates high`);
  assert.equal(validatePlacement(p, "fur_wood_crate", 2, 2).error, "too_high");
});

test("stack: nothing stands on things without a flat top", () => {
  const p = fresh();
  put(p, "s", "fur_sofa", 3, 3);
  p.owned.fur_mug = 1;
  assert.equal(validatePlacement(p, "fur_mug", 4, 3).error, "overlap");
  const q = fresh();
  put(q, "t", "fur_side_table", 3, 3);
  put(q, "m", "fur_mug", 3, 3, { z: top("fur_side_table") });
  q.owned.fur_cupcake = 1;
  assert.equal(validatePlacement(q, "fur_cupcake", 3, 3).error, "overlap", "the mug is in the way");
});

test("stack: every tile needs the same height", () => {
  const p = fresh();
  put(p, "c", "fur_wood_crate", 3, 3);
  p.owned.fur_coffee_table = 1;
  assert.equal(validatePlacement(p, "fur_coffee_table", 3, 3).error, "uneven", "half on the crate");
  put(p, "d", "fur_wood_crate", 4, 3);
  assert.equal(validatePlacement(p, "fur_coffee_table", 3, 3).z, top("fur_wood_crate"), "across two crates");
  put(p, "m", "fur_milk_crate", 3, 5);
  put(p, "n", "fur_wood_crate", 4, 5);
  assert.equal(validatePlacement(p, "fur_coffee_table", 3, 5).error, "uneven", "two different heights");
});

test("stack: the wheel and the bed still keep their tiles", () => {
  const p = fresh();
  p.fixtures.bed = { i: 4, j: 3, flip: false }; // tiles (3..4, 3)
  p.owned.fur_coffee_table = 1;
  assert.deepEqual(validatePlacement(p, "fur_coffee_table", 2, 3), { ok: false, error: "fixture", which: "bed" });
});

test("stack: a move takes what stands on it, all the way up", () => {
  const p = fresh();
  const t = put(p, "t", "fur_coffee_table", 2, 2); // tiles (2..3, 2)
  const b = put(p, "b", "fur_wood_crate", 3, 2, { z: top("fur_coffee_table") });
  const m = put(p, "m", "fur_mug", 3, 2, { z: top("fur_coffee_table") + top("fur_wood_crate") });
  assert.deepEqual([...stackAbove(p, t).up].sort(), ["b", "m", "t"]);
  assert.equal(stackAbove(p, t).loose, null);
  const v = validatePlacement(p, "fur_coffee_table", 5, 6, "t", false);
  assert.equal(v.z, 0);
  moveStack(p, t, v.x, v.y, v.z, false);
  assert.deepEqual([t.x, t.y, b.x, b.y, m.x, m.y], [5, 6, 6, 6, 6, 6]);
  assert.deepEqual([t.z, b.z, m.z], [undefined, top("fur_coffee_table"), top("fur_coffee_table") + top("fur_wood_crate")]);
});

test("stack: moving keeps the tiles it leaves free, and can land on its own old spot", () => {
  const p = fresh();
  const t = put(p, "t", "fur_coffee_table", 2, 2);
  put(p, "m", "fur_mug", 2, 2, { z: top("fur_coffee_table") });
  const v = validatePlacement(p, "fur_coffee_table", 3, 2, "t", false); // one tile along: over its own old tile
  assert.ok(v.ok);
  assert.equal(v.z, 0, "it does not stand on what it carries");
});

test("stack: turning a table mirrors what is on it across its back tile", () => {
  const p = fresh();
  const t = put(p, "t", "fur_dining_table", 2, 2); // tiles (2..4, 2)
  const m = put(p, "m", "fur_mug", 4, 2, { z: top("fur_dining_table") });
  const c = put(p, "c", "fur_coffee_table", 2, 2, { z: top("fur_dining_table") }); // tiles (2..3, 2)
  const v = validatePlacement(p, "fur_dining_table", 2, 2, "t", true);
  assert.ok(v.ok);
  moveStack(p, t, 2, 2, v.z, true);
  assert.deepEqual([t.flip, c.flip, c.x, c.y], [true, true, 2, 2]);
  assert.deepEqual([m.x, m.y, m.flip], [2, 4, true]);
  const on = new Set(S.footprint(CATALOG_BY_ID.get("fur_dining_table"), t.x, t.y, t.flip).map(String));
  for (const e of [m, c]) for (const tile of S.footprint(CATALOG_BY_ID.get(e.item), e.x, e.y, e.flip)) assert.ok(on.has(String(tile)), `${e.item} ${tile}`);
});

test("stack: a move takes the moved item down to the floor or up onto another top", () => {
  const p = fresh();
  const a = put(p, "a", "fur_side_table", 2, 2);
  const b = put(p, "b", "fur_nightstand", 6, 2);
  const m = put(p, "m", "fur_mug", 2, 2, { z: top("fur_side_table") });
  let v = validatePlacement(p, "fur_mug", 6, 2, "m", false);
  assert.equal(v.z, top("fur_nightstand"));
  moveStack(p, m, v.x, v.y, v.z, false);
  assert.equal(m.z, top("fur_nightstand"));
  v = validatePlacement(p, "fur_mug", 4, 4, "m", false);
  assert.equal(v.z, 0);
  moveStack(p, m, v.x, v.y, v.z, false);
  assert.ok(!("z" in m), "no z on the floor");
  assert.deepEqual([...stackAbove(p, a).up], ["a"]);
  assert.deepEqual([...stackAbove(p, b).up], ["b"]);
});

test("stack: a plank across two crates holds both of them still", () => {
  const p = fresh();
  const c = put(p, "c", "fur_wood_crate", 3, 3);
  put(p, "d", "fur_wood_crate", 4, 3);
  put(p, "t", "fur_coffee_table", 3, 3, { z: top("fur_wood_crate") });
  const s = stackAbove(p, c);
  assert.equal(s.loose.pid, "t");
  assert.equal(validatePlacement(p, "fur_wood_crate", 6, 6, "c", false).error, "holding");
  assert.ok(validatePlacement(p, "fur_coffee_table", 6, 6, "t", false).ok, "the plank itself can go");
  assert.ok(validatePlacement(p, "fur_wood_crate", 3, 3, "c", true).error === "holding");
});

test("stack: a stack can't be carried past the limit", () => {
  const p = fresh();
  let z = 0;
  for (let n = 0; n < 4; n++) { put(p, "c" + n, "fur_wood_crate", 2, 2, { z }); z += top("fur_wood_crate"); }
  put(p, "base", "fur_filing_cabinet", 6, 6);
  put(p, "base2", "fur_filing_cabinet", 8, 3);
  put(p, "riser", "fur_server_rack", 8, 3, { z: top("fur_filing_cabinet") });
  assert.equal(validatePlacement(p, "fur_wood_crate", 8, 3, "c0", false).error, "too_high"); // 28 + 40 + 48 of crates over the first
  assert.ok(validatePlacement(p, "fur_wood_crate", 6, 6, "c0", false).ok); // 28 + 48
});

test("stack: rugs and wall decor have no heights", () => {
  const p = fresh();
  p.owned.rug_rag = 1;
  p.owned.wall_pennant = 1;
  put(p, "t", "fur_side_table", 3, 3);
  assert.equal(validatePlacement(p, "rug_rag", 3, 3).z, 0);
  assert.equal(validatePlacement(p, "wall_pennant", 3, 3).z, undefined);
});

test("stack: visitors see the heights", () => {
  const st = { players: {} };
  const p = fresh();
  p.publicId = "abc";
  put(p, "t", "fur_side_table", 3, 3);
  put(p, "m", "fur_mug", 3, 3, { z: top("fur_side_table") });
  const placed = S.denView(st, p, null, T0).den.placed;
  assert.equal(placed[0].z, undefined);
  assert.equal(placed[1].z, top("fur_side_table"));
});

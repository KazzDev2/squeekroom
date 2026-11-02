// Burrow Drop: the board and its physics. Pure and deterministic (only + - * / and sqrt, and a seeded
// rng), so a server can run the very same drop later and the browser only replays the path it gets.
//   BurrowDrop.simulate(dropX, seed, { crate }) -> { frames: [x, y, angle, ...], events, slot, slotFrame }
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.BurrowDrop = m;
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const W = 240, H = 360, BALL_R = 7, RAIL_Y = 30;
const LEFT = 10, RIGHT = 230; // inner faces of the side walls
const G = 0.09, MAX_V = 6.5, SUB = 2, MAX_FRAMES = 60 * 25;
const DIV_TOP = 316, FLOOR = H - 4;
const WHEEL = { x: 120, y: 186, r: 22, omega: 0.045 }; // a free-spinning wheel: it flings what it touches
const ACORNS = [{ x: 52, y: 160, r: 8 }, { x: 188, y: 205, r: 8 }];
const ROOT_CURVES = [
  [[LEFT, 92], [50, 88], [84, 118]],
  [[RIGHT, 132], [196, 128], [160, 156]],
  [[LEFT + 21, 254], [38, 246], [66, 232]], // the low roots climb away from the walls (a gap at the wall,
  [[RIGHT - 21, 272], [202, 264], [178, 250]], // so what rolls down them drops to the edge chambers)
];
// the chambers at the bottom, left to right
const SLOTS = [
  { id: "dead", w: 30 }, { id: "nest", w: 34 }, { id: "pantry", w: 37 }, { id: "stash", w: 18 },
  { id: "pantry", w: 37 }, { id: "nest", w: 34 }, { id: "dead", w: 30 },
];

// payouts, as multiples of the drop cost. Seeds pay SEED_PCT of the cost, more in a chain. Tuned on
// simulated drops through the server (crates, duplicate prizes and a full stash included): about 0.89
// back per drop on average and 0.955 at the best aim, so no aim beats the house.
const PAY = { dead: 0.2, nest: 0.6, pantry: 1.4, SEED_PCT: 1, COMBO_MAX: 5, COMBO_FRAMES: 90 };
// Where a prize can sit, by rarity: measured reach (the best aim, how often the ball passes close
// enough) is about 0.7-0.9 for common spots, 0.4-0.5 uncommon, 0.3 rare, 0.13-0.17 epic, 0.05-0.07
// legendary. A prize is a 7-px target, knocked loose like the crate.
const PRIZE_SPOTS = [
  ["common", 84, 160], ["common", 172, 120], ["common", 116, 144],
  ["uncommon", 156, 256], ["uncommon", 44, 264], ["uncommon", 220, 256],
  ["rare", 204, 216], ["rare", 68, 296], ["rare", 84, 240],
  ["epic", 204, 184], ["epic", 36, 176], ["epic", 188, 272],
  ["legendary", 28, 176], ["legendary", 196, 152],
].map(([tier, x, y]) => ({ tier, x, y, r: 7 }));

// A bigger wager makes the prize easier to hit: its target grows, the board never changes (so a wager
// can't re-roll a board). Fixed steps, no logs, so server and browser always agree.
const PRIZE_R = [[10_000, 11], [5000, 10], [2500, 9], [1000, 8]];
const prizeRadius = (wager) => { for (const [w, r] of PRIZE_R) if (wager >= w) return r; return 7; };

function rng32(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const quad = (c, t) => { const u = 1 - t; return [u * u * c[0][0] + 2 * u * t * c[1][0] + t * t * c[2][0], u * u * c[0][1] + 2 * u * t * c[1][1] + t * t * c[2][1]]; };
const dist = (ax, ay, bx, by) => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));

// ---------- the board (fixed: the same for every drop) ----------
const roots = ROOT_CURVES.map((c) => {
  let len = 0, prev = quad(c, 0);
  for (let k = 1; k <= 40; k++) { const p = quad(c, k / 40); len += dist(p[0], p[1], prev[0], prev[1]); prev = p; }
  const n = Math.ceil(len / 4), pts = [];
  for (let k = 0; k <= n; k++) { const p = quad(c, k / n); pts.push({ x: p[0], y: p[1], r: 2.5 }); }
  return pts;
});
const rootPts = roots.flat();
const pebbles = [];
for (let k = 0; k <= 10; k++) {
  const y = 64 + k * 22;
  for (let x = LEFT + 14 + (k % 2) * 13; x <= RIGHT - 10; x += 26) {
    if (dist(x, y, WHEEL.x, WHEEL.y) < WHEEL.r + 3.5 + 16) continue;
    if (ACORNS.some((a) => dist(x, y, a.x, a.y) < a.r + 3.5 + 15)) continue;
    if (rootPts.some((p) => dist(x, y, p.x, p.y) < 20)) continue;
    pebbles.push({ x, y, r: 3.5 });
  }
}
// seeds rest on the roots; crates wedge at a root's tip
const seeds = [];
for (const c of ROOT_CURVES) for (const t of [0.3, 0.6, 0.88]) { const p = quad(c, t); seeds.push({ x: p[0], y: p[1] - 6, r: 4 }); }
const crateSpots = ROOT_CURVES.map((c) => { const p = quad(c, 1); return { x: p[0] + (c[0][0] < W / 2 ? 4 : -4), y: p[1] - 9, r: 7 }; });
// one pebble guards the stash: only a sideways bounce gets in
{ let x = LEFT; for (let i = 0; i < SLOTS.length; i++) { if (SLOTS[i].id === "stash") pebbles.push({ x: x + SLOTS[i].w / 2, y: 300, r: 2, guard: true }); x += SLOTS[i].w; } }
const dividers = [];
{ let x = LEFT; for (let i = 0; i < SLOTS.length - 1; i++) { x += SLOTS[i].w; dividers.push(x); } }
const slotAt = (x) => { let edge = LEFT; for (let i = 0; i < SLOTS.length; i++) { edge += SLOTS[i].w; if (x < edge) return i; } return SLOTS.length - 1; };

// ---------- one drop ----------
function simulate(dropX, seed, { crate = -1, prize = -1, prizeR = 7 } = {}) {
  const r = rng32(seed);
  let x = Math.min(RIGHT - BALL_R - 1, Math.max(LEFT + BALL_R + 1, dropX)) + (r() - 0.5) * 3; // a hidden wobble:
  let y = RAIL_Y, vx = (r() - 0.5) * 0.4, vy = 0.2, ang = 0; // the same aim never lands quite the same
  const frames = [], events = [], got = new Set();
  let crateOn = crate >= 0 && crate < crateSpots.length, still = 0, slot = -1, slotFrame = -1, after = 0;
  let prizeOn = prize >= 0 && prize < PRIZE_SPOTS.length;
  const lastHit = new Map();
  const hit = (f, kind, i, vn) => { // one flash per thing per few frames
    const k = kind + i;
    if (vn < -0.35 && !(lastHit.get(k) > f - 6)) { lastHit.set(k, f); events.push({ f, kind, i }); }
  };
  // bounce off a circle; returns the normal speed before the bounce (< 0 when it hit)
  const circle = (cx, cy, R, rest) => {
    const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy, min = R + BALL_R;
    if (d2 >= min * min || d2 < 1e-9) return 0;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    x = cx + nx * min; y = cy + ny * min;
    const vn = vx * nx + vy * ny;
    if (vn >= 0) return 0;
    vx -= (1 + rest) * vn * nx; vy -= (1 + rest) * vn * ny;
    const tx = -ny, ty = nx, vt = vx * tx + vy * ty; // a little grip
    vx -= vt * 0.04 * tx; vy -= vt * 0.04 * ty;
    return vn;
  };
  const segment = (ax, ay, bx, by, rest) => {
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
    let t = ((x - ax) * ex + (y - ay) * ey) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return circle(ax + ex * t, ay + ey * t, 0, rest);
  };
  for (let f = 0; f < MAX_FRAMES; f++) {
    for (let s = 0; s < SUB; s++) {
      vy += G / SUB; x += vx / SUB; y += vy / SUB;
      if (x < LEFT + BALL_R) { x = LEFT + BALL_R; if (vx < 0) vx = -vx * 0.5; }
      if (x > RIGHT - BALL_R) { x = RIGHT - BALL_R; if (vx > 0) vx = -vx * 0.5; }
      if (y > FLOOR - BALL_R) { y = FLOOR - BALL_R; if (vy > 0) { vy = -vy * 0.3; vx *= 0.8; } }
      for (let i = 0; i < pebbles.length; i++) { const p = pebbles[i]; hit(f, "peb", i, circle(p.x, p.y, p.r, 0.5)); }
      for (let i = 0; i < roots.length; i++) for (const p of roots[i]) hit(f, "root", i, circle(p.x, p.y, p.r, 0.45));
      for (let i = 0; i < ACORNS.length; i++) {
        const a = ACORNS[i], vn = circle(a.x, a.y, a.r, 1.2);
        if (vn < 0) { // a springy acorn: never lets go softly
          const d = dist(x, y, a.x, a.y), nx = (x - a.x) / d, ny = (y - a.y) / d, out = vx * nx + vy * ny;
          if (out < 2.6) { vx += (2.6 - out) * nx; vy += (2.6 - out) * ny; }
          hit(f, "acorn", i, -1);
        }
      }
      { const vn = circle(WHEEL.x, WHEEL.y, WHEEL.r, 0.55);
        if (vn < 0) { // the rim is moving: drag the ball along it
          const d = dist(x, y, WHEEL.x, WHEEL.y), tx = -(y - WHEEL.y) / d, ty = (x - WHEEL.x) / d;
          const vt = vx * tx + vy * ty, dv = (WHEEL.omega * WHEEL.r * 1.6 - vt) * 0.5;
          vx += dv * tx; vy += dv * ty;
          hit(f, "wheel", 0, vn);
        } }
      if (crateOn) {
        const c = crateSpots[crate], vn = circle(c.x, c.y, c.r, 0.4);
        if (vn < 0) { crateOn = false; events.push({ f, kind: "crate", i: crate }); }
      }
      if (prizeOn) {
        const c = PRIZE_SPOTS[prize], vn = circle(c.x, c.y, prizeR, 0.4);
        if (vn < 0) { prizeOn = false; events.push({ f, kind: "prize", i: prize }); }
      }
      for (const dx of dividers) segment(dx, DIV_TOP, dx, H, 0.35);
    }
    const sp = vx * vx + vy * vy;
    if (sp > MAX_V * MAX_V) { const k = MAX_V / Math.sqrt(sp); vx *= k; vy *= k; }
    ang += vx / BALL_R;
    frames.push(x, y, ang);
    for (let i = 0; i < seeds.length; i++) {
      if (got.has(i)) continue;
      const s = seeds[i];
      if (dist(x, y, s.x, s.y) < BALL_R + s.r) { got.add(i); events.push({ f, kind: "seed", i }); }
    }
    if (slot < 0 && y > DIV_TOP + BALL_R + 2) { slot = slotAt(x); slotFrame = f; events.push({ f, kind: "slot", i: slot }); }
    if (slot >= 0 && (++after > 70 || (after > 20 && sp < 0.01))) break;
    if (slot < 0) { // wedged somewhere: a nudge, from the same rng
      if (sp < 0.0025) still++; else still = 0;
      if (still > 40) { vx = (r() < 0.5 ? -1 : 1) * (1 + r()); vy = -1.5; still = 0; }
    }
  }
  if (slot < 0) { slot = slotAt(x); slotFrame = frames.length / 3 - 1; events.push({ f: slotFrame, kind: "slot", i: slot }); }
  return { frames, events, slot, slotId: SLOTS[slot].id, slotFrame, seeds: [...got].length,
    crateHit: events.some((e) => e.kind === "crate"), prizeHit: events.some((e) => e.kind === "prize") };
}

return {
  W, H, BALL_R, RAIL_Y, LEFT, RIGHT, DIV_TOP, FLOOR, PAY,
  WHEEL, ACORNS, SLOTS, roots, pebbles, seeds, crateSpots, dividers, PRIZE_SPOTS,
  AIM_MIN: LEFT + BALL_R + 1, AIM_MAX: RIGHT - BALL_R - 1,
  rng32, simulate, slotAt, prizeRadius,
};
});

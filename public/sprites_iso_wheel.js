// Dimetric (2:1) hamster wheel, drawn procedurally so it can spin at any angle. Pixel-exact: the
// static parts are ray-cast ONCE into a per-pixel map (a tiny orthographic ray caster over a
// cylinder tread, two rim rings, a back plate, a hub and an A-frame stand of capsules), then baked
// into canvases with integer fillRect runs; only the spokes and a couple of rim glints are painted
// per frame, also with 1x1 fillRects. No arcs, no smoothing, every pixel on the integer grid.
//
// World frame (screen px units): I = the tile's i axis (screen (cu, su) per unit, cu = 2/sqrt5,
// su = 1/sqrt5), J = the j axis (screen (-cu, su)), Z = up (screen (0, -1)). A world point projects to
//   x = cu * (I - J),  y = su * (I + J) - Z
// and the view ray (toward the viewer) is (1, 1, 2su): larger J = nearer. Unflipped, the axle runs
// along J, so the disc lies in the I/Z plane: a rim point at angle t is centre + r cos t (cu, su) +
// r sin t (0, -1). Flip mirrors every pixel around the anchor x (axle along i).
//
// Layers: "back" = stand, back plate (+ spokes, + hub), far rim, inner tread: everything behind the
// hamster; "front" = outer tread + near rim ring (+ T4/T5 rim effects). The tread slats rotate: their
// pattern repeats every 1/N rev, so it is baked into PH sub-phase canvases per (tier, flip, layer).
// Lighting follows the iso art: tops lightest, faces toward +J (SW, lower-left) mid, faces toward +I
// (SE, lower-right) dark; 1-px #1d1a14 outline around the silhouette and the near rim's inner edge.
(() => {
"use strict";
const OUT = "#1d1a14";
const cu = 2 / Math.sqrt(5), su = 1 / Math.sqrt(5), VZ = 2 * su; // view ray (1, 1, VZ)
const R = 22;              // tread radius (rim lip reaches R + 1.5: ~47 px tall, ~45 px across the disc)
const J0 = -5.5, J1 = 5.5; // far / near rim planes: 11 units of tread along the axle (10 x 5 px on screen)
const RW = 0.75;           // rim half-thickness along the axle
const RIN = R - 2.5, ROUT = R + 1.5;
const H = R + 7;           // axle height above the floor
const CY = -8 - H;         // axle midpoint on screen, relative to the anchor (the tile centre is 8 px up)
const N = 20, GAP = 0.3;   // tread slats per rev, gap fraction
const PH = 8;              // baked sub-phases per slat period (~0.9 px of rim travel each)
const JS = J0 - 1.5;       // stand plane, just behind the back plate
const LF = 8;               // A-frame foot spread along I (lands on the base slab)
const BX0 = -40, BY0 = -74, BW = 80, BH = 80; // scan box, local to the anchor
const DBG = false;

// ---------------- tier looks ----------------
// tones: [hi, mid, lo, dark]
const STEEL = ["#e5e7eb", "#9ca3af", "#6b7280", "#4b5563"];
const TIERS = [
  { // T0 plain steel
    rim: STEEL, tread: ["#d1d5db", "#9ca3af", "#6b7280", "#4b5563"], gap: "#26292f",
    plate: ["#3f4652", "#374151"], spoke: "#9ca3af", lead: "#e5e7eb",
    hub: ["#d1d5db", "#9ca3af", "#6b7280", "#4b5563"], cap: ["#e5e7eb", "#9ca3af"], hubR: 4, stand: STEEL,
  },
  { // T1 Oiled Bearings: polished steel, golden bearing hub
    rim: ["#ffffff", "#c4c9d1", "#8b929c", "#5b636e"], tread: ["#e5e7eb", "#aab0b9", "#7b828c", "#525a64"], gap: "#26292f",
    plate: ["#3f4652", "#374151"], spoke: "#aab0b9", lead: "#ffffff",
    hub: ["#ffd166", "#f5a623", "#c2410c", "#7c3f1d"], cap: ["#ffffff", "#ffd166"], hubR: 4.5, stand: STEEL,
  },
  { // T2 Copper Dynamo: copper hub coil, copper spokes, copper-capped stand
    rim: STEEL, tread: ["#d1d5db", "#9ca3af", "#6b7280", "#4b5563"], gap: "#2b211b",
    plate: ["#4a3426", "#3b2a20"], spoke: "#c2410c", lead: "#f5a623",
    hub: ["#f5a623", "#c2410c", "#7c3f1d", "#5a2d14"], cap: ["#ffd166", "#f5a623"], hubR: 6, stand: ["#f5a623", "#c2410c", "#7c3f1d", "#5a2d14"],
  },
  { // T3 Flywheel Hub: big blue flywheel
    rim: STEEL, tread: ["#d1d5db", "#9ca3af", "#6b7280", "#4b5563"], gap: "#1c2333",
    plate: ["#25324d", "#1e2940"], spoke: "#3b82f6", lead: "#93c5fd",
    hub: ["#93c5fd", "#3b82f6", "#1e3a8a", "#172554"], cap: ["#ffffff", "#9ca3af"], hubR: 7.5, stand: STEEL,
  },
  { // T4 Superconductor Rim: white/blue/navy rims, violet glow
    rim: ["#ffffff", "#3b82f6", "#1e3a8a", "#172554"], tread: ["#c7d2fe", "#8b9fd8", "#4f5fa8", "#2e3a78"], gap: "#140f2a",
    plate: ["#241d45", "#1c1638"], spoke: "#a78bfa", lead: "#ede9fe",
    hub: ["#c4b5fd", "#a78bfa", "#1e3a8a", "#172554"], cap: ["#ffffff", "#a78bfa"], hubR: 6, stand: ["#93c5fd", "#3b82f6", "#1e3a8a", "#172554"],
    glow: "#a78bfa",
  },
  { // T5 Squeektoshi Prime: gold
    rim: ["#fff3c4", "#ffd166", "#f5a623", "#c2410c"], tread: ["#fff3c4", "#ffd166", "#e8961a", "#a85a12"], gap: "#2e1c0c",
    plate: ["#4a2f12", "#3a2410"], spoke: "#f5a623", lead: "#fff3c4",
    hub: ["#ffffff", "#ffd166", "#f5a623", "#c2410c"], cap: ["#ffffff", "#ffd166"], hubR: 6.5, stand: ["#ffd166", "#f5a623", "#c2410c", "#7c3f1d"],
    sparkle: "#ffffff",
  },
];

// ---------------- geometry: one orthographic ray per pixel ----------------
// pixel centre (X, Y) relative to the axle midpoint -> ray I = J + a, Z = VZ J + c, J free
const KIND = { EMPTY: 0, PLATE: 1, FARRIM: 2, INNER: 3, OUTER: 4, NEARRIM: 5, HUB: 6, CAP: 7, STAND: 8, OUT: 9 };
function tone(nI, nJ, nZ) {
  const b = nZ + 0.3 * nJ - 0.5 * nI;
  return b > 0.5 ? 0 : b > 0.0 ? 1 : b > -0.55 ? 2 : 3;
}
function cylRoots(a, c, rad) { // (J + a)^2 + (VZ J + c)^2 = rad^2
  const A = 1 + VZ * VZ, B = 2 * (a + VZ * c), C = a * a + c * c - rad * rad, D = B * B - 4 * A * C;
  if (D < 0) return null;
  const s = Math.sqrt(D);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)];
}
function capsule(a, c, P, Q, rad) { // ray O=(a,0,c) + l*(1,1,VZ) vs segment P..Q
  const v = [1, 1, VZ], d = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]], w = [a - P[0], -P[1], c - P[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const A = dot(v, v), B = dot(v, d), C = dot(d, d), D = dot(v, w), E = dot(d, w), den = A * C - B * B;
  let m = den > 1e-9 ? (A * E - B * D) / den : 0;
  m = Math.max(0, Math.min(1, m));
  const l = (B * m - D) / A;
  const rp = [a + l, l, c + VZ * l], sp = [P[0] + d[0] * m, P[1] + d[1] * m, P[2] + d[2] * m];
  const off = [rp[0] - sp[0], rp[1] - sp[1], rp[2] - sp[2]], dist = Math.sqrt(dot(off, off));
  if (dist >= rad) return null;
  // surface normal: lateral offset + the toward-viewer component
  const vn = Math.sqrt(A), k = Math.sqrt(Math.max(0, 1 - (dist / rad) ** 2));
  const n = [off[0] / rad + (k * v[0]) / vn, off[1] / rad + (k * v[1]) / vn, off[2] / rad + (k * v[2]) / vn];
  return { J: l + k * rad, n };
}
const SLAB = [-8.5, 8.5, -8.5, 8,  -H, -H + 2.5]; // I0, I1, J0, J1, Zbottom, Ztop
const STAND_SEGS = [
  [[0, J0 - 0.5, 0], [0, JS, 0], 1.4],
  [[0, JS, 0], [-LF, JS, -H + 2.5], 1.15],
  [[0, JS, 0], [LF, JS, -H + 2.5], 1.15],
  [[-LF * 0.5, JS, -H * 0.5], [LF * 0.5, JS, -H * 0.5], 0.8],
];

function castPixel(X, Y, hubR) {
  const a = X / cu, c = 0.5 * X - Y;
  let best = null;
  const take = (J, kind, tn, extra) => { if (!best || J > best.J) best = { J, kind, tone: tn, ...extra }; };
  const at = (J) => [J + a, VZ * J + c]; // (I, Z) on the ray at depth J
  // tread shell, both sides
  const tr = cylRoots(a, c, R);
  if (tr) for (const J of tr) {
    if (J < J0 || J > J1) continue;
    const [I, Z] = at(J), nI = I / R, nZ = Z / R, facing = nI + VZ * nZ;
    const t = Math.atan2(Z, I), u = (N * t) / (2 * Math.PI);
    if (facing > 0) take(J, KIND.OUTER, tone(nI, 0, nZ), { u, t });
    else take(J, KIND.INNER, tone(-nI, 0, -nZ), { u, t });
  }
  // rims: front face + outer lip + inner flange wall
  for (const [Jc, kind] of [[J0, KIND.FARRIM], [J1, KIND.NEARRIM]]) {
    const Jf = Jc + RW, [I, Z] = at(Jf), rho = Math.hypot(I, Z);
    if (rho >= RIN && rho <= ROUT) {
      const t = Math.atan2(Z, I);
      // flat face, mid tone; light on the upper-left arc, dark on the lower-right
      const up = Math.sin(t) * 0.8 - Math.cos(t) * 0.6;
      let tn = 1;
      if (up > 0.35 && rho > R - 0.5) tn = 0;
      else if (up < -0.45 && rho < R - 0.5) tn = 2;
      take(Jf, kind, tn, { t, face: 1 });
    }
    const ro = cylRoots(a, c, ROUT);
    if (ro) for (const J of ro) {
      if (J < Jc - RW || J > Jc + RW) continue;
      const [I2, Z2] = at(J), nI = I2 / ROUT, nZ = Z2 / ROUT;
      if (nI + VZ * nZ > 0) take(J, kind, tone(nI, 0, nZ), { t: Math.atan2(Z2, I2) });
    }
    const ri = cylRoots(a, c, RIN);
    if (ri) for (const J of ri) {
      if (J < Jc - RW || J > Jc + RW) continue;
      const [I2, Z2] = at(J), nI = -I2 / RIN, nZ = -Z2 / RIN;
      if (nI + VZ * nZ > 0) take(J, kind, Math.max(1, tone(nI, 0, nZ)), { t: Math.atan2(Z2, I2) });
    }
  }
  // back plate
  {
    const Jp = J0 - 0.25, [I, Z] = at(Jp);
    if (Math.hypot(I, Z) <= R - 0.5) take(Jp, KIND.PLATE, 1, { t: Math.atan2(Z, I) });
  }
  // hub: a short drum on the plate + a cap
  for (const [r0, d0, d1, kind] of [[hubR, J0, J0 + 1.6, KIND.HUB], [Math.max(1.6, hubR * 0.42), J0 + 1.6, J0 + 2.6, KIND.CAP]]) {
    const [I, Z] = at(d1), rho = Math.hypot(I, Z);
    if (rho <= r0) {
      const t = Math.atan2(Z, I), up = Math.sin(t) * 0.8 - Math.cos(t) * 0.6;
      take(d1, kind, rho > r0 - 1.2 && up > 0.3 ? 0 : rho > r0 - 1.2 && up < -0.3 ? 2 : 1, { face: 1 });
    }
    const rr = cylRoots(a, c, r0);
    if (rr) for (const J of rr) {
      if (J < d0 || J > d1) continue;
      const [I2, Z2] = at(J), nI = I2 / r0, nZ = Z2 / r0;
      if (nI + VZ * nZ > 0) take(J, kind, Math.min(3, tone(nI, 0, nZ) + 1), {});
    }
  }
  // base slab on the tile: top, +J face (SW), +I face (SE)
  {
    const [i0, i1, j0, j1, zb, zt] = SLAB;
    let J = (zt - c) / VZ, I = J + a;
    if (J >= j0 && J <= j1 && I >= i0 && I <= i1) take(J, KIND.STAND, 0, {});
    J = j1; I = J + a; let Z = VZ * J + c;
    if (I >= i0 && I <= i1 && Z >= zb && Z <= zt) take(J, KIND.STAND, 1, {});
    J = i1 - a; Z = VZ * J + c;
    if (J >= j0 && J <= j1 && Z >= zb && Z <= zt) take(J, KIND.STAND, 2, {});
  }
  // stand
  for (const [P, Q, rad] of STAND_SEGS) {
    const h = capsule(a, c, P, Q, rad);
    if (h) take(h.J, KIND.STAND, tone(h.n[0], h.n[1], h.n[2]), {});
  }
  return best;
}

// geometry per hub radius (tiers share everything but the hub size)
const geoCache = new Map();
function geometry(hubR) {
  if (geoCache.has(hubR)) return geoCache.get(hubR);
  const n = BW * BH, kind = new Uint8Array(n), tn = new Uint8Array(n), u = new Float32Array(n), layer = new Uint8Array(n);
  for (let py = 0; py < BH; py++) for (let px = 0; px < BW; px++) {
    const X = BX0 + px + 0.5, Y = BY0 + py + 0.5 - CY, h = castPixel(X, Y, hubR), k = py * BW + px;
    if (!h) continue;
    kind[k] = h.kind; tn[k] = h.tone; if (h.u !== undefined) u[k] = h.u;
  }
  // drop silhouette spurs (a lone pixel with at most one filled 4-neighbour) so the outline stays clean
  for (let pass = 0; pass < 2; pass++) for (let y = 1; y < BH - 1; y++) for (let x = 1; x < BW - 1; x++) {
    const k = y * BW + x;
    if (!kind[k]) continue;
    const f = (kind[k - 1] ? 1 : 0) + (kind[k + 1] ? 1 : 0) + (kind[k - BW] ? 1 : 0) + (kind[k + BW] ? 1 : 0);
    if (f <= 1) kind[k] = 0;
  }
  // outlines: (1) empty pixels touching the silhouette; (2) interior pixels touching the near rim;
  // (3) plate pixels touching the far rim flange or the hub; (4) stand pixels touching the wheel
  const out = new Uint8Array(n), get = (x, y) => (x < 0 || y < 0 || x >= BW || y >= BH ? 0 : kind[y * BW + x]);
  const interior = (q) => q === KIND.PLATE || q === KIND.INNER || q === KIND.FARRIM || q === KIND.HUB || q === KIND.CAP;
  const wheelK = (q) => q !== KIND.EMPTY && q !== KIND.STAND;
  for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
    const k = y * BW + x, q = kind[k], nb = [get(x - 1, y), get(x + 1, y), get(x, y - 1), get(x, y + 1)];
    if (q === KIND.EMPTY) { if (nb.some((v) => v !== KIND.EMPTY)) out[k] = nb.some((v) => v === KIND.OUTER || v === KIND.NEARRIM) ? 2 : 1; continue; }
    if (interior(q) && nb.includes(KIND.NEARRIM)) out[k] = 1;
    else if (q === KIND.PLATE && (nb.includes(KIND.FARRIM) || nb.includes(KIND.HUB))) out[k] = 1;
    else if (q === KIND.HUB && nb.includes(KIND.CAP)) out[k] = 3;
    else if (q === KIND.STAND && nb.some(wheelK)) out[k] = 1;
    else if (q === KIND.OUTER && nb.includes(KIND.FARRIM)) out[k] = 2;
  }
  let x0 = BW, y0 = BH, x1 = -1, y1 = -1;
  for (let k = 0; k < n; k++) {
    const q = kind[k];
    if (out[k] === 1 || out[k] === 3) layer[k] = (q === KIND.HUB || q === KIND.CAP) ? 3 : 1;
    else if (out[k] === 2) layer[k] = 2;
    else if (q === KIND.OUTER || q === KIND.NEARRIM) layer[k] = 2;
    else if (q === KIND.HUB || q === KIND.CAP) layer[k] = 3;
    else if (q) layer[k] = 1;
    if (out[k]) { kind[k] = q === KIND.EMPTY ? KIND.OUT : q; }
    if (layer[k]) { const x = k % BW, y = (k / BW) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  // the tier-4 halo: empty pixels within 2 px of the wheel (not the stand)
  const halo = [];
  for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
    if (layer[y * BW + x]) continue;
    let d = 0;
    for (let dy = -2; dy <= 2 && d !== 1; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= BW || yy >= BH) continue;
      const kk = yy * BW + xx;
      if (!layer[kk] || kind[kk] === KIND.STAND) continue;
      const m = Math.abs(dx) + Math.abs(dy) <= 1 ? 1 : Math.max(Math.abs(dx), Math.abs(dy)) <= 2 && Math.abs(dx) + Math.abs(dy) <= 3 ? 2 : 0;
      if (m && (!d || m < d)) d = m;
    }
    if (d) halo.push(x, y, d);
  }
  const geo = { kind, tn, u, out, layer, halo, box: { x0, y0, x1, y1 } };
  geoCache.set(hubR, geo);
  return geo;
}

// ---------------- baking ----------------
function mk(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.imageSmoothingEnabled = false; return c; }
function colourOf(T, geo, k, ph) {
  const q = geo.kind[k], t = geo.tn[k];
  if (geo.out[k]) return OUT;
  switch (q) {
    case KIND.PLATE: { const x = k % BW, y = (k / BW) | 0; return (x + y) % 2 ? T.plate[1] : T.plate[0]; }
    case KIND.FARRIM: case KIND.NEARRIM: return T.rim[t];
    case KIND.INNER: case KIND.OUTER: {
      let f = (geo.u[k] + ph) % 1; if (f < 0) f += 1;
      return f < GAP ? T.gap : T.tread[t];
    }
    case KIND.HUB: return T.hub[t];
    case KIND.CAP: return t === 0 ? T.cap[0] : T.cap[1];
    case KIND.STAND: return T.stand[t];
  }
  return null;
}
// bake one layer (1 back, 2 front, 3 hub) of a tier at sub-phase p, mirrored when flip
function bake(T, geo, lay, p, flip) {
  const { x0, y0, x1, y1 } = geo.box, w = x1 - x0 + 1, h = y1 - y0 + 1, c = mk(w, h), g = c.getContext("2d");
  const ph = p / PH;
  for (let y = y0; y <= y1; y++) {
    let run = null, rx = 0;
    const flush = (xe) => { if (run) { g.fillStyle = run; const a = rx - x0, b = xe - x0; g.fillRect(flip ? w - b : a, y - y0, b - a, 1); } };
    for (let x = x0; x <= x1 + 1; x++) {
      const k = y * BW + x, col = x <= x1 && geo.layer[k] === lay ? colourOf(T, geo, k, ph) : null;
      if (col !== run) { flush(x); run = col; rx = x; }
    }
  }
  return c;
}
const bakeCache = new Map();
function baked(tier, lay, p, flip) {
  const key = tier + "|" + lay + "|" + p + "|" + (flip ? 1 : 0);
  let c = bakeCache.get(key);
  if (!c) { const T = TIERS[tier]; c = bake(T, geometry(T.hubR), lay, p, flip); bakeCache.set(key, c); }
  return c;
}

// ---------------- per-frame bits ----------------
const proj = (I, J, Z) => [cu * (I - J), su * (I + J) - Z - 0]; // relative to the axle midpoint
function plot(ctx, ax, ay, flip, lx, ly) { ctx.fillRect(flip ? ax - 1 - lx : ax + lx, ay + ly, 1, 1); }
function inBox(lx, ly) { const x = lx - BX0, y = ly - BY0; return x >= 0 && y >= 0 && x < BW && y < BH ? y * BW + x : -1; }
function spokes(ctx, ax, ay, flip, T, geo, angle) {
  const Jp = J0 - 0.25, r0 = T.hubR - 0.5, r1 = R - 3.2;
  for (let s = 0; s < 6; s++) {
    const th = -angle * 2 * Math.PI + (s * Math.PI) / 3 + 0.3;
    const [xa, ya] = proj(r0 * Math.cos(th), Jp, r0 * Math.sin(th)), [xb, yb] = proj(r1 * Math.cos(th), Jp, r1 * Math.sin(th));
    // integer Bresenham between the two end pixels (local coords)
    const X0 = Math.floor(xa), Y0 = Math.floor(ya + CY), X1 = Math.floor(xb), Y1 = Math.floor(yb + CY);
    let dx = Math.abs(X1 - X0), dy = -Math.abs(Y1 - Y0), sx = X0 < X1 ? 1 : -1, sy = Y0 < Y1 ? 1 : -1, err = dx + dy;
    let x = X0, y = Y0;
    const steep = -dy > dx, ok = (k) => k >= 0 && geo.kind[k] === KIND.PLATE && !geo.out[k] && geo.layer[k] === 1;
    for (;;) {
      // 2-px spoke: lit pixel + a shadow pixel to its right (steep) or below (shallow)
      const x2 = steep ? x + 1 : x, y2 = steep ? y : y + 1;
      if (ok(inBox(x2, y2))) { ctx.fillStyle = T.rim[3]; plot(ctx, ax, ay, flip, x2, y2); }
      if (ok(inBox(x, y))) { ctx.fillStyle = s === 0 ? T.lead : T.spoke; plot(ctx, ax, ay, flip, x, y); }
      if (x === X1 && y === Y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }
}
function rimPoint(th, rho, Jc) { const [x, y] = proj(rho * Math.cos(th), Jc, rho * Math.sin(th)); return [Math.floor(x), Math.floor(y + CY)]; }

function haloCanvas(tier, d, flip) { // the T4 glow ring at distance d, full scan box, baked once
  const key = "halo|" + tier + "|" + d + "|" + (flip ? 1 : 0);
  let c = bakeCache.get(key);
  if (!c) {
    const T = TIERS[tier], geo = geometry(T.hubR);
    c = mk(BW, BH); const g = c.getContext("2d"); g.fillStyle = T.glow;
    for (let i = 0; i < geo.halo.length; i += 3) if (geo.halo[i + 2] === d) g.fillRect(flip ? BW - 1 - geo.halo[i] : geo.halo[i], geo.halo[i + 1], 1, 1);
    bakeCache.set(key, c);
  }
  return c;
}

window.IsoWheel = {
  draw(ctx, layer, ax, ay, opts = {}) {
    const tier = Math.max(0, Math.min(5, opts.tier | 0)), flip = !!opts.flip, T = TIERS[tier], geo = geometry(T.hubR);
    let ang = Number(opts.angle) || 0; ang -= Math.floor(ang);
    const p = Math.floor(((ang * N) % 1) * PH) % PH, ms = Number(opts.t) || 0;
    ax = Math.round(ax); ay = Math.round(ay);
    const ox = flip ? ax - 1 - (BX0 + geo.box.x1) : ax + BX0 + geo.box.x0, oy = ay + BY0 + geo.box.y0;
    if (layer === "back") {
      if (T.glow) { // pulsing halo behind the wheel
        const pulse = 0.5 + 0.5 * Math.sin(ms / 260), hx = flip ? ax - BX0 - BW : ax + BX0, ga = ctx.globalAlpha;
        ctx.globalAlpha = ga * (0.35 + 0.35 * pulse); ctx.drawImage(haloCanvas(tier, 1, flip), hx, ay + BY0);
        ctx.globalAlpha = ga * (0.12 + 0.16 * pulse); ctx.drawImage(haloCanvas(tier, 2, flip), hx, ay + BY0);
        ctx.globalAlpha = ga;
      }
      ctx.drawImage(baked(tier, 1, p, flip), Math.round(ox), Math.round(oy));
      spokes(ctx, ax, ay, flip, T, geo, ang);
      ctx.drawImage(baked(tier, 3, 0, flip), Math.round(ox), Math.round(oy));
    } else {
      ctx.drawImage(baked(tier, 2, p, flip), Math.round(ox), Math.round(oy));
      if (T.glow) { // two current pulses chasing round the near rim
        ctx.fillStyle = "#ede9fe";
        for (let s = 0; s < 2; s++) {
          const [x, y] = rimPoint(-ang * 2 * Math.PI * 2 + s * Math.PI, R - 0.5, J1 + RW);
          const k = inBox(x, y);
          if (k >= 0 && geo.kind[k] === KIND.NEARRIM && !geo.out[k]) plot(ctx, ax, ay, flip, x, y);
        }
      }
      if (T.sparkle) { // a few twinkles on the gold rims
        const slot = Math.floor(ms / 180);
        for (let s = 0; s < 3; s++) {
          const hsh = Math.sin((slot + s * 7.31) * 12.9898) * 43758.5453, fr = hsh - Math.floor(hsh);
          const life = ((ms / 180 + s / 3) % 1);
          const [x, y] = rimPoint(fr * 2 * Math.PI, R, s === 1 ? J0 + RW : J1 + RW);
          const k = inBox(x, y);
          if (k < 0 || !geo.layer[k] || geo.out[k]) continue;
          ctx.fillStyle = T.sparkle;
          plot(ctx, ax, ay, flip, x, y);
          if (life > 0.25 && life < 0.75) { plot(ctx, ax, ay, flip, x - 1, y); plot(ctx, ax, ay, flip, x + 1, y); plot(ctx, ax, ay, flip, x, y - 1); plot(ctx, ax, ay, flip, x, y + 1); }
        }
      }
    }
  },
  // the running hamster's bottom-centre: on the inner tread at the bottom, mid-axle
  runSpot(ax, ay, flip) { return { x: ax, y: ay + Math.round(CY + R) - 1 }; },
  bounds(ax, ay, flip) {
    const b = geometry(TIERS[0].hubR).box, x0 = BX0 + b.x0 - 2, x1 = BX0 + b.x1 + 2, y0 = BY0 + b.y0 - 2, y1 = BY0 + b.y1;
    return { x: flip ? ax - 1 - x1 : ax + x0, y: ay + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  },
};
})();

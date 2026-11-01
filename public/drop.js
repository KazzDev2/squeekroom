// Burrow Drop (preview): aim, drop, watch Squeektoshi bounce down the burrow. Every path comes from
// drop_sim.js (the same code a server would run); this file only draws and replays it. Preview only:
// the watts here are pretend and live in this tab.
(() => {
"use strict";
const D = window.BurrowDrop, PX = window.SqueekScenes.px;
const { W, H, BALL_R, RAIL_Y, LEFT, RIGHT, DIV_TOP, PAY } = D;
const $ = (id) => document.getElementById(id);
const cv = $("board"), g = cv.getContext("2d");
g.imageSmoothingEnabled = false;
const OUT = PX.OUTLINE, COST = 500, START_WATTS = 10_000;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const AIM_MIN = LEFT + BALL_R + 1, AIM_MAX = RIGHT - BALL_R - 1;

const st = {
  watts: START_WATTS, shownWatts: START_WATTS, stash: COST * PAY.STASH_START, shownStash: COST * PAY.STASH_START,
  aim: W / 2, mode: "aim", sim: null, i: 0, done: 0,
  golden: false, crate: -1, seedOn: D.seeds.map(() => true),
  flash: new Map(), rootWob: D.roots.map(() => 0), squash: D.ACORNS.map(() => 0), wheelFlash: 0, slotFlash: -1, slotT: 0,
  pops: [], parts: [], coins: [], shake: 0, banner: null, chain: 0, lastSeedF: -999, won: 0, trail: [],
};

// ---------- pixel helpers ----------
function line(c, x0, y0, x1, y1, col) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  c.fillStyle = col;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) {
    c.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
const disc = (c, x, y, r, col) => PX.fillEllipse(c, x, y, r, r, col);
const tmp = document.createElement("canvas"), tg = tmp.getContext("2d");
function bigText(c, str, x, y, col, scale = 2) { // the 3x5 font, outlined, drawn at `scale`, centred on x
  const w = str.length * 4 + 2;
  tmp.width = w; tmp.height = 7;
  tg.clearRect(0, 0, w, 7);
  PX.text(tg, str, 0, 0, col, false);
  c.drawImage(tmp, Math.round(x - (w * scale) / 2), Math.round(y), w * scale, 7 * scale);
}
function strip(c, x, y, w, h) { c.fillStyle = "rgba(29,26,20,.8)"; c.fillRect(Math.round(x - w / 2), Math.round(y), Math.round(w), h); }

// ---------- the burrow (painted once) ----------
const bg = document.createElement("canvas");
bg.width = W; bg.height = H;
(function paintBurrow() {
  const c = bg.getContext("2d"), r = D.rng32(20261102);
  c.fillStyle = "#3d1e0d"; c.fillRect(0, 0, W, H);
  // the chamber: dug-out earth, darker the deeper it goes
  c.fillStyle = "#8a4b26"; c.fillRect(LEFT, 14, RIGHT - LEFT, H - 14);
  for (let k = 0; k < 1400; k++) {
    const x = LEFT + Math.floor(r() * (RIGHT - LEFT)), y = 14 + Math.floor(r() * (H - 14));
    c.fillStyle = r() < 0.55 ? "#7c4220" : "#97552c";
    c.fillRect(x, y, r() < 0.3 ? 2 : 1, 1);
  }
  for (let k = 0; k < 26; k++) { // buried pebbles and old roots in the back wall
    const x = LEFT + 6 + r() * (RIGHT - LEFT - 12), y = 40 + r() * (DIV_TOP - 60);
    if (r() < 0.6) PX.fillEllipse(c, x, y, 2 + r() * 2, 1 + r() * 1.5, "#74401f");
    else line(c, x, y, x + (r() - 0.5) * 18, y + 4 + r() * 8, "#764021");
  }
  for (let y = 14; y < H; y++) { c.fillStyle = `rgba(20,8,2,${((y - 14) / (H - 14)) * 0.32})`; c.fillRect(LEFT, y, RIGHT - LEFT, 1); }
  // side walls
  for (const [x0, x1] of [[0, LEFT], [RIGHT, W]]) {
    for (let k = 0; k < 120; k++) { c.fillStyle = r() < 0.5 ? "#2e1609" : "#4e2914"; c.fillRect(x0 + Math.floor(r() * (x1 - x0)), Math.floor(r() * H), 1, 1); }
  }
  c.fillStyle = "#2a1408"; c.fillRect(LEFT - 1, 14, 1, H); c.fillRect(RIGHT, 14, 1, H);
  // the surface: grass over the entrance
  c.fillStyle = "#5a2d14"; c.fillRect(0, 6, W, 8);
  c.fillStyle = "#166534"; c.fillRect(0, 4, W, 3);
  c.fillStyle = "#22c55e"; c.fillRect(0, 3, W, 2);
  for (let x = 0; x < W; x += 3 + Math.floor(r() * 3)) { c.fillStyle = r() < 0.5 ? "#22c55e" : "#4ade80"; c.fillRect(x, 1 + Math.floor(r() * 2), 1, 3); }
  c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(LEFT, 14, RIGHT - LEFT, 3);
  // the chambers
  let x = LEFT;
  for (const s of D.SLOTS) {
    const x0 = x, x1 = x + s.w, top = DIV_TOP + 4;
    x = x1;
    if (s.id === "dead") {
      c.fillStyle = "#4a2a18"; c.fillRect(x0, top, s.w, H - top);
      for (let k = 0; k < 5; k++) PX.fillEllipse(c, x0 + 4 + r() * (s.w - 8), H - 14 + r() * 4, 3 + r() * 2, 2, r() < 0.5 ? "#6b7280" : "#4b5563");
    } else if (s.id === "nest") {
      for (let k = 0; k < 70; k++) { const sx = x0 + r() * s.w, sy = H - 22 + r() * 10; line(c, sx, sy, sx + (r() - 0.5) * 8, sy + 2 + r() * 3, r() < 0.5 ? "#e0b84a" : "#c99a2e"); }
    } else if (s.id === "pantry") {
      const cx = x0 + s.w / 2, half = s.w / 2 - 3;
      for (let y = H - 14; y > H - 26; y -= 3) {
        const w = half * Math.sqrt(Math.max(0, 1 - (H - 14 - y) / 12));
        for (let sx = cx - w + ((y / 3) % 2) * 1.5; sx < cx + w - 1; sx += 3) {
          c.fillStyle = OUT; c.fillRect(Math.round(sx), y, 2, 3);
          c.fillStyle = "#3b3226"; c.fillRect(Math.round(sx), y + 1, 2, 1);
          c.fillStyle = "#f3efe6"; c.fillRect(Math.round(sx) + (r() < 0.5 ? 0 : 1), y + 1, 1, 1);
        }
      }
    } else {
      c.fillStyle = "#3a2508"; c.fillRect(x0, top, s.w, H - top);
      c.fillStyle = "rgba(255,209,102,.25)"; c.fillRect(x0 + 1, top + 2, s.w - 2, H - top - 2);
      for (let k = 0; k < 7; k++) PX.coin(c, x0 + 5 + (k % 3) * 4 + r(), H - 13 - Math.floor(k / 3) * 3);
      c.fillStyle = "#fff8d0"; c.fillRect(x0 + 4, top + 6, 1, 1); c.fillRect(x0 + s.w - 5, top + 10, 1, 1);
    }
  }
  // the price strip
  c.fillStyle = "rgba(29,26,20,.85)"; c.fillRect(LEFT, H - 10, RIGHT - LEFT, 10);
  x = LEFT;
  for (const s of D.SLOTS) {
    const cx = x + s.w / 2;
    x += s.w;
    if (s.id === "stash") PX.coin(c, cx, H - 6);
    else PX.text(c, `X${PAY[s.id]}`, cx, H - 8, s.id === "pantry" ? "#ffd166" : s.id === "nest" ? "#eef0f5" : "#9ca3af");
  }
})();

// ---------- the moving parts ----------
function drawRoots(t) {
  D.roots.forEach((pts, i) => {
    const w = st.rootWob[i], n = pts.length;
    const off = (k) => (w > 0.01 ? Math.sin(t * 38 + k * 0.7) * w * (k / n) * 2 : 0);
    const base = pts[0];
    if (base.x > LEFT + 4 && base.x < RIGHT - 4) { const wx = base.x < W / 2 ? LEFT : RIGHT; line(g, wx, base.y - 10, base.x, base.y, "#5a3418"); } // hangs from the wall
    for (let k = 0; k < n; k++) disc(g, pts[k].x, pts[k].y + off(k), 3.6, OUT);
    for (let k = 0; k < n; k++) disc(g, pts[k].x, pts[k].y + off(k), 2.7, "#b97a45");
    g.fillStyle = "#e0a868";
    for (let k = 0; k < n; k++) g.fillRect(Math.round(pts[k].x), Math.round(pts[k].y + off(k)) - 2, 1, 1);
    g.fillStyle = "#8a5a2e";
    for (let k = 1; k < n; k += 3) g.fillRect(Math.round(pts[k].x), Math.round(pts[k].y + off(k)) + 1, 2, 1);
  });
}
function drawPebbles(t) {
  D.pebbles.forEach((p, i) => {
    const f = st.flash.get("peb" + i) || 0, r = p.r + (f > 0 ? 0.6 : 0);
    disc(g, p.x, p.y, r + 1, OUT);
    disc(g, p.x, p.y, r, f > 0 ? "#fff8d0" : p.guard ? "#c9a227" : "#9ca3af");
    g.fillStyle = f > 0 ? "#ffffff" : p.guard ? "#ffe9a8" : "#d1d5db";
    g.fillRect(Math.round(p.x - r / 2), Math.round(p.y - r / 2), 1, 1);
  });
}
function drawAcorn(a, s) {
  const ry = 7 * (1 - 0.28 * s), rx = 6.5 * (1 + 0.18 * s), cy = a.y + (7 - ry);
  PX.fillEllipse(g, a.x, cy, rx + 1, ry + 1, OUT);
  PX.fillEllipse(g, a.x, cy, rx, ry, "#c98b4e");
  PX.fillEllipse(g, a.x + 1.5, cy + 1, rx * 0.55, ry * 0.7, "#a5672f");
  g.fillStyle = "#e3b27a"; g.fillRect(Math.round(a.x - rx * 0.5), Math.round(cy - 1), 1, 2);
  const capY = Math.round(cy - ry * 0.35);
  PX.fillEllipse(g, a.x, capY - 1, rx + 1.5, 4, OUT);
  PX.fillEllipse(g, a.x, capY - 1, rx + 0.5, 3, "#7c3f1d");
  g.fillStyle = "#5a2d14";
  for (let k = -5; k <= 5; k += 2) g.fillRect(Math.round(a.x + k), capY - 2 + (k & 2 ? 1 : 0), 1, 1);
  g.fillStyle = OUT; g.fillRect(Math.round(a.x), capY - 6, 1, 3);
  g.fillStyle = "#5a2d14"; g.fillRect(Math.round(a.x), capY - 5, 1, 2);
}
function drawWheel(ang) {
  const { x, y, r } = D.WHEEL, hot = st.wheelFlash > 0, rim = st.golden ? "#ffd166" : "#9ca3af";
  disc(g, x, y, r + 1, OUT);
  disc(g, x, y, r, hot ? "#fff8d0" : rim);
  disc(g, x, y, r - 2, OUT);
  disc(g, x, y, r - 3, "#5c3a22");
  for (let k = 0; k < 6; k++) {
    const a = ang + (k * Math.PI) / 3;
    line(g, x + Math.cos(a) * 4, y + Math.sin(a) * 4, x + Math.cos(a) * (r - 3), y + Math.sin(a) * (r - 3), k === 0 ? "#d1d5db" : "#8b8f96");
  }
  for (let k = 0; k < 10; k++) { // rungs on the rim show the spin
    const a = ang * 1 + (k * Math.PI) / 5;
    g.fillStyle = st.golden ? "#fff3c4" : "#e5e7eb";
    g.fillRect(Math.round(x + Math.cos(a) * (r - 1)), Math.round(y + Math.sin(a) * (r - 1)), 1, 1);
  }
  disc(g, x, y, 4.5, OUT);
  disc(g, x, y, 3.5, "#f5a623");
  g.fillStyle = "#ffd166"; g.fillRect(x - 1, y - 2, 1, 1);
}
const SEED_ART = ["..1..", ".121.", "12321", "12321", "12321", "12221", ".121.", "..1.."];
function drawSeed(s, i, t) {
  const bob = still ? 0 : Math.round(Math.sin(t * 3 + i * 1.7));
  const x = Math.round(s.x - 2), y = Math.round(s.y - 4 + bob);
  g.globalAlpha = 0.22 + 0.12 * Math.sin(t * 4 + i);
  PX.fillEllipse(g, s.x + 0.5, s.y + bob, 5.5, 6, st.golden ? "#ffd166" : "#fff3c4");
  g.globalAlpha = 1;
  for (let r = 0; r < SEED_ART.length; r++) for (let k = 0; k < 5; k++) {
    const p = SEED_ART[r][k];
    if (p === ".") continue;
    g.fillStyle = p === "1" ? OUT : p === "2" ? (st.golden ? "#a07a1a" : "#3b3226") : (st.golden ? "#ffe9a8" : "#f3efe6");
    g.fillRect(x + k, y + r, 1, 1);
  }
  if ((t * 1.3 + i * 0.37) % 2 < 0.25) { g.fillStyle = "#fff8d0"; g.fillRect(x + 5, y, 1, 1); }
}
function drawCrate(t) {
  if (st.crate < 0) return;
  const c = D.crateSpots[st.crate], jig = !still && Math.sin(t * 9) > 0.92 ? 1 : 0;
  const x = Math.round(c.x - 8) + jig, y = Math.round(c.y - 8);
  const s = (window.SPRITES || {}).crate;
  if (s && typeof window.drawSprite === "function") window.drawSprite(g, s, 0, x, y, {});
  else { g.fillStyle = OUT; g.fillRect(x, y, 16, 16); g.fillStyle = "#c2410c"; g.fillRect(x + 1, y + 1, 14, 14); }
  if ((t * 1.5) % 1 < 0.35) { g.fillStyle = "#fff8d0"; g.fillRect(x + 15, y - 2, 1, 3); g.fillRect(x + 14, y - 1, 3, 1); }
}
// Squeektoshi curled into a ball: the body turns, the light stays top-left
function drawBall(bx, by, ang, alpha = 1) {
  const c = Math.cos(ang), s = Math.sin(ang), R = BALL_R + 0.5;
  g.globalAlpha = alpha;
  for (let py = -BALL_R; py <= BALL_R; py++) for (let px = -BALL_R; px <= BALL_R; px++) {
    const d2 = (px + 0.5) * (px + 0.5) + (py + 0.5) * (py + 0.5);
    if (d2 > R * R) continue;
    const ux = px + 0.5, uy = py + 0.5, rx = ux * c + uy * s, ry = -ux * s + uy * c;
    let col;
    if (d2 > (R - 1.1) * (R - 1.1)) col = OUT;
    else if ((rx - 3) * (rx - 3) + (ry + 1.5) * (ry + 1.5) < 1.1) col = "#000000"; // eye
    else if ((rx - 5.6) * (rx - 5.6) + (ry - 0.6) * (ry - 0.6) < 1.1) col = "#f472b6"; // nose
    else if ((rx + 1) * (rx + 1) + (ry + 5.4) * (ry + 5.4) < 2.2) col = "#f472b6"; // ear
    else if (ry > 4.3) col = "#c2410c";
    else if (ry > 1.4) col = "#ffd166"; // belly
    else col = ux + uy < -6.5 ? "#ffc56a" : "#f5a623";
    g.fillStyle = col;
    g.fillRect(Math.round(bx) + px, Math.round(by) + py, 1, 1);
  }
  g.globalAlpha = 1;
}

// ---------- effects ----------
function pop(x, y, str, col, big = false) { st.pops.push({ x, y, str, col, t: 0, life: big ? 1.6 : 1.1, big }); }
function burst(x, y, n, cols, speed = 1.6) {
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + Math.random() * 0.4, v = speed * (0.5 + Math.random());
    st.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.6, t: 0, life: 0.5 + Math.random() * 0.4, col: cols[k % cols.length] });
  }
}
function coinShower(n) { for (let k = 0; k < n; k++) st.coins.push({ x: LEFT + 8 + Math.random() * (RIGHT - LEFT - 16), y: -10 - Math.random() * 120, vy: 1 + Math.random() * 1.5 }); }

// ---------- a drop ----------
function newBoard() {
  st.seedOn = D.seeds.map(() => true);
  st.golden = Math.random() < 1 / 8;
  st.crate = Math.random() < 1 / 3 ? Math.floor(Math.random() * D.crateSpots.length) : -1;
  renderHud();
}
function drop() {
  if (st.mode !== "aim") return;
  if (st.watts < COST) { st.watts += START_WATTS; renderHud(); return; } // preview: a top-up
  st.watts -= COST;
  st.stash += Math.round((COST * PAY.STASH_FEED_PCT) / 100);
  const seed = (Math.random() * 4294967296) >>> 0;
  st.sim = D.simulate(st.aim, seed, { crate: st.crate });
  st.mode = "fall"; st.i = 0; st.ev = 0; st.chain = 0; st.lastSeedF = -999; st.won = 0; st.trail = []; st.banner = null; st.slotFlash = -1;
  renderHud();
}
function seedPay(chain) { return Math.round((COST * PAY.SEED_PCT * Math.min(chain, PAY.COMBO_MAX) * (st.golden ? 2 : 1)) / 100); }
function onEvent(e) {
  const F = st.sim.frames, bx = F[e.f * 3], by = F[e.f * 3 + 1];
  if (e.kind === "peb") st.flash.set("peb" + e.i, 0.14);
  else if (e.kind === "root") st.rootWob[e.i] = 1.4;
  else if (e.kind === "acorn") { st.squash[e.i] = 1; st.shake = Math.max(st.shake, 0.12); burst(D.ACORNS[e.i].x, D.ACORNS[e.i].y, 6, ["#e3b27a", "#ffffff"]); }
  else if (e.kind === "wheel") st.wheelFlash = 0.12;
  else if (e.kind === "seed") {
    st.seedOn[e.i] = false;
    st.chain = e.f - st.lastSeedF < PAY.COMBO_FRAMES ? st.chain + 1 : 1;
    st.lastSeedF = e.f;
    const w = seedPay(st.chain);
    st.won += w;
    const s = D.seeds[e.i];
    pop(s.x, s.y - 6, `+${w}W`, "#ffd166");
    if (st.chain > 1) pop(s.x, s.y - 16, `COMBO X${Math.min(st.chain, PAY.COMBO_MAX)}`, "#4ade80");
    burst(s.x, s.y, 7, ["#ffd166", "#fff8d0"]);
  } else if (e.kind === "crate") {
    const c = D.crateSpots[e.i];
    st.crate = -1;
    const finds = [["+400W", "#ffd166", 400], ["BOOST", "#ffd166", 0], ["SHIELD", "#ffd166", 0], ["RARE!", "#f472b6", 0]];
    const [str, col, w] = finds[Math.floor(Math.random() * finds.length)];
    st.won += w;
    pop(c.x, c.y - 14, "CRATE", "#eef0f5", true);
    pop(c.x, c.y - 4, str, col);
    burst(c.x, c.y, 14, ["#ffd166", "#f5a623", "#fff8d0"], 2.2);
    st.shake = Math.max(st.shake, 0.15);
  } else if (e.kind === "slot") {
    st.slotFlash = e.i; st.slotT = 0;
    burst(bx, by, 10, st.sim.slotId === "stash" ? ["#ffd166", "#fff8d0"] : st.sim.slotId === "dead" ? ["#9ca3af"] : ["#ffd166", "#eef0f5"]);
  }
}
function finish() {
  const id = st.sim.slotId;
  let land = 0;
  if (id === "stash") { land = st.stash; st.stash = COST * PAY.STASH_START; coinShower(40); st.shake = 0.5; }
  else land = Math.round(COST * PAY[id]);
  st.watts += land + st.won;
  const total = land + st.won;
  st.banner = id === "stash" ? { a: "JACKPOT", b: `+${fmt(total)} W`, col: "#ffd166", t: 0 }
    : id === "dead" ? { a: "DEAD END", b: total ? `+${fmt(total)} W` : "", col: "#9ca3af", t: 0 }
    : { a: id === "pantry" ? "PANTRY" : "NEST", b: `+${fmt(total)} W`, col: id === "pantry" ? "#ffd166" : "#eef0f5", t: 0 };
  st.mode = "done"; st.done = id === "stash" ? 3.2 : 1.7;
  renderHud();
}

// ---------- hud ----------
function renderHud() {
  const b = $("dropBtn");
  b.disabled = st.mode !== "aim";
  b.textContent = st.watts < COST ? "Top up" : `Drop · ${fmt(COST)} W`;
  $("golden").hidden = !st.golden;
}
function tickHud(dt) {
  for (const [k, el] of [["Watts", $("watts")], ["Stash", $("stash")]]) {
    const want = st[k.toLowerCase()], key = "shown" + k;
    if (st[key] !== want) {
      const d = want - st[key];
      st[key] = Math.abs(d) < 1 ? want : st[key] + d * Math.min(1, dt * 8);
      el.textContent = fmt(st[key]);
    }
  }
}

// ---------- the loop ----------
let last = performance.now(), T = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt);
  requestAnimationFrame(frame);
}
function step(dt) {
  T += dt;
  // advance the replay
  if (st.mode === "fall") {
    const S = st.sim, n = S.frames.length / 3;
    const slow = S.slotId === "stash" && st.i > S.slotFrame - 55 && st.i < S.slotFrame + 6;
    const prev = st.i;
    st.i = Math.min(n - 1, st.i + dt * 60 * (slow ? 0.28 : 1));
    for (const e of S.events) if (e.f > Math.floor(prev) - (prev === 0 ? 1 : 0) && e.f <= Math.floor(st.i)) onEvent(e);
    if (st.i >= n - 1) finish();
  } else if (st.mode === "done") {
    st.done -= dt;
    if (st.done <= 0) { st.mode = "aim"; st.sim = null; newBoard(); }
  }
  for (const [k, v] of st.flash) { if (v - dt <= 0) st.flash.delete(k); else st.flash.set(k, v - dt); }
  st.rootWob = st.rootWob.map((w) => Math.max(0, w - dt * 3));
  st.squash = st.squash.map((s) => Math.max(0, s - dt * 6));
  st.wheelFlash = Math.max(0, st.wheelFlash - dt);
  st.shake = Math.max(0, st.shake - dt);
  st.slotT += dt;
  draw(T);
  tickHud(dt);
}
function draw(t) {
  g.save();
  if (st.shake > 0 && !still) g.translate(Math.round((Math.random() - 0.5) * st.shake * 10), Math.round((Math.random() - 0.5) * st.shake * 10));
  g.drawImage(bg, 0, 0);
  if (st.slotFlash >= 0 && st.slotT < 1.2) { // the chamber he landed in glows
    let x = LEFT; for (let k = 0; k < st.slotFlash; k++) x += D.SLOTS[k].w;
    g.fillStyle = `rgba(255,209,102,${(0.35 * (1 - st.slotT / 1.2)).toFixed(3)})`;
    g.fillRect(x, DIV_TOP, D.SLOTS[st.slotFlash].w, H - DIV_TOP - 10);
  }
  if (st.golden) {
    g.fillStyle = "rgba(255,209,102,.12)"; g.fillRect(LEFT, 14, RIGHT - LEFT, H - 14);
    for (let k = 0; k < 14; k++) { const x = LEFT + ((k * 67 + t * 9) % (RIGHT - LEFT)), y = 20 + ((k * 41 + t * 14 * (1 + (k % 3))) % (DIV_TOP - 30)); if ((t * 2 + k) % 1.5 < 1) { g.fillStyle = "#fff3c4"; g.fillRect(Math.round(x), Math.round(y), 1, 1); } }
  }
  drawRoots(t);
  drawPebbles(t);
  D.ACORNS.forEach((a, i) => drawAcorn(a, st.squash[i]));
  drawWheel(still ? 0 : t * 60 * D.WHEEL.omega);
  D.seeds.forEach((s, i) => { if (st.seedOn[i]) drawSeed(s, i, t); });
  drawCrate(t);
  // the dividers, in front of the chambers
  for (const x of D.dividers) {
    g.fillStyle = OUT; g.fillRect(x - 2, DIV_TOP - 1, 4, H - 10 - DIV_TOP + 1);
    g.fillStyle = "#c98b4e"; g.fillRect(x - 1, DIV_TOP, 2, H - 10 - DIV_TOP);
    g.fillStyle = "#e3b27a"; g.fillRect(x - 1, DIV_TOP, 1, H - 10 - DIV_TOP);
  }
  // him
  if (st.mode === "aim") {
    const bob = still ? 0 : Math.round(Math.sin(t * 4) * 1);
    for (let y = RAIL_Y + 12; y < RAIL_Y + 44; y += 5) if (((y + Math.floor(t * 20)) % 10) < 5) { g.fillStyle = "rgba(255,248,208,.55)"; g.fillRect(Math.round(st.aim), y, 1, 2); }
    drawBall(st.aim, RAIL_Y + bob, 0);
    if (Math.floor(t * 2) % 2 === 0) { // little arrows: it moves
      for (const dir of [-1, 1]) {
        const ax = Math.round(st.aim) + dir * 12;
        for (let k = 0; k < 3; k++) { g.fillStyle = OUT; g.fillRect(ax + dir * k, RAIL_Y - 3 + k, 2, 7 - 2 * k); g.fillStyle = "#fff8d0"; g.fillRect(ax + dir * k, RAIL_Y - 2 + k, 1, 5 - 2 * k); }
      }
    }
  } else if (st.sim) {
    const F = st.sim.frames, k = Math.floor(st.i) * 3;
    const tr = st.trail;
    tr.push([F[k], F[k + 1]]); if (tr.length > 6) tr.shift();
    tr.forEach(([x, y], j) => { g.fillStyle = `rgba(255,248,208,${(0.06 + j * 0.03).toFixed(2)})`; g.fillRect(Math.round(x) - 2, Math.round(y) - 2, 4, 4); });
    drawBall(F[k], F[k + 1], F[k + 2]);
  }
  // particles, pops, coins, banner
  st.parts = st.parts.filter((p) => (p.t += 1 / 60) < p.life);
  for (const p of st.parts) { p.x += p.vx; p.y += p.vy; p.vy += 0.08; g.globalAlpha = 1 - p.t / p.life; g.fillStyle = p.col; g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1); }
  g.globalAlpha = 1;
  st.coins = st.coins.filter((c) => c.y < H - 12);
  for (const c of st.coins) { c.y += c.vy; c.vy += 0.05; if (c.y > -6) PX.coin(g, c.x, c.y); }
  st.pops = st.pops.filter((p) => (p.t += 1 / 60) < p.life);
  for (const p of st.pops) {
    const k = p.t / p.life, y = p.y - k * (p.big ? 14 : 18);
    g.globalAlpha = Math.min(1, (1 - k) * 2.5);
    if (p.big) bigText(g, p.str, p.x, y - 6, p.col, 2); else PX.text(g, p.str, p.x, Math.round(y), p.col);
    g.globalAlpha = 1;
  }
  if (st.banner) {
    const b = st.banner; b.t += 1 / 60;
    const s = Math.min(1, b.t * 6), jack = b.a === "JACKPOT";
    if (!jack || Math.floor(b.t * 6) % 2 === 0 || b.t > 1.2) {
      strip(g, W / 2, DIV_TOP - 46, 150, 34);
      bigText(g, b.a, W / 2, DIV_TOP - 44, b.col, s >= 1 ? 3 : 2);
      if (b.b) bigText(g, b.b, W / 2, DIV_TOP - 23, b.col === "#9ca3af" ? "#eef0f5" : b.col, 2);
    }
  }
  g.restore();
}

// ---------- input ----------
const toBoard = (e) => { const r = cv.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * W; };
let touching = false;
cv.addEventListener("pointerdown", (e) => {
  if (st.mode !== "aim") return;
  st.aim = clamp(toBoard(e), AIM_MIN, AIM_MAX);
  if (e.pointerType === "mouse") drop(); else touching = true; // touch: tap or drag to aim, the button drops
});
cv.addEventListener("pointermove", (e) => { if (st.mode === "aim" && (e.pointerType === "mouse" || touching)) st.aim = clamp(toBoard(e), AIM_MIN, AIM_MAX); });
addEventListener("pointerup", () => { touching = false; });
$("dropBtn").addEventListener("click", drop);
addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { if (st.mode === "aim") st.aim = clamp(st.aim + (e.key === "ArrowLeft" ? -3 : 3), AIM_MIN, AIM_MAX); e.preventDefault(); }
  else if (e.key === " " || e.key === "Enter") { if (document.activeElement !== $("dropBtn")) { drop(); e.preventDefault(); } }
  else if (e.key === "g" || e.key === "G") { if (st.mode === "aim") { st.golden = !st.golden; renderHud(); } }
});

$("watts").textContent = fmt(st.watts);
$("stash").textContent = fmt(st.stash);
newBoard();
requestAnimationFrame(frame);
window.__drop = { st, D, drop, step };
})();

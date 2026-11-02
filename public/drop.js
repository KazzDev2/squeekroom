// Burrow Drop: aim, drop, watch Squeektoshi bounce down the burrow. The server rolls every drop
// (POST /api/drop, with the den's real watts) and answers with a seed; drop_sim.js replays the very same
// path here from it. The board (golden or not, a crate, the prize on it) is the server's too.
(() => {
"use strict";
const D = window.BurrowDrop, PX = window.SqueekScenes.px;
const { W, H, BALL_R, RAIL_Y, LEFT, RIGHT, DIV_TOP, PAY } = D;
const $ = (id) => document.getElementById(id);
const cv = $("board"), g = cv.getContext("2d");
g.imageSmoothingEnabled = false;
const OUT = PX.OUTLINE;
let COST = 500; // the smallest wager: BALANCE.DROP.COST, from /api/config
const TOKEN = (() => { try { return localStorage.getItem("sr_token") || ""; } catch { return ""; } })();
const CATALOG = new Map();
const RARITY = { common: "#d1d5db", uncommon: "#4ade80", rare: "#60a5fa", epic: "#c084fc", legendary: "#ffd166" };
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const { AIM_MIN, AIM_MAX } = D;
const SND = window.SqueekSound, sfx = (name, o) => { if (SND) SND.sfx(name, o); };

const st = {
  watts: 0, shownWatts: 0, stash: 0, shownStash: 0,
  look: null, prevLook: null, lookT: 1, hamLook: null, wager: 500,
  aim: W / 2, mode: "load", sim: null, i: 0, done: 0, // load | noden | aim | wait | fall | done
  golden: false, crate: -1, prize: null, seedOn: D.seeds.map(() => true), res: null, next: null, msg: "", msgUntil: 0,
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

// ---------- the looks: the burrow follows the hamster ----------
// Garden dig while Squeektoshi runs, Moonlit burrow while he sleeps, Cozy den when nobody knows (no
// fresh reading), Crystal cave on every golden board. Only colours change: the board itself never does.
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// a dithered vertical blend from a to b over [y0, y1) (pixel-art friendly: no smooth gradients)
function dither(c, x0, y0, x1, y1, a, b) {
  const A = `rgb(${rgb(a)})`, B = `rgb(${rgb(b)})`;
  for (let y = y0; y < y1; y++) {
    const t = ((y - y0) / Math.max(1, y1 - y0)) * 16;
    for (let x = x0; x < x1; x++) { c.fillStyle = t > BAYER[y & 3][x & 3] ? B : A; c.fillRect(x, y, 1, 1); }
  }
}
function speckle(c, r, n, x0, y0, x1, y1, cols, big = 0.3) {
  for (let k = 0; k < n; k++) { c.fillStyle = cols[k % cols.length]; c.fillRect(Math.floor(x0 + r() * (x1 - x0)), Math.floor(y0 + r() * (y1 - y0)), r() < big ? 2 : 1, 1); }
}
const sparkle = (c, x, y, col = "#fff8d0") => { c.fillStyle = col; c.fillRect(x, y - 1, 1, 3); c.fillRect(x - 1, y, 3, 1); };
const LOOKS = {
  garden: {
    root: ["#5a3418", "#a3683a", "#d9a066"], peb: ["#e7e5e4", "#ffffff"], rim: "#e5e7eb", wheelIn: "#6e4a2c",
    seed: ["#3b3226", "#f3efe6"], glow: "#ffffff", div: ["#c98b4e", "#e3b27a"], ch: "#5b3a22", hang: "#5a3418",
    paint(c, r) {
      dither(c, 0, 0, W, 12, "#7dd3fc", "#bae6fd");
      PX.fillEllipse(c, 60, 5, 9, 3, "#ffffff"); PX.fillEllipse(c, 68, 4, 6, 3, "#ffffff"); PX.fillEllipse(c, 178, 7, 7, 2, "#f0f9ff");
      c.fillStyle = "#16a34a"; c.fillRect(0, 11, W, 4);
      for (let x = 0; x < W; x += 2) { c.fillStyle = x % 6 ? "#22c55e" : "#4ade80"; c.fillRect(x, 8 + (x * 7) % 3, 1, 4); }
      const layers = [["#8b5a2b", "#7a4d24", 14], ["#b7793f", "#a5692f", 110], ["#c08457", "#ad7146", 200], ["#9ca3af", "#7f8693", 282]];
      const edge = (k, x) => layers[k][2] + (k ? Math.round(Math.sin(x / 13 + k * 2) * 3 + Math.sin(x / 5 + k) * 1) : 0);
      for (let x = 0; x < W; x++) for (let y = 14; y < H; y++) {
        let k = layers.length - 1;
        while (k > 0 && y < edge(k, x)) k--;
        const top = edge(k, x), bot = k + 1 < layers.length ? edge(k + 1, x) : H, t = ((y - top) / Math.max(1, bot - top)) * 16;
        c.fillStyle = t > BAYER[y & 3][x & 3] ? layers[k][1] : layers[k][0];
        c.fillRect(x, y, 1, 1);
      }
      speckle(c, r, 500, 0, 16, W, 108, ["#6e4420", "#9a6a38"]);
      speckle(c, r, 400, 0, 112, W, 198, ["#96612e", "#c98b4e"]);
      speckle(c, r, 360, 0, 202, W, 280, ["#a86d42", "#d19a6c"]);
      for (let k = 0; k < 18; k++) PX.fillEllipse(c, 4 + r() * (W - 8), 290 + r() * 60, 2 + r() * 2.5, 1.5 + r(), r() < 0.5 ? "#6b7280" : "#d1d5db");
      for (let s = 0; s < 12; s++) { c.fillStyle = "#f472b6"; c.fillRect(150 + s, 70 + Math.round(Math.sin(s * 0.9) * 1.5), 1, 2); } // a worm
      c.fillStyle = "#c2410c"; c.fillRect(162, 70, 1, 1);
      for (let y = 15; y < 30; y++) { const w = Math.max(1, Math.round((30 - y) / 4)); c.fillStyle = y % 3 ? "#f97316" : "#ea580c"; c.fillRect(32 - w, y, w * 2, 1); } // a carrot from above
      c.fillStyle = "#16a34a"; c.fillRect(30, 11, 1, 4); c.fillRect(33, 10, 1, 5);
    },
  },
  moonlit: {
    root: ["#2a1d36", "#5b4470", "#8b6fa3"], peb: ["#a5b4fc", "#e0e7ff"], rim: "#c7d2fe", wheelIn: "#231d42",
    seed: ["#7a5a10", "#fde68a"], glow: "#fde68a", div: ["#6d5d9e", "#a59ad6"], ch: "#15122b", hang: "#2a1d36",
    paint(c, r) {
      dither(c, 0, 0, W, 14, "#0f0c29", "#1e1b4b");
      speckle(c, r, 26, 0, 0, W, 10, ["#ffffff", "#c7d2fe"], 0);
      PX.fillEllipse(c, 206, 6, 4.5, 4.5, "#fef9c3"); PX.fillEllipse(c, 208, 5, 3.8, 3.8, "#0f0c29");
      c.fillStyle = "#14532d"; c.fillRect(0, 12, W, 3);
      for (let x = 0; x < W; x += 3) { c.fillStyle = "#166534"; c.fillRect(x, 10 + (x % 2), 1, 3); }
      dither(c, 0, 15, W, H, "#2a2350", "#0c0a18");
      speckle(c, r, 700, 0, 16, W, H, ["#3a3168", "#181430", "#221c40"]);
      for (const [x, y, col] of LOOK_SHROOMS) { // glowing mushrooms on the walls
        c.fillStyle = "#e9e3ff"; c.fillRect(x, y, 1, 3);
        PX.fillEllipse(c, x + 0.5, y, 2.6, 1.6, OUT); PX.fillEllipse(c, x + 0.5, y, 1.9, 1, col);
      }
    },
  },
  cozy: {
    root: ["#5a2d14", "#9a5a2c", "#c98b4e"], peb: ["#d97706", "#fde68a"], rim: "#c98b4e", wheelIn: "#7c4a24",
    seed: ["#3b3226", "#f3efe6"], glow: "#fff3c4", div: ["#8a4b26", "#c98b4e"], ch: "#5a3418", hang: "#5a2d14",
    paint(c, r) {
      c.fillStyle = "#7c3f1d"; c.fillRect(0, 0, W, 15);
      c.fillStyle = "#a35a2a"; c.fillRect(0, 12, W, 1);
      c.fillStyle = "#5a2d14"; c.fillRect(0, 14, W, 1);
      for (let x = 0; x < W; x += 8) { c.fillStyle = (x / 8) % 2 ? "#efe3c8" : "#f6ecd6"; c.fillRect(x, 15, 8, 240); }
      speckle(c, r, 160, 0, 15, W, 254, ["#e3d3b0"], 0);
      for (let k = 0; k < 9; k++) { const y = 30 + k * 26; for (let x = 4 + (k % 2) * 4; x < W; x += 8) { c.fillStyle = "#e6c98f"; c.fillRect(x, y, 1, 1); } } // the den's tiny dots
      c.fillStyle = "#7c3f1d"; c.fillRect(0, 254, W, 6); c.fillStyle = "#a35a2a"; c.fillRect(0, 254, W, 1);
      for (let y = 260; y < H; y += 7) { c.fillStyle = (y / 7) % 2 ? "#b8783f" : "#c98b4e"; c.fillRect(0, y, W, 7); c.fillStyle = "#8f5228"; c.fillRect(0, y + 6, W, 1); }
      for (let y = 260; y < H; y += 14) for (let x = (y % 28 ? 30 : 70); x < W; x += 80) { c.fillStyle = "#8f5228"; c.fillRect(x, y, 1, 7); }
    },
  },
  crystal: {
    root: ["#111827", "#3f4a5c", "#64748b"], peb: ["#67e8f9", "#ecfeff"], rim: "#ffd166", wheelIn: "#1e293b",
    seed: ["#a16207", "#fde047"], glow: "#fde047", div: ["#475569", "#94a3b8"], ch: "#0f172a", hang: "#111827",
    paint(c, r) {
      dither(c, 0, 0, W, H, "#334155", "#0b1120");
      for (let k = 0; k < 9; k++) { const y0 = 20 + k * 38; for (let x = 0; x < W; x++) if (r() < 0.75) { c.fillStyle = "#1f2937"; c.fillRect(x, y0 + Math.round(Math.sin(x / 11 + k) * 3), 1, 1); } }
      speckle(c, r, 500, 0, 0, W, H, ["#2b3647", "#3d4a5e"]);
      for (let k = 0; k < 7; k++) { let x = r() * W, y = 20 + r() * (H - 60); for (let s = 0; s < 22; s++) { c.fillStyle = s % 4 ? "#c9a227" : "#fde68a"; c.fillRect(Math.round(x), Math.round(y), 1, 1); x += r() * 2.2 - 0.6; y += r() * 2 - 0.9; } } // gold veins
      for (const [x, y, col] of LOOK_CRYSTALS) {
        c.fillStyle = OUT; c.fillRect(x - 1, y - 4, 5, 7);
        c.fillStyle = col; c.fillRect(x, y - 3, 3, 5);
        c.fillStyle = "#ffffff"; c.fillRect(x, y - 3, 1, 2);
        c.fillStyle = "rgba(0,0,0,.35)"; c.fillRect(x + 2, y - 1, 1, 3);
      }
      for (let x = 6; x < W; x += 17) { const h = 3 + ((x * 7) % 6); for (let k = 0; k < h; k++) { c.fillStyle = "#1f2937"; c.fillRect(x - Math.max(0, 2 - (k >> 1)), k, Math.max(1, 5 - k), 1); } } // stalactites
    },
  },
};
// decorations at fixed spots, kept off the pegs and roots: [x, y, colour]
const LOOK_SHROOMS = [[14, 120, "#5eead4"], [17, 124, "#f472b6"], [226, 96, "#5eead4"], [222, 200, "#f472b6"], [15, 276, "#5eead4"], [225, 300, "#a78bfa"], [12, 230, "#f472b6"]];
const LOOK_CRYSTALS = [[13, 60, "#a78bfa"], [224, 110, "#67e8f9"], [14, 190, "#f0abfc"], [222, 238, "#a78bfa"], [16, 300, "#67e8f9"], [100, 26, "#f0abfc"], [150, 340, "#a78bfa"]];
const lookCache = new Map();
function lookBg(name) { // the look's background and chambers, painted once
  if (lookCache.has(name)) return lookCache.get(name);
  const L = LOOKS[name], bg = document.createElement("canvas");
  bg.width = W; bg.height = H;
  const c = bg.getContext("2d"), r = D.rng32(20261102);
  L.paint(c, r);
  for (let y = 14; y < H; y++) { c.fillStyle = `rgba(0,0,0,${(((y - 14) / (H - 14)) * 0.18).toFixed(3)})`; c.fillRect(0, y, W, 1); } // deeper is darker
  c.fillStyle = "rgba(0,0,0,.28)"; c.fillRect(0, 0, LEFT, H); c.fillRect(RIGHT, 0, W - RIGHT, H); // the side walls, in shade
  c.fillStyle = "rgba(0,0,0,.45)"; c.fillRect(LEFT - 1, 14, 1, H); c.fillRect(RIGHT, 14, 1, H);
  // the chambers
  let x = LEFT;
  for (const s of D.SLOTS) {
    const x0 = x, top = DIV_TOP + 4;
    x += s.w;
    c.fillStyle = s.id === "stash" ? "#3a2508" : L.ch; c.globalAlpha = 0.85; c.fillRect(x0, top, s.w, H - top); c.globalAlpha = 1;
    if (s.id === "dead") {
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
      c.fillStyle = "rgba(255,209,102,.25)"; c.fillRect(x0 + 1, top + 2, s.w - 2, H - top - 2);
      for (let k = 0; k < 7; k++) PX.coin(c, x0 + 5 + (k % 3) * 4 + r(), H - 13 - Math.floor(k / 3) * 3);
      c.fillStyle = "#fff8d0"; c.fillRect(x0 + 4, top + 6, 1, 1); c.fillRect(x0 + s.w - 5, top + 10, 1, 1);
    }
  }
  c.fillStyle = "rgba(29,26,20,.85)"; c.fillRect(LEFT, H - 10, RIGHT - LEFT, 10); // the price strip
  x = LEFT;
  for (const s of D.SLOTS) {
    const cx = x + s.w / 2;
    x += s.w;
    if (s.id === "stash") PX.coin(c, cx, H - 6);
    else PX.text(c, `X${PAY[s.id]}`, cx, H - 8, s.id === "pantry" ? "#ffd166" : s.id === "nest" ? "#eef0f5" : "#9ca3af");
  }
  lookCache.set(name, bg);
  return bg;
}
// the living bits on top of the background: fireflies, crystal glints, dust in the light, a butterfly
function ambient(name, t) {
  if (still) return;
  if (name === "moonlit") {
    for (const [x, y, col] of LOOK_SHROOMS) { g.globalAlpha = 0.18 + 0.12 * Math.sin(t * 2 + x); PX.fillEllipse(g, x + 0.5, y, 5, 4, col); }
    for (let k = 0; k < 9; k++) {
      const x = LEFT + 10 + ((k * 53 + Math.sin(t * 0.6 + k) * 18 + t * 4) % (RIGHT - LEFT - 20)), y = 40 + ((k * 37 + Math.cos(t * 0.5 + k * 2) * 14) % (DIV_TOP - 60));
      g.globalAlpha = 0.25 + 0.25 * Math.sin(t * 3 + k * 1.7); PX.fillEllipse(g, x, y, 2.5, 2.5, "#d9f99d");
      g.globalAlpha = 0.6 + 0.4 * Math.sin(t * 3 + k * 1.7); g.fillStyle = "#f7fee7"; g.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    g.globalAlpha = 1;
  } else if (name === "crystal") {
    LOOK_CRYSTALS.forEach(([x, y], k) => { if ((t * 0.7 + k * 0.37) % 1 < 0.22) sparkle(g, x + 1, y - 5); });
  } else if (name === "cozy") {
    for (let k = 0; k < 10; k++) {
      const ph = (t * 0.05 + k * 0.1) % 1, x = 30 + k * 18 + Math.sin(t * 0.7 + k) * 6, y = 30 + ph * 220;
      g.globalAlpha = 0.35 * Math.sin(ph * Math.PI); g.fillStyle = "#ffffff"; g.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    g.globalAlpha = 1;
  } else if (name === "garden") {
    const x = 40 + ((t * 14) % 170), y = 6 + Math.sin(t * 3) * 3, flap = Math.floor(t * 8) % 2; // a butterfly over the grass
    g.fillStyle = "#f472b6"; g.fillRect(Math.round(x) - 2, Math.round(y) - (flap ? 1 : 0), 2, flap ? 2 : 1); g.fillRect(Math.round(x) + 1, Math.round(y) - (flap ? 1 : 0), 2, flap ? 2 : 1);
    g.fillStyle = OUT; g.fillRect(Math.round(x), Math.round(y) - 1, 1, 2);
  }
}
const LK = () => LOOKS[st.look] || LOOKS.cozy;
function setLook(name) {
  if (!LOOKS[name] || name === st.look) return;
  st.prevLook = st.look; st.look = name; st.lookT = 0;
  document.documentElement.dataset.look = name;
}
// which look: golden boards are always the crystal cave; otherwise the hamster decides
function updateLook() { setLook(st.golden ? "crystal" : st.hamLook || "cozy"); }
function hamLookFrom(j) {
  const h = j && j.hamster, now = (j && j.serverTime) || Date.now();
  const age = h && h.updatedAt ? now - Date.parse(h.updatedAt) : Infinity;
  if (!h || h.freshness === "stale" || !(age <= 120_000)) return "cozy"; // no fresh reading: nobody knows
  return j.idle ? "moonlit" : "garden";
}

// ---------- the moving parts ----------
function drawRoots(t) {
  D.roots.forEach((pts, i) => {
    const w = st.rootWob[i], n = pts.length;
    const off = (k) => (w > 0.01 ? Math.sin(t * 38 + k * 0.7) * w * (k / n) * 2 : 0);
    const base = pts[0];
    const R = LK().root;
    if (base.x > LEFT + 4 && base.x < RIGHT - 4) { const wx = base.x < W / 2 ? LEFT : RIGHT; line(g, wx, base.y - 10, base.x, base.y, LK().hang); } // hangs from the wall
    for (let k = 0; k < n; k++) disc(g, pts[k].x, pts[k].y + off(k), 3.6, OUT);
    for (let k = 0; k < n; k++) disc(g, pts[k].x, pts[k].y + off(k), 2.7, R[1]);
    g.fillStyle = R[2];
    for (let k = 0; k < n; k++) g.fillRect(Math.round(pts[k].x), Math.round(pts[k].y + off(k)) - 2, 1, 1);
    g.fillStyle = R[0];
    for (let k = 1; k < n; k += 3) g.fillRect(Math.round(pts[k].x), Math.round(pts[k].y + off(k)) + 1, 2, 1);
  });
}
function drawPebbles(t) {
  D.pebbles.forEach((p, i) => {
    const f = st.flash.get("peb" + i) || 0, r = p.r + (f > 0 ? 0.6 : 0);
    disc(g, p.x, p.y, r + 1, OUT);
    disc(g, p.x, p.y, r, f > 0 ? "#fff8d0" : p.guard ? "#c9a227" : LK().peb[0]);
    g.fillStyle = f > 0 ? "#ffffff" : p.guard ? "#ffe9a8" : LK().peb[1];
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
  const { x, y, r } = D.WHEEL, hot = st.wheelFlash > 0, rim = st.golden ? "#ffd166" : LK().rim;
  disc(g, x, y, r + 1, OUT);
  disc(g, x, y, r, hot ? "#fff8d0" : rim);
  disc(g, x, y, r - 2, OUT);
  disc(g, x, y, r - 3, LK().wheelIn);
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
  PX.fillEllipse(g, s.x + 0.5, s.y + bob, 5.5, 6, LK().glow);
  g.globalAlpha = 1;
  for (let r = 0; r < SEED_ART.length; r++) for (let k = 0; k < 5; k++) {
    const p = SEED_ART[r][k];
    if (p === ".") continue;
    g.fillStyle = p === "1" ? OUT : p === "2" ? LK().seed[0] : LK().seed[1];
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
// an item's flat art, fitted into a box (pixel art is only ever halved, never smeared)
const iconCache = new Map();
function itemIcon(it, frame) {
  const spr = (window.SPRITES || {})[it.sprite];
  if (!spr || typeof window.drawSprite !== "function") return null;
  const fr = frame % (spr.frames ? spr.frames.length : 1), key = it.id + "|" + fr;
  if (iconCache.has(key)) return iconCache.get(key);
  const c = document.createElement("canvas");
  c.width = spr.w; c.height = spr.h;
  window.drawSprite(c.getContext("2d"), spr, fr, 0, 0, {});
  iconCache.set(key, c);
  return c;
}
function drawIcon(it, cx, cy, box, t) {
  const spr = (window.SPRITES || {})[it.sprite], n = spr && spr.frames ? spr.frames.length : 1;
  const ic = itemIcon(it, it.animated && !still ? Math.floor(t * 5) % n : 0);
  if (!ic) { disc(g, cx, cy, 5, RARITY[it.rarity] || "#ffffff"); return; }
  const k = Math.max(ic.width, ic.height) > box ? 0.5 : 1, w = ic.width * k, h = ic.height * k;
  g.drawImage(ic, Math.round(cx - w / 2), Math.round(cy - h / 2), w, h);
}
function drawPrize(t) {
  if (!st.prize || st.prizeGone) return;
  const sp = D.PRIZE_SPOTS[st.prize.spot], it = CATALOG.get(st.prize.item);
  if (!sp || !it) return;
  const col = RARITY[it.rarity] || "#ffffff", bob = still ? 0 : Math.round(Math.sin(t * 2.5) * 1.2), y = sp.y + bob;
  const R = D.prizeRadius(st.mode === "fall" && st.res ? st.res.wager : st.wager); // a bigger wager, a bigger target
  g.globalAlpha = 0.28 + 0.14 * Math.sin(t * 4);
  disc(g, sp.x, y, R + 4.5, col);
  g.globalAlpha = 1;
  disc(g, sp.x, y, R + 2.5, OUT);
  disc(g, sp.x, y, R + 1.5, "#3a2a1a");
  drawIcon(it, sp.x, y, 16, t);
  if (it.rarity === "legendary" || it.rarity === "epic") { // a twinkle orbits the good stuff
    const a = t * 3, n = it.rarity === "legendary" ? 3 : 1;
    for (let k = 0; k < n; k++) { const b = a + (k * Math.PI * 2) / n, x = Math.round(sp.x + Math.cos(b) * (R + 5)), yy = Math.round(y + Math.sin(b) * (R + 5)); g.fillStyle = "#fff8d0"; g.fillRect(x, yy - 1, 1, 3); g.fillRect(x - 1, yy, 3, 1); }
  }
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

// ---------- talking to the server ----------
async function api(path, body) {
  try {
    const r = body ? await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN, ...body }) })
      : await fetch(path, { cache: "no-store" });
    let j = {};
    try { j = await r.json(); } catch {}
    return { ok: r.ok, j };
  } catch { return { ok: false, j: { error: "offline" } }; }
}
function setBoard(b) {
  st.golden = !!(b && b.golden);
  st.crate = b && Number.isInteger(b.crate) ? b.crate : -1;
  st.prize = b && b.prize ? b.prize : null;
  st.prizeGone = false;
  st.seedOn = D.seeds.map(() => true);
  updateLook();
  renderHud();
}
async function load() {
  const r = await api(`/api/state?token=${encodeURIComponent(TOKEN)}`);
  if (!r.ok) { say("Can't reach the server", 4000); return; }
  if (Number.isFinite(r.j.dropStash)) st.stash = r.j.dropStash;
  st.hamLook = hamLookFrom(r.j);
  if (st.mode !== "fall") updateLook(); // never mid-drop
  const me = r.j.me;
  if (!me) { st.mode = "noden"; renderHud(); return; }
  st.watts = me.watts;
  if (st.mode === "load" || st.mode === "noden") { // first numbers: no count-up, and tickHud only redraws changes
    st.mode = "aim"; st.shownWatts = st.watts; st.shownStash = st.stash;
    $("watts").textContent = fmt(st.watts); $("stash").textContent = fmt(st.stash);
  }
  if (st.mode === "aim" && me.drop) setBoard(me.drop.board);
  if (st.mode === "aim") syncWager();
  renderHud();
}
function say(msg, ms = 1800) { st.msg = msg; st.msgUntil = performance.now() + ms; renderHud(); setTimeout(renderHud, ms + 30); }
const DROP_WORDS = { poor: "Not enough Watts", bad_wager: "Wager at least 500 W", too_fast: "One at a time", unknown_player: "No den yet", offline: "You're offline" };

// ---------- a drop ----------
async function drop() {
  if (st.mode === "noden") { location.href = "/"; return; }
  if (st.mode !== "aim") return;
  if (st.watts < st.wager) { say("Not enough Watts"); return; }
  st.mode = "wait"; renderHud();
  sfx("drop");
  const r = await api("/api/drop", { aim: st.aim, wager: st.wager });
  if (!r.ok || !r.j.result) {
    st.mode = "aim";
    say(DROP_WORDS[r.j.error] || "That didn't work");
    if (r.j.error === "unknown_player") st.mode = "noden";
    load();
    return;
  }
  const R = r.j.result;
  st.res = R;
  st.next = { board: r.j.board, watts: r.j.me ? r.j.me.watts : st.watts - R.wager + R.total, stash: r.j.stash };
  st.watts -= R.wager; // what's left while he falls; the winnings land at the end
  setBoard(R.board); // the board this drop was played on (it was already showing)
  st.sim = D.simulate(R.aim, R.seed, { crate: R.board.crate, prize: R.board.prize ? R.board.prize.spot : -1, prizeR: D.prizeRadius(R.wager) });
  st.found = null; st.won = null; st.fly = null; st.reveal = null;
  st.mode = "fall"; st.i = 0; st.chain = 0; st.lastSeedF = -999; st.trail = []; st.banner = null; st.slotFlash = -1;
  renderHud();
}
function seedPay(chain) { return Math.round((st.res.wager * PAY.SEED_PCT * Math.min(chain, PAY.COMBO_MAX) * (st.golden ? 2 : 1)) / 100); }
function crateWords(c) {
  if (!c) return null;
  if (c.kind === "watts") return { str: `+${fmt(c.watts)}W`, col: "#ffd166" };
  if (c.kind === "boost") return { str: "BOOST", col: "#ffd166" };
  if (c.kind === "shield") return { str: "SHIELD", col: "#ffd166" };
  if (c.kind === "decor") return { str: "RARE!", col: "#f472b6" };
  return { str: "CRATE", col: "#eef0f5" };
}
function onEvent(e) {
  const F = st.sim.frames, bx = F[e.f * 3], by = F[e.f * 3 + 1];
  if (e.kind === "peb") { st.flash.set("peb" + e.i, 0.14); sfx("peg", { pitch: 1 - by / H }); }
  else if (e.kind === "root") { st.rootWob[e.i] = 1.4; sfx("root"); }
  else if (e.kind === "acorn") { st.squash[e.i] = 1; st.shake = Math.max(st.shake, 0.12); burst(D.ACORNS[e.i].x, D.ACORNS[e.i].y, 6, ["#e3b27a", "#ffffff"]); sfx("acorn"); }
  else if (e.kind === "wheel") { st.wheelFlash = 0.12; sfx("wheel"); }
  else if (e.kind === "seed") {
    st.seedOn[e.i] = false;
    st.chain = e.f - st.lastSeedF < PAY.COMBO_FRAMES ? st.chain + 1 : 1;
    st.lastSeedF = e.f;
    const s = D.seeds[e.i];
    pop(s.x, s.y - 6, `+${seedPay(st.chain)}W`, "#ffd166");
    if (st.chain > 1) pop(s.x, s.y - 16, `COMBO X${Math.min(st.chain, PAY.COMBO_MAX)}`, "#4ade80");
    burst(s.x, s.y, 7, ["#ffd166", "#fff8d0"]);
    sfx("seed", { chain: st.chain });
  } else if (e.kind === "crate") {
    const c = D.crateSpots[e.i];
    st.crate = -1;
    st.found = crateWords(st.res.crate) || { str: "CRATE", col: "#eef0f5" };
    st.fly = { kind: "crate", x: c.x, y: c.y, vx: bx < c.x ? 1.1 : -1.1, vy: -2.4, t: 0 }; // knocked loose: it hops up, then pops open
    burst(c.x, c.y, 8, ["#c2410c", "#ffd166"], 1.4);
    st.shake = Math.max(st.shake, 0.12);
    sfx("crateHit");
  } else if (e.kind === "prize") {
    const sp = D.PRIZE_SPOTS[e.i], it = st.prize && CATALOG.get(st.prize.item);
    st.prizeGone = true;
    if (it) {
      st.won = { it, dup: st.res.prize ? st.res.prize.dup : 0 };
      st.fly = { kind: "prize", x: sp.x, y: sp.y, vx: bx < sp.x ? 1.1 : -1.1, vy: -2.6, t: 0 };
      burst(sp.x, sp.y, 12, [RARITY[it.rarity], "#fff8d0"], 1.8);
      st.shake = Math.max(st.shake, it.rarity === "legendary" ? 0.3 : 0.14);
      sfx("crateHit");
    }
  } else if (e.kind === "slot") {
    st.slotFlash = e.i; st.slotT = 0;
    if (st.sim.slotId !== "stash") sfx("land", { slot: st.sim.slotId }); // the stash gets its fanfare at the end
    burst(bx, by, 10, st.sim.slotId === "stash" ? ["#ffd166", "#fff8d0"] : st.sim.slotId === "dead" ? ["#9ca3af"] : ["#ffd166", "#eef0f5"]);
  }
}
function finish() {
  const R = st.res, id = R.slotId, N = st.next;
  if (st.sim.slotId !== id) console.warn("drop replay landed elsewhere:", st.sim.slotId, "server:", id); // the server's word stands
  if (id === "stash") { coinShower(40); st.shake = 0.5; sfx("jackpot"); }
  st.watts = N.watts;
  st.stash = N.stash;
  const lines = [];
  if (st.found) lines.push({ str: `CRATE ${st.found.str}`, col: st.found.col });
  if (st.won) lines.push(st.won.dup ? { str: `${st.won.it.name.toUpperCase()} AGAIN +${fmt(st.won.dup)}W`, col: "#eef0f5" } : { str: `NEW ${st.won.it.name.toUpperCase()}`, col: RARITY[st.won.it.rarity] });
  st.banner = Object.assign(id === "stash" ? { a: "BOUNTY!", b: `+${fmt(R.total)} W`, col: "#ffd166", t: 0 }
    : id === "dead" ? { a: "DEAD END", b: R.total ? `+${fmt(R.total)} W` : "", col: "#9ca3af", t: 0 }
    : { a: id === "pantry" ? "PANTRY" : "NEST", b: `+${fmt(R.total)} W`, col: id === "pantry" ? "#ffd166" : "#eef0f5", t: 0 }, { lines });
  st.mode = "done"; st.done = id === "stash" ? 3.2 : st.won && !st.won.dup ? 2.6 : 1.7;
  renderHud();
}

// ---------- the wager ----------
// The slider is logarithmic: far left is the minimum, far right the whole balance, and small wagers stay
// easy to pick even with millions. In between it lands on round numbers (two significant digits).
const SLIDER_MAX = 1000;
const wagerMax = () => Math.max(COST, Math.floor(st.watts));
function sliderToWager(v) {
  const max = wagerMax();
  if (v <= 0 || max <= COST) return COST;
  if (v >= SLIDER_MAX) return max;
  const w = COST * Math.pow(max / COST, v / SLIDER_MAX), unit = Math.pow(10, Math.floor(Math.log10(w)) - 1);
  return clamp(Math.round(w / unit) * unit, COST, max);
}
const wagerToSlider = (w) => (wagerMax() <= COST ? 0 : clamp(Math.round((SLIDER_MAX * Math.log(w / COST)) / Math.log(wagerMax() / COST)), 0, SLIDER_MAX));
function setWager(v, from = "") { // from: the control being used, which keeps its own value
  const n = Math.floor(Number(v));
  st.wager = Number.isSafeInteger(n) && n >= COST ? n : COST;
  if (from !== "typing") $("wagerIn").value = String(st.wager);
  if (from !== "slider") $("wagerRange").value = String(wagerToSlider(st.wager));
  renderHud();
}
// the balance moved: keep the wager affordable and the slider honest
function syncWager() { setWager(Math.min(st.wager, wagerMax()), document.activeElement === $("wagerIn") ? "typing" : document.activeElement === $("wagerRange") ? "slider" : ""); }
$("wagerRange").addEventListener("input", () => setWager(sliderToWager(Number($("wagerRange").value)), "slider"));
$("wagerIn").addEventListener("input", () => setWager($("wagerIn").value, "typing"));
$("wagerIn").addEventListener("change", () => setWager(Math.min(Math.floor(Number($("wagerIn").value)) || COST, wagerMax())));

// ---------- hud ----------
function renderHud() {
  const b = $("dropBtn"), msg = st.msg && performance.now() < st.msgUntil ? st.msg : "";
  b.disabled = !["aim", "noden"].includes(st.mode) || !!msg;
  b.textContent = msg || (st.mode === "noden" ? "Make your den first" : st.mode === "load" ? "Opening…" : `Drop · ${fmt(st.wager)} W`);
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
    if (st.done <= 0) { st.mode = "aim"; st.sim = null; setBoard(st.next.board); st.next = null; syncWager(); }
  }
  for (const [k, v] of st.flash) { if (v - dt <= 0) st.flash.delete(k); else st.flash.set(k, v - dt); }
  st.rootWob = st.rootWob.map((w) => Math.max(0, w - dt * 3));
  st.squash = st.squash.map((s) => Math.max(0, s - dt * 6));
  st.wheelFlash = Math.max(0, st.wheelFlash - dt);
  st.shake = Math.max(0, st.shake - dt);
  st.slotT += dt;
  st.lookT = Math.min(1, st.lookT + dt / 0.8);
  draw(T);
  tickHud(dt);
}
function draw(t) {
  g.save();
  if (st.shake > 0 && !still) g.translate(Math.round((Math.random() - 0.5) * st.shake * 10), Math.round((Math.random() - 0.5) * st.shake * 10));
  if (st.prevLook && st.lookT < 1) { g.drawImage(lookBg(st.prevLook), 0, 0); g.globalAlpha = st.lookT; }
  g.drawImage(lookBg(st.look || "cozy"), 0, 0);
  g.globalAlpha = 1;
  ambient(st.look, t);
  if (st.slotFlash >= 0 && st.slotT < 1.2) { // the chamber he landed in glows
    let x = LEFT; for (let k = 0; k < st.slotFlash; k++) x += D.SLOTS[k].w;
    g.fillStyle = `rgba(255,209,102,${(0.35 * (1 - st.slotT / 1.2)).toFixed(3)})`;
    g.fillRect(x, DIV_TOP, D.SLOTS[st.slotFlash].w, H - DIV_TOP - 10);
  }
  if (st.golden) {
    for (let k = 0; k < 14; k++) { const x = LEFT + ((k * 67 + t * 9) % (RIGHT - LEFT)), y = 20 + ((k * 41 + t * 14 * (1 + (k % 3))) % (DIV_TOP - 30)); if ((t * 2 + k) % 1.5 < 1) { g.fillStyle = "#fff3c4"; g.fillRect(Math.round(x), Math.round(y), 1, 1); } }
  }
  drawRoots(t);
  drawPebbles(t);
  D.ACORNS.forEach((a, i) => drawAcorn(a, st.squash[i]));
  drawWheel(still ? 0 : t * 60 * D.WHEEL.omega);
  D.seeds.forEach((s, i) => { if (st.seedOn[i]) drawSeed(s, i, t); });
  drawCrate(t);
  drawPrize(t);
  // the dividers, in front of the chambers
  for (const x of D.dividers) {
    g.fillStyle = OUT; g.fillRect(x - 2, DIV_TOP - 1, 4, H - 10 - DIV_TOP + 1);
    g.fillStyle = LK().div[0]; g.fillRect(x - 1, DIV_TOP, 2, H - 10 - DIV_TOP);
    g.fillStyle = LK().div[1]; g.fillRect(x - 1, DIV_TOP, 1, H - 10 - DIV_TOP);
  }
  // him
  if (st.mode === "aim" || st.mode === "wait") {
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
  if (st.fly) {
    const c = st.fly; c.t += 1 / 60; c.x += c.vx; c.y += c.vy; c.vy += 0.12;
    const wob = Math.sin(c.t * 30);
    if (c.kind === "prize") { disc(g, c.x, c.y + wob, 9.5, OUT); disc(g, c.x, c.y + wob, 8.5, "#3a2a1a"); drawIcon(st.won.it, c.x, c.y + wob, 16, T); }
    else {
      const s = (window.SPRITES || {}).crate, x = Math.round(c.x - 8), y = Math.round(c.y - 8 + wob);
      if (s && typeof window.drawSprite === "function") window.drawSprite(g, s, 0, x, y, {}); else { g.fillStyle = "#c2410c"; g.fillRect(x, y, 16, 16); }
    }
    if (c.t > 0.42) {
      const col = c.kind === "prize" ? RARITY[st.won.it.rarity] : st.found.col, legend = c.kind === "prize" && st.won.it.rarity === "legendary";
      burst(c.x, c.y, legend ? 40 : 22, ["#ffd166", "#f5a623", "#fff8d0", col], legend ? 3.2 : 2.6);
      st.reveal = { kind: c.kind, x: clamp(c.x, 64, W - 64), y: clamp(c.y - 30, 24, DIV_TOP - 96), t: 0 };
      st.fly = null; st.shake = Math.max(st.shake, legend ? 0.4 : 0.18);
      if (legend) coinShower(16);
      sfx(c.kind === "prize" && !st.won.dup && ["epic", "legendary"].includes(st.won.it.rarity) ? "jackpot" : "crateOpen");
    }
  }
  if (st.reveal) { // what was inside, big, for a moment
    const r = st.reveal, prize = r.kind === "prize", life = prize ? 2.4 : 1.8; r.t += 1 / 60;
    if (r.t > life || (prize ? !st.won : !st.found)) st.reveal = null;
    else {
      const k = Math.min(1, r.t * 8), y = Math.round(r.y - r.t * 5);
      g.globalAlpha = Math.min(1, (life - r.t) * 3);
      if (prize) {
        const it = st.won.it, col = RARITY[it.rarity], name = it.name.toUpperCase(), big = name.length <= 16 ? 2 : 1;
        const wd = Math.min(W - 8, Math.max(110, name.length * 4 * big + 40)), cx = clamp(r.x, wd / 2 + 4, W - wd / 2 - 4); // always inside the board
        strip(g, cx, y - 4, wd * k, 34);
        if (k >= 1) {
          g.fillStyle = col; g.fillRect(Math.round(cx - wd / 2), y - 4, wd, 1); g.fillRect(Math.round(cx - wd / 2), y + 29, wd, 1);
          drawIcon(it, cx - wd / 2 + 14, y + 13, 18, T);
          PX.text(g, st.won.dup ? "AGAIN" : it.rarity.toUpperCase(), cx + 12, y, col);
          bigText(g, name, cx + 12, y + 9, st.won.dup ? "#eef0f5" : col, big);
          if (st.won.dup) PX.text(g, `+${fmt(st.won.dup)}W`, cx + 12, y + 22, "#ffd166");
        }
      } else {
        strip(g, r.x, y - 3, 96 * k, 24);
        if (k >= 1) {
          const s = (window.SPRITES || {}).crate;
          if (s && typeof window.drawSprite === "function") window.drawSprite(g, s, 0, Math.round(r.x - 44), y, {});
          bigText(g, st.found.str, r.x + 8, y + 2, st.found.col, 2);
        }
      }
      g.globalAlpha = 1;
    }
  }
  if (st.banner) {
    const b = st.banner; b.t += 1 / 60;
    const s = Math.min(1, b.t * 6), jack = b.a === "BOUNTY!";
    if (!jack || Math.floor(b.t * 6) % 2 === 0 || b.t > 1.2) {
      const extra = b.lines.length * 9, top = DIV_TOP - 46 - Math.max(0, extra - 10);
      strip(g, W / 2, top, 170, 34 + extra);
      bigText(g, b.a, W / 2, top + 2, b.col, s >= 1 ? 3 : 2);
      if (b.b) bigText(g, b.b, W / 2, top + 23, b.col === "#9ca3af" ? "#eef0f5" : b.col, 2);
      b.lines.forEach((l, k) => PX.text(g, l.str, W / 2, top + 37 + k * 9, l.col));
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
  if (document.activeElement === $("wagerIn") || document.activeElement === $("wagerRange")) { if (e.key === "Enter") document.activeElement.blur(); return; } // setting a wager, not playing
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { if (st.mode === "aim") st.aim = clamp(st.aim + (e.key === "ArrowLeft" ? -3 : 3), AIM_MIN, AIM_MAX); e.preventDefault(); }
  else if (e.key === " " || e.key === "Enter") { if (document.activeElement !== $("dropBtn")) { drop(); e.preventDefault(); } }
});

renderHud();
if (SND) { SND.music("drop"); SND.button($("soundBtn")); }
requestAnimationFrame(frame);
fetch("/api/config").then((r) => r.json()).then((cfg) => {
  if (cfg.balance && cfg.balance.DROP) { COST = cfg.balance.DROP.COST; $("wagerIn").min = String(COST); }
  setWager(COST);
  for (const it of cfg.catalog || []) CATALOG.set(it.id, it);
}).catch(() => {}).finally(() => { load(); });
setInterval(() => { if (!document.hidden && (st.mode === "aim" || st.mode === "noden")) load(); }, 10_000); // the shared stash moves
updateLook();
window.__drop = { st, D, drop, step, load, setLook, LOOKS };
})();

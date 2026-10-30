// Squeekroom client: live state, HUD strip, and the room renderer.
// Phase 3 (renderer core): every piece of art is a placeholder painted in code. Phase 4's
// sprites.js drops real art in through the sprite registry below without touching game logic.
(() => {
"use strict";
const $ = (id) => document.getElementById(id);

// ---------- room geometry (server ROOM is the source of truth; these are the defaults) ----------
const LW = 320, LH = 192; // logical canvas: 20 x 12 cells of 16 px
let ROOM = { COLS: 20, ROWS: 12, CELL: 16, FLOOR_ROW: 11, WALL_TOP: 2, WALL_BOTTOM: 7, RESERVED: { wheel: [3, 6], burrow: [16, 18] } };
let CELL = 16, FLOOR_Y = 176; // furniture bottoms stand on this line; the floor band is below it
const BASEBOARD = 6; // wall trim height just above the floor line
let WHEEL = { cx: 80, cy: 150, r: 23, x: 56, y: 126 }; // 48 x 48 box centred on floor cols 3..6
let BURROW = { cx: 280, x: 256, y: 144, w: 48, h: 32 }; // 48 x 32 mound on floor cols 16..18
let SPOT = { wheel: { x: 80, y: 170 }, sit: { x: 128, y: 176 }, burrow: { x: 280, y: 176 } };
function applyRoom(room) {
  if (room && typeof room === "object") ROOM = { ...ROOM, ...room };
  CELL = ROOM.CELL || 16;
  FLOOR_Y = ROOM.FLOOR_ROW * CELL;
  const [wa, wb] = ROOM.RESERVED.wheel, [ba, bb] = ROOM.RESERVED.burrow;
  const wcx = ((wa + wb + 1) * CELL) / 2, bcx = ((ba + bb + 1) * CELL) / 2;
  WHEEL = { cx: wcx, cy: FLOOR_Y - 26, r: 23, x: wcx - 24, y: FLOOR_Y - 50 };
  BURROW = { cx: bcx, x: bcx - 24, y: FLOOR_Y - 32, w: 48, h: 32 };
  SPOT = { wheel: { x: wcx, y: WHEEL.cy + WHEEL.r - 3 }, sit: { x: (wb + 1) * CELL + 16, y: FLOOR_Y }, burrow: { x: bcx, y: FLOOR_Y } };
}
applyRoom();

// ---------- palette + tiny pixel font (shared with squeekplace) ----------
const PALETTE = ["", "#000000", "#ffffff", "#f5a623", "#c2410c", "#7c3f1d", "#ffd166", "#3b82f6", "#1e3a8a", "#22c55e", "#166534", "#ef4444", "#f472b6", "#9ca3af", "#4b5563", "#a78bfa"];
const OUTLINE = "#1d1a14";
// 3x5 pixel font: rows top to bottom, 3 bits each
const FONT = {A:[2,5,7,5,5],B:[6,5,6,5,6],C:[3,4,4,4,3],D:[6,5,5,5,6],E:[7,4,6,4,7],F:[7,4,6,4,4],G:[3,4,5,5,3],H:[5,5,7,5,5],I:[7,2,2,2,7],J:[1,1,1,5,2],K:[5,5,6,5,5],L:[4,4,4,4,7],M:[5,7,7,5,5],N:[6,5,5,5,5],O:[2,5,5,5,2],P:[6,5,6,4,4],Q:[2,5,5,6,3],R:[6,5,6,5,5],S:[3,4,2,1,6],T:[7,2,2,2,2],U:[5,5,5,5,7],V:[5,5,5,5,2],W:[5,5,7,7,5],X:[5,5,2,5,5],Y:[5,5,2,2,2],Z:[7,1,2,4,7],"0":[2,5,5,5,2],"1":[2,6,2,2,7],"2":[6,1,2,4,7],"3":[6,1,2,1,6],"4":[5,5,7,1,1],"5":[7,4,6,1,6],"6":[3,4,6,5,2],"7":[7,1,2,2,2],"8":[2,5,2,5,2],"9":[2,5,3,1,6],"!":[2,2,2,0,2],"?":[6,1,2,0,2],".":[0,0,0,0,2],"-":[0,0,7,0,0],"$":[3,6,2,3,6],"#":[5,7,5,7,5],"<":[1,2,4,2,1],"+":[0,2,7,2,0],"/":[1,1,2,4,4]," ":[0,0,0,0,0]};
function drawText(c, str, x, y, color) {
  c.fillStyle = color;
  let cx = x;
  for (const ch of str) {
    const gl = FONT[ch] || FONT["?"];
    for (let r = 0; r < 5; r++) for (let b = 0; b < 3; b++) if (gl[r] & (4 >> b)) c.fillRect(cx + b, y + r, 1, 1);
    cx += 4;
  }
}

// ---------- sprite registry (phase 4 fills it) ----------
// sprites.js, loaded before game.js, may define:
//   window.SPRITES = { [spriteId]: spriteData }
//     ids: every catalog item's `sprite` (furniture, rugs, wall decor, wallpaper/floor 16x16 swatches,
//     wheel tier hub overlays "wheel_t1".."wheel_t5"), plus "wheel" (48x48, 4 frames),
//     "hamster_run" (24x24, 4 frames), "hamster_sit", "hamster_blink", "hamster_sleep" (2 frames), "burrow" (48x32).
//   window.drawSprite(ctx, sprite, frame, x, y, opts)   opts: { flip, remap, skin, angle, tier, w, h, t }
//   window.SKIN_REMAPS = { [skinId]: 16-entry palette index map }   (optional)
// An entry may instead be a function (ctx, frame, x, y, opts) => void. The registry is read at draw
// time, so late-loaded art works too. Anything missing falls back to the placeholder painters below.
window.SPRITES = window.SPRITES || {};
const spriteWarned = new Set();
function hasSprite(id) {
  const s = id && window.SPRITES ? window.SPRITES[id] : null;
  return !!s && (typeof s === "function" || typeof window.drawSprite === "function");
}
function sprite(c, id, frame, x, y, opts) {
  if (!hasSprite(id)) return false;
  const s = window.SPRITES[id];
  try {
    if (typeof s === "function") s(c, frame, x, y, opts || {});
    else window.drawSprite(c, s, frame, x, y, opts || {});
    return true;
  } catch (e) {
    if (!spriteWarned.has(id)) { spriteWarned.add(id); console.warn(`sprite ${id} failed, using placeholder:`, e); }
    return false;
  }
}

// ---------- pixel primitives (integer pixels only, so placeholders stay crisp when scaled) ----------
function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
function fillEllipse(c, cx, cy, rx, ry, color) {
  c.fillStyle = color;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    const dy = (y + 0.5 - cy) / ry;
    if (Math.abs(dy) > 1) continue;
    const half = rx * Math.sqrt(1 - dy * dy);
    const x0 = Math.round(cx - half), x1 = Math.round(cx + half);
    if (x1 > x0) c.fillRect(x0, y, x1 - x0, 1);
  }
}
function line(c, x0, y0, x1, y1, color) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  c.fillStyle = color;
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
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function shade(hex, f) { const [r, g, b] = hexRgb(hex); const m = (v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f))); return `rgb(${m(r)},${m(g)},${m(b)})`; }
function luminance(hex) { const [r, g, b] = hexRgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- placeholder painters ----------
// Placeholder item: filled box in a palette colour picked from the id hash, 1-px outline, the
// item name in the 3x5 font. Cached per item + size.
const PH_COLORS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 13, 14].map((i) => PALETTE[i]);
const itemCache = new Map();
function placeholderItem(item, pw, ph) {
  const key = `${item.id}|${pw}|${ph}`;
  if (itemCache.has(key)) return itemCache.get(key);
  const c = canvas(pw, ph), g = c.getContext("2d");
  const fill = PH_COLORS[hash(item.id) % PH_COLORS.length];
  g.fillStyle = OUTLINE; g.fillRect(0, 0, pw, ph);
  g.fillStyle = fill; g.fillRect(1, 1, pw - 2, ph - 2);
  g.fillStyle = shade(fill, 0.35); g.fillRect(1, 1, pw - 2, 1); g.fillRect(1, 1, 1, ph - 2); // light top-left
  g.fillStyle = shade(fill, -0.3); g.fillRect(1, ph - 2, pw - 2, 1); g.fillRect(pw - 2, 1, 1, ph - 2);
  // label: wrap words into lines that fit, centred
  const maxChars = Math.max(1, Math.floor((pw - 3) / 4)), maxLines = Math.max(1, Math.floor((ph - 3) / 6));
  const lines = [];
  let cur = "";
  for (let word of String(item.name || item.id).toUpperCase().replace(/[^A-Z0-9 .!?+\-/#$]/g, "").split(" ")) {
    if (!word) continue;
    if (cur && (cur + " " + word).length <= maxChars) { cur += " " + word; continue; }
    if (cur) lines.push(cur);
    while (word.length > maxChars) { lines.push(word.slice(0, maxChars)); word = word.slice(maxChars); }
    cur = word;
  }
  if (cur) lines.push(cur);
  lines.length = Math.min(lines.length, maxLines);
  const ink = luminance(fill) > 0.55 ? OUTLINE : "#ffffff";
  const y0 = Math.floor((ph - (lines.length * 6 - 1)) / 2);
  lines.forEach((ln, i) => drawText(g, ln, Math.floor((pw - (ln.length * 4 - 1)) / 2), y0 + i * 6, ink));
  itemCache.set(key, c);
  return c;
}

// Wallpaper / floor: simple two-tone procedural patterns, cached per style id.
const WALL_H = () => FLOOR_Y; // wall covers y 0..FLOOR_Y (baseboard included)
const styleCache = new Map();
function wallpaperCanvas(id) {
  const key = `wp|${id}|${hasSprite(id) ? "s" : "p"}|${FLOOR_Y}`;
  if (styleCache.has(key)) return styleCache.get(key);
  const H = WALL_H(), c = canvas(LW, H), g = c.getContext("2d");
  const wallH = H - BASEBOARD;
  if (hasSprite(id)) {
    for (let y = 0; y < wallH; y += 16) for (let x = 0; x < LW; x += 16) sprite(g, id, 0, x, y, {});
  } else {
    const rnd = rng(hash(id));
    const pat = {
      wp_plain() { for (let x = 0; x < LW; x += 8) { g.fillStyle = (x / 8) % 2 ? "#efe3c8" : "#f6ecd6"; g.fillRect(x, 0, 8, wallH); } },
      wp_polka() { g.fillStyle = "#fde4ee"; g.fillRect(0, 0, LW, wallH); for (let y = 6, row = 0; y < wallH; y += 12, row++) for (let x = (row % 2) * 8 + 4; x < LW; x += 16) fillEllipse(g, x + 0.5, y + 0.5, 2, 2, "#f472b6"); },
      wp_forest() {
        g.fillStyle = "#d3ead2"; g.fillRect(0, 0, LW, wallH);
        g.fillStyle = "#bfe0be"; g.fillRect(0, wallH - 60, LW, 60);
        for (let x = -6; x < LW; x += 18 + Math.floor(rnd() * 10)) { const h = 30 + Math.floor(rnd() * 34), col = rnd() < 0.5 ? "#22c55e" : "#166534"; for (let k = 0; k < h; k++) { const half = Math.floor((k / h) * 9); g.fillStyle = col; g.fillRect(x + 9 - half, wallH - h + k, half * 2 + 1, 1); } }
      },
      wp_circuit() {
        g.fillStyle = "#0f3b2a"; g.fillRect(0, 0, LW, wallH);
        g.fillStyle = "#1c5a40";
        for (let y = 8; y < wallH; y += 16) g.fillRect(0, y, LW, 1);
        for (let x = 8; x < LW; x += 16) g.fillRect(x, 0, 1, wallH);
        for (let i = 0; i < 70; i++) { const x = 8 + 16 * Math.floor(rnd() * 20), y = 8 + 16 * Math.floor(rnd() * 11); g.fillStyle = rnd() < 0.5 ? "#22c55e" : "#ffd166"; g.fillRect(x - 1, y - 1, 3, 3); }
      },
      wp_night_sky() {
        for (let y = 0; y < wallH; y += 4) { g.fillStyle = `rgb(${Math.round(lerp(11, 30, y / wallH))},${Math.round(lerp(22, 58, y / wallH))},${Math.round(lerp(64, 138, y / wallH))})`; g.fillRect(0, y, LW, 4); }
        for (let i = 0; i < 90; i++) { g.fillStyle = rnd() < 0.2 ? "#ffd166" : "#ffffff"; g.fillRect(Math.floor(rnd() * LW), Math.floor(rnd() * wallH), 1, 1); }
      },
    }[id];
    if (pat) pat();
    else { const a = PH_COLORS[hash(id) % PH_COLORS.length]; for (let x = 0; x < LW; x += 8) { g.fillStyle = (x / 8) % 2 ? shade(a, 0.55) : shade(a, 0.7); g.fillRect(x, 0, 8, wallH); } }
  }
  // crown trim + baseboard (fixed room structure, not part of the swatch)
  g.fillStyle = "rgba(0,0,0,.12)"; g.fillRect(0, 0, LW, 2);
  g.fillStyle = "#7c3f1d"; g.fillRect(0, wallH, LW, BASEBOARD);
  g.fillStyle = "#a35a2a"; g.fillRect(0, wallH, LW, 1);
  g.fillStyle = "#5a2d14"; g.fillRect(0, H - 1, LW, 1);
  styleCache.set(key, c);
  return c;
}
function floorCanvas(id) {
  const key = `fl|${id}|${hasSprite(id) ? "s" : "p"}|${FLOOR_Y}`;
  if (styleCache.has(key)) return styleCache.get(key);
  const H = LH - FLOOR_Y, c = canvas(LW, H), g = c.getContext("2d");
  if (hasSprite(id)) {
    for (let y = 0; y < H; y += 16) for (let x = 0; x < LW; x += 16) sprite(g, id, 0, x, y, {});
  } else {
    const rnd = rng(hash(id));
    const pat = {
      fl_pine() {
        for (let row = 0; row * 8 < H; row++) {
          g.fillStyle = row % 2 ? "#b8783f" : "#c98b4e"; g.fillRect(0, row * 8, LW, 8);
          g.fillStyle = "#7c3f1d"; for (let x = (row % 2) * 20; x < LW; x += 40) g.fillRect(x, row * 8, 1, 8);
          g.fillStyle = "#8f5228"; g.fillRect(0, row * 8 + 7, LW, 1);
        }
        g.fillStyle = "#e0a868"; g.fillRect(0, 0, LW, 1);
      },
      fl_checker() { for (let y = 0; y < H; y += 8) for (let x = 0; x < LW; x += 8) { g.fillStyle = ((x + y) / 8) % 2 ? "#4b5563" : "#f3efe6"; g.fillRect(x, y, 8, 8); } },
      fl_pebble() { g.fillStyle = "#9ca3af"; g.fillRect(0, 0, LW, H); for (let i = 0; i < 80; i++) fillEllipse(g, rnd() * LW, rnd() * H, 2 + rnd() * 2, 1 + rnd() * 1.5, rnd() < 0.5 ? "#6b7280" : "#d1d5db"); },
      fl_cloud() { g.fillStyle = "#dbe4ff"; g.fillRect(0, 0, LW, H); for (let x = 0; x < LW; x += 14) fillEllipse(g, x + rnd() * 6, 4 + rnd() * (H - 8), 6, 3, "#ffffff"); },
    }[id];
    if (pat) pat();
    else { const a = PH_COLORS[hash(id) % PH_COLORS.length]; for (let x = 0; x < LW; x += 8) { g.fillStyle = (x / 8) % 2 ? shade(a, -0.1) : a; g.fillRect(x, 0, 8, H); } }
  }
  g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(0, 0, LW, 1); // contact line at the wall seam
  styleCache.set(key, c);
  return c;
}

// Wheel placeholder: static stand + rim cached per tier, spokes and hub painted live each frame.
const TIER_HUB = ["#9ca3af", "#ffffff", "#c2410c", "#3b82f6", "#a78bfa", "#ffd166"];
const wheelCache = new Map();
function wheelBack() { // stand legs + foot bar, behind the rim
  if (wheelCache.has("back")) return wheelCache.get("back");
  const c = canvas(48, 52), g = c.getContext("2d"), cx = 24, cy = 24;
  for (const [dx, col] of [[0, "#4b5563"], [1, "#6b7280"]]) { line(g, cx + dx, cy, 8 + dx, 49, col); line(g, cx + dx, cy, 39 + dx, 49, col); }
  g.fillStyle = OUTLINE; g.fillRect(5, 49, 38, 2);
  g.fillStyle = "#6b7280"; g.fillRect(6, 49, 36, 1);
  wheelCache.set("back", c);
  return c;
}
function wheelRim() {
  if (wheelCache.has("rim")) return wheelCache.get("rim");
  const c = canvas(48, 48), g = c.getContext("2d"), cx = 24, cy = 24, R = 23;
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    let col = null;
    if (d <= R && d > R - 1) col = OUTLINE;
    else if (d <= R - 1 && d > R - 2.2) col = (x + y) < 48 ? "#e5e7eb" : "#9ca3af"; // light top-left
    else if (d <= R - 2.2 && d > R - 3.2) col = "#6b7280";
    else if (d <= R - 3.2 && d > R - 4.2) col = OUTLINE;
    else if (d <= R - 4.2) col = "rgba(255,255,255,.07)"; // faint mesh
    if (col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
  }
  wheelCache.set("rim", c);
  return c;
}
function drawWheelPlaceholder(c, angleRev, tier) {
  const { cx, cy } = WHEEL, x0 = cx - 24, y0 = cy - 24;
  c.drawImage(wheelBack(), x0, y0);
  c.drawImage(wheelRim(), x0, y0);
  for (let k = 0; k < 6; k++) {
    const a = angleRev * Math.PI * 2 + (k * Math.PI) / 3;
    line(c, cx + Math.cos(a) * 3, cy + Math.sin(a) * 3, cx + Math.cos(a) * 18.5, cy + Math.sin(a) * 18.5, k === 0 ? "#d1d5db" : "#6b7280");
  }
  // a rim marker so the spin reads even when spokes alias
  const a = angleRev * Math.PI * 2;
  c.fillStyle = "#ffd166"; c.fillRect(Math.round(cx + Math.cos(a) * 20.5) - 1, Math.round(cy + Math.sin(a) * 20.5) - 1, 2, 2);
  const hub = TIER_HUB[clamp(tier | 0, 0, 5)];
  fillEllipse(c, cx + 0.5, cy + 0.5, 4, 4, OUTLINE);
  fillEllipse(c, cx + 0.5, cy + 0.5, 3, 3, hub);
  c.fillStyle = shade(hub, 0.5); c.fillRect(cx - 1, cy - 2, 1, 1);
  if (tier >= 3) { c.fillStyle = hub; c.fillRect(cx - 6, cy, 1, 1); c.fillRect(cx + 6, cy, 1, 1); c.fillRect(cx, cy - 6, 1, 1); c.fillRect(cx, cy + 6, 1, 1); }
}

// Burrow placeholder: an earth mound with a dark entrance and a few grass tufts.
function burrowCanvas() {
  if (wheelCache.has("burrow")) return wheelCache.get("burrow");
  const c = canvas(48, 32), g = c.getContext("2d");
  fillEllipse(g, 24, 32, 24, 31, OUTLINE);
  fillEllipse(g, 24, 32, 23, 30, "#7c3f1d");
  fillEllipse(g, 21, 30, 19, 26, "#94522a");
  fillEllipse(g, 18, 26, 10, 14, "#a8653a");
  g.fillStyle = "#5a2d14"; for (const [x, y] of [[33, 14], [37, 20], [10, 22], [28, 8], [14, 13]]) g.fillRect(x, y, 2, 1);
  fillEllipse(g, 24, 32, 12, 14, OUTLINE);
  fillEllipse(g, 24, 32, 11, 13, "#140f0a");
  g.fillStyle = "#22c55e"; for (const x of [12, 15, 30, 33]) { g.fillRect(x, 3 + (x % 3), 1, 3); g.fillRect(x + 1, 2 + (x % 3), 1, 2); }
  g.fillStyle = "#166534"; for (const x of [13, 31]) g.fillRect(x, 5 + (x % 3), 1, 2);
  wheelCache.set("burrow", c);
  return c;
}

// Hamster placeholder: a 24x24 rounded blob with ear and eye dots. Frames are generated once per
// skin and cached, standing in for the phase-4 sprite sheet. All frames face right.
const SKIN_COLORS = {
  skin_classic: { body: "#f5a623", belly: "#ffd166", shade: "#c2410c", ear: "#f472b6", eye: "#000000" },
  skin_albino: { body: "#ffffff", belly: "#ffffff", shade: "#d1d5db", ear: "#f472b6", eye: "#ef4444" },
  skin_caramel: { body: "#c2410c", belly: "#ffd166", shade: "#7c3f1d", ear: "#f472b6", eye: "#000000" },
  skin_panda: { body: "#ffffff", belly: "#ffffff", shade: "#4b5563", ear: "#000000", eye: "#000000" },
  skin_shadow: { body: "#4b5563", belly: "#9ca3af", shade: "#1d1a14", ear: "#f472b6", eye: "#ffffff" },
  skin_golden: { body: "#ffd166", belly: "#ffffff", shade: "#f5a623", ear: "#f472b6", eye: "#000000" },
};
const hamCache = new Map();
function hamsterFrame(kind, frame, skin) {
  const key = `${kind}|${frame}|${skin}`;
  if (hamCache.has(key)) return hamCache.get(key);
  const col = SKIN_COLORS[skin] || SKIN_COLORS.skin_classic;
  const c = canvas(24, 24), g = c.getContext("2d");
  const ear = (x, y) => { g.fillStyle = OUTLINE; g.fillRect(x, y, 3, 3); g.fillStyle = col.ear; g.fillRect(x + 1, y + 1, 1, 1); };
  if (kind === "sleep") {
    // curled ball, eyes shut; frame 1 = inhale (slightly taller and wider)
    const ry = frame ? 6.5 : 5.8, rx = frame ? 10.3 : 10;
    const cy = 23 - ry;
    ear(15, Math.round(cy - ry) - 1);
    fillEllipse(g, 12, cy, rx + 1, ry + 1, OUTLINE);
    fillEllipse(g, 12, cy, rx, ry, col.body);
    fillEllipse(g, 11, cy + ry * 0.55, rx * 0.7, ry * 0.35, col.shade);
    fillEllipse(g, 9, cy - ry * 0.35, rx * 0.4, ry * 0.3, col.belly);
    g.fillStyle = col.eye === "#ffffff" ? "#ffffff" : OUTLINE; g.fillRect(17, Math.round(cy) - 1, 2, 1);
    g.fillStyle = col.ear; g.fillRect(21, Math.round(cy) + 1, 1, 1);
  } else if (kind === "sit" || kind === "blink") {
    ear(9, 4); ear(15, 4);
    fillEllipse(g, 12, 14.5, 9, 9.5, OUTLINE);
    fillEllipse(g, 12, 14.5, 8, 8.5, col.body);
    fillEllipse(g, 12, 18, 5, 4.5, col.belly);
    g.fillStyle = col.shade; g.fillRect(6, 21, 12, 1);
    g.fillStyle = col.eye;
    if (kind === "blink") { g.fillRect(9, 11, 2, 1); g.fillRect(14, 11, 2, 1); }
    else { g.fillRect(9, 10, 1, 2); g.fillRect(15, 10, 1, 2); }
    g.fillStyle = col.ear; g.fillRect(12, 13, 1, 1); g.fillRect(7, 13, 1, 1); g.fillRect(17, 13, 1, 1);
    g.fillStyle = OUTLINE; g.fillRect(8, 23, 3, 1); g.fillRect(14, 23, 3, 1);
  } else {
    // run: horizontal oval facing right, 4-frame leg cycle
    ear(12, 6); ear(16, 7);
    fillEllipse(g, 11.5, 14.5, 10, 7.5, OUTLINE);
    fillEllipse(g, 11.5, 14.5, 9, 6.5, col.body);
    fillEllipse(g, 12, 18, 6, 2.6, col.belly);
    g.fillStyle = col.shade; g.fillRect(4, 19, 4, 1);
    g.fillStyle = col.eye; g.fillRect(17, 11, 1, 2);
    g.fillStyle = col.ear; g.fillRect(21, 14, 1, 1); g.fillRect(17, 15, 1, 1);
    const LEGS = [[[16, 22], [5, 21]], [[13, 22], [8, 22]], [[18, 21], [3, 22]], [[11, 22], [10, 22]]][frame % 4];
    g.fillStyle = OUTLINE; for (const [x, y] of LEGS) g.fillRect(x, y, 2, 2);
    g.fillStyle = col.ear; for (const [x, y] of LEGS) g.fillRect(x, y, 1, 1);
  }
  hamCache.set(key, c);
  return c;
}

// seeded rng (same as squeekplace)
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------- identity (anonymous) ----------
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
let token = ls.get("sr_token");
if (!token || !TOKEN_RE.test(token)) {
  token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  ls.set("sr_token", token);
}

// ---------- client state ----------
const S = {
  loaded: false, demo: false, offline: false, skew: 0,
  height: null, chain: null, hamster: null, live: null, api: "https://api.squeekchain.com/v1",
  night: null, balance: null, catalog: new Map(), me: null, watching: false,
  spin: null, // server's wheel-duty view: { idle } = no settled block for MANUAL_IDLE_AFTER_MS
  meAt: 0, // serverTime of the newest `me` applied (drops an older snapshot that lands late)
};
const params = new URLSearchParams(location.search);
const UTC_OVERRIDE = params.has("utc") ? Number(params.get("utc")) : null; // ?utc=22 previews the tint at that hour

// The reading that drives the room: browser-fetched live status first, the server's copy as
// fallback. Demo mode uses the server's fake hamster only.
function reading() { return (!S.demo && S.live) || S.hamster || null; }
function liveStatus() {
  const h = reading();
  if (!h) return { key: S.offline ? "offline" : S.loaded ? "none" : "connecting", active: false, speed: 0, rpm: 0, h: null };
  if (S.offline && h === S.hamster) return { key: "offline", active: false, speed: 0, rpm: 0, h };
  const age = h.updatedAt ? Date.now() + S.skew - Date.parse(h.updatedAt) : 0;
  const stale = h.freshness === "stale" || (h === S.hamster && age > 120_000);
  const active = h.coreStatus === "ACTIVE" && !stale;
  const speed = active ? Math.max(0, Number(h.speedMmPerSecond) || 0) : 0;
  let rpm = active ? (Number(h.rpmMilli) || 0) / 1000 : 0;
  if (active && !rpm && speed) rpm = (speed / (Math.PI * 200)) * 60; // ~200 mm wheel
  return { key: active ? "active" : stale ? "stale" : "idle", active, speed, rpm, h };
}

// ---------- network ----------
async function refresh() {
  try {
    const r = await fetch(`/api/state?token=${encodeURIComponent(token)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    applyState(await r.json());
    S.offline = false;
  } catch {
    S.offline = true;
  }
  renderHud();
}
function applyState(j) {
  const first = !S.loaded;
  S.loaded = true;
  S.demo = !!j.demo;
  S.height = j.height;
  S.chain = j.chain;
  S.hamster = j.hamster;
  S.night = j.night;
  S.spin = j.spin || null;
  S.balance = j.balance || S.balance;
  if (j.api) S.api = j.api;
  if (typeof j.serverTime === "number") S.skew = j.serverTime - Date.now();
  if (j.room) applyRoom(j.room);
  if (Array.isArray(j.catalog) && (first || j.catalog.length !== S.catalog.size)) S.catalog = new Map(j.catalog.map((i) => [i.id, i]));
  if (j.me) applyMe(j.me, first, { at: j.serverTime });
  else if (j.meError) toast(j.meError === "server_full" ? "The server is full right now." : `Could not load your room (${j.meError}).`, "err");
  if (first) { ham.init = false; liveFetch(); }
}
// Every server response that carries `me` lands here: the UI always re-renders from the server's
// copy (no optimistic updates).
// opts.at: the response's serverTime (snapshots and wheel-duty ticks), opts.soft: a wheel-duty credit.
function applyMe(me, first = false, opts = {}) {
  if (!me) return;
  if (typeof opts.at === "number") { if (opts.at < S.meAt) return; S.meAt = opts.at; }
  const prev = S.me;
  S.me = me;
  S.watching = !!me.watching;
  if (first || !prev) meter.shown = me.watts;
  else if (me.lifetimeWatts > prev.lifetimeWatts) onAccrual(me.lifetimeWatts - prev.lifetimeWatts, !!opts.soft);
  meter.target = me.watts;
  afterMe();
}
// Live wheel reading straight from the public API (CORS is open). Browsers pass its edge checks
// where a hosting provider's IP may not, so this is the primary source outside demo mode.
async function liveFetch() {
  if (!S.loaded || S.demo) return; // demo mode uses the server's fake hamster
  try {
    const r = await fetch(`${S.api}/status`, { headers: { accept: "application/json" } });
    if (!r.ok) throw 0;
    const j = await r.json();
    const m = j.measurement || {};
    S.live = { coreStatus: m.coreStatus || "UNKNOWN", freshness: m.freshness || "unknown", speedMmPerSecond: Number(m.speedMmPerSecond || 0), rpmMilli: Number(m.rpmMilli || 0), observedAt: m.observedAt || null, source: "live" };
  } catch { S.live = null; }
  renderHud();
}
async function post(path, body) {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  } catch { return { ok: false, status: 0, j: { error: "network" } }; }
}
// Heartbeat only while the page is visible: the bonus rewards watching, never running.
async function beat() {
  if (document.visibilityState !== "visible" || !S.me) return;
  const r = await post("/api/heartbeat", {});
  if (r.ok) S.watching = !!r.j.watching;
  renderHud();
}

// ---------- HUD strip ----------
const meter = { shown: 0, target: 0, lastText: "", glowUntil: 0 };
const fmt = (n) => Math.round(n).toLocaleString("en-US");
let cuckooAt = 0; // the cuckoo clock pops its bird for ~2 s after each accrual
// soft: a wheel-duty tick (a watt or two every few seconds): shorter glow, one spark, no cuckoo.
function onAccrual(delta, soft = false) {
  if (!soft) cuckooAt = performance.now();
  meter.glowUntil = performance.now() + (soft ? 900 : 1600);
  $("meter").classList.add("glow");
  const gEl = $("gain");
  gEl.textContent = `+${fmt(delta)}`;
  gEl.classList.remove("show"); void gEl.offsetWidth; gEl.classList.add("show");
  const n = soft ? 1 : Math.min(5, 2 + Math.floor(Math.log10(delta + 1)));
  for (let i = 0; i < n; i++) spawnSpark(i * 90);
}
function renderHud() {
  const st = liveStatus();
  const dot = $("dot");
  dot.className = "dot" + (st.key === "active" ? " on" : st.key === "stale" ? " stale" : st.key === "offline" ? " off" : "");
  const h = st.h;
  $("status").textContent = { active: "ACTIVE", stale: "STALE", offline: "offline", connecting: "connecting…", none: "no reading" }[st.key]
    || (h && h.coreStatus && h.coreStatus !== "IDLE" && h.coreStatus !== "UNKNOWN" ? h.coreStatus.replace(/_/g, " ") : "IDLE");
  $("source").textContent = st.key === "offline" ? "server unreachable" : !h ? " " : S.demo ? "demo hamster" : h.source === "live" ? "live from api.squeekchain.com" : "via room server";
  $("speed").textContent = st.active && st.speed > 0 ? `${(st.speed / 1000).toFixed(2)} m/s` : "—";
  $("block").textContent = S.height != null ? S.height.toLocaleString("en-US") : "—";
  if (S.chain && typeof S.chain.blockProgress === "number") $("prog").style.width = clamp((S.chain.blockProgress / 1e9) * 100, 0, 100).toFixed(1) + "%";
  const me = S.me;
  if (me) {
    $("tier").textContent = `T${me.wheelTier} · ${(me.multPct / 100).toFixed(2)}×`;
    const goal = (S.balance && S.balance.CERT_LIFETIME_WATTS) || 250_000, days = (S.balance && S.balance.CERT_ACTIVE_DAYS) || 7;
    const pct = clamp((me.lifetimeWatts / goal) * 100, 0, 100);
    $("lifeLine").textContent = `lifetime ${fmt(me.lifetimeWatts)} W · ${pct < 10 ? pct.toFixed(1) : Math.floor(pct)}% of ${fmt(goal)} · day ${Math.min(me.activeDays, days)}/${days}`;
    $("lifeProg").style.width = pct.toFixed(2) + "%";
    renderCertHud(me);
    const watching = S.watching || me.watching;
    const bonus = Math.max(me.bonusPct || 0, (S.balance && S.balance.LIVE_BONUS_PCT) || 120) - 100; // me.bonusPct lags the first heartbeat
    $("watchLine").innerHTML = watching ? `watching<span class="chip on">+${bonus}%</span>` : "&nbsp;";
    renderDutyHud(me);
  }
  stepMeter(0); // paints the meter text even when rAF is throttled
  $("demo").hidden = !S.demo;
  const nb = $("night");
  if (S.night) {
    const left = Math.max(0, Math.round((S.night.endsAt - (Date.now() + S.skew)) / 1000));
    $("nightInfo").textContent = `night running · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
    nb.disabled = true;
  } else { $("nightInfo").textContent = ""; nb.disabled = false; }
}
function stepMeter(dt) {
  const d = meter.target - meter.shown;
  if (Math.abs(d) < 0.5) meter.shown = meter.target;
  else meter.shown += d * (1 - Math.exp(-dt / 320)) + Math.sign(d) * Math.min(Math.abs(d), dt * 0.02);
  const txt = S.me ? fmt(meter.shown) : "—";
  if (txt !== meter.lastText) { $("watts").textContent = txt; meter.lastText = txt; }
  if (meter.glowUntil && performance.now() > meter.glowUntil) { meter.glowUntil = 0; $("meter").classList.remove("glow"); }
}
function toast(msg, kind) {
  const box = $("toasts");
  while (box.children.length >= 3) box.firstChild.remove();
  const t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  t.setAttribute("role", kind === "err" ? "alert" : "status");
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// demo controls (shown only when the server says demo)
document.querySelectorAll("#demo [data-adv]").forEach((b) => (b.onclick = async () => {
  const r = await post("/api/dev/advance", { n: Number(b.dataset.adv) });
  if (!r.ok) toast(`advance failed: ${r.j.error || r.status}`);
  refresh();
}));
$("grant").onclick = async () => { const r = await post("/api/dev/grant", { watts: 50_000 }); if (!r.ok) toast(`grant failed: ${r.j.error || r.status}`); refresh(); };
$("night").onclick = async () => {
  const r = await post("/api/dev/night", {});
  if (r.ok) toast(`Night started: ${Math.round(r.j.durationMs / 60000)} min, ${r.j.blocks} blocks in bursts.`);
  else toast(r.j.error === "night_running" ? "A night is already running." : `night failed: ${r.j.error || r.status}`);
  refresh();
};
$("sleep").onclick = async () => {
  const r = await post("/api/dev/sleep", {});
  if (r.ok) toast("The chain has been quiet for 11 minutes. Wheel duty is open.");
  else toast(r.j.error === "night_running" ? "A night is running. Wait for it to end." : `nap failed: ${r.j.error || r.status}`);
  refresh();
};

// ---------- hamster behaviour ----------
// RUN in the wheel while ACTIVE; SLEEP in the burrow on IDLE / stale / unreachable. Switching
// always passes through a short SIT beside the wheel, with hop/walk moves between spots.
const SIT_MS = 1400;
const ham = { init: false, mode: "sleep", x: SPOT.burrow.x, y: SPOT.burrow.y, face: -1, move: null, sitLeft: 0, runPhase: 0, blink: 0, breath: 0 };
function spotFor(mode) { return mode === "run" ? SPOT.wheel : SPOT.burrow; }
function moveTo(name) {
  const to = name === "sit" ? SPOT.sit : spotFor(name);
  const dist = Math.hypot(to.x - ham.x, to.y - ham.y);
  const inWheel = Math.hypot(ham.x - SPOT.wheel.x, ham.y - SPOT.wheel.y) < 1;
  const hop = inWheel || name === "run"; // in/out of the wheel is one big hop
  ham.move = { name, fx: ham.x, fy: ham.y, tx: to.x, ty: to.y, t: 0, dur: hop ? 650 : Math.max(500, (dist / 70) * 1000), hop, steps: Math.max(1, Math.round(dist / 14)) };
  if (to.x !== ham.x) ham.face = to.x < ham.x ? -1 : 1;
  ham.mode = "move";
}
function stepHamster(dt, st) {
  const want = st.active ? "run" : "sleep";
  if (!ham.init && S.loaded) { // first reading: start in place, no transition
    ham.init = true; ham.mode = want; const s = spotFor(want); ham.x = s.x; ham.y = s.y; ham.face = want === "run" ? 1 : -1; ham.move = null;
  }
  if (ham.mode === "move") {
    const m = ham.move;
    m.t = Math.min(m.dur, m.t + dt);
    const k = m.t / m.dur;
    ham.x = lerp(m.fx, m.tx, k);
    ham.y = lerp(m.fy, m.ty, k) - (m.hop ? 14 * Math.sin(Math.PI * k) : 2 * Math.abs(Math.sin(Math.PI * k * m.steps)));
    ham.runPhase += dt / 1000 * 8;
    if (k >= 1) {
      ham.move = null;
      if (m.name === "sit") { ham.mode = "sit"; ham.sitLeft = SIT_MS; ham.face = spotFor(want).x < ham.x ? -1 : 1; }
      else if (m.name === want) { ham.mode = want; ham.face = want === "run" ? 1 : -1; }
      else moveTo("sit");
    }
  } else if (ham.mode === "sit") {
    ham.face = spotFor(want).x < ham.x ? -1 : 1;
    ham.sitLeft -= dt;
    if (ham.sitLeft <= 0) moveTo(want);
  } else if (ham.mode !== want) {
    moveTo("sit");
  } else if (ham.mode === "run") {
    ham.runPhase += (dt / 1000) * (4 + 10 * clamp(st.speed / 1600, 0, 1)); // run-cycle steps per second scale with speed
  }
}

// ---------- wheel ----------
const wheel = { rpm: 0, angle: 0 };
const MAX_VIS_RPM = 160; // keeps 6 spokes under ~16 degrees per frame so the spin never reads backwards
function stepWheel(dt, st) {
  if (ham.mode === "sleep" && (duty.vel > 0 || duty.hold || duty.key)) {
    wheel.rpm = duty.vel * DUTY_MAX_RPM; // he's in the burrow: the player's hand drives the wheel
  } else {
    const target = ham.mode === "run" ? clamp(st.rpm || 30, 20, MAX_VIS_RPM) : 0;
    const tau = target > wheel.rpm ? 450 : 900; // spin up quickly, coast down
    wheel.rpm += (target - wheel.rpm) * (1 - Math.exp(-dt / tau));
    if (wheel.rpm < 0.5 && target === 0) wheel.rpm = 0;
  }
  wheel.angle = (wheel.angle + (wheel.rpm / 60000) * dt) % 1; // revolutions
}

// ---------- wheel duty: the player spins the wheel while he sleeps ----------
// Open only while the room shows him asleep in the burrow AND the server says the chain has been
// quiet for MANUAL_IDLE_AFTER_MS (the server judges that; this page only mirrors it). He sleeps
// through it: nothing here touches the hamster. While the wheel turns above DUTY_MIN_VEL the page
// sends a tick every DUTY_TICK_MS; the server credits the real time between ticks.
const DUTY_MAX_RPM = 60, DUTY_MIN_VEL = 0.3, DUTY_TICK_MS = 5000;
const DUTY_RAMP_TAU = 500, DUTY_COAST_TAU = 550; // ~1.5 s to full speed, ~2 s to coast down
const duty = { hold: false, key: false, vel: 0, spinning: false, tickAt: 0, busy: false, avail: false, hintT: 0 };
const grabEl = $("wheelGrab"), dutyHintEl = $("dutyHint");
const ss = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
const dutyCapLeft = () => (S.me && S.me.manual ? S.me.manual.msCapLeft : 0);
function dutyAvailable(st) {
  return S.loaded && !S.offline && !!S.me && !!S.spin && S.spin.idle === true && !st.active && ham.mode === "sleep"
    && !P.mode && !certOpen() && dutyCapLeft() > 0 && document.visibilityState === "visible";
}
function grabDuty(how) {
  duty[how] = true;
  duty.vel = Math.max(duty.vel, clamp(wheel.rpm / DUTY_MAX_RPM, 0, 1)); // catch a wheel that is still turning
  grabEl.classList.add("on");
  hideDutyHint();
}
function releaseDuty(how) {
  if (how) duty[how] = false; else duty.hold = duty.key = false;
  if (!duty.hold && !duty.key) grabEl.classList.remove("on");
}
function stepDuty(dt, st) {
  const avail = dutyAvailable(st);
  if (avail !== duty.avail) {
    const engaged = duty.hold || duty.key || duty.spinning;
    duty.avail = avail;
    if (!avail) {
      releaseDuty();
      hideDutyHint();
      if (engaged) {
        if (st.active || !(S.spin && S.spin.idle)) toast("Squeektoshi's got it from here.");
        else if (S.me && dutyCapLeft() <= 0) toast("That's all the wheel duty for today. It resets at 00:00 UTC.");
      }
    } else showDutyHint();
    positionWheelGrab();
    renderHud();
  }
  if (avail && (duty.hold || duty.key)) duty.vel += (1 - duty.vel) * (1 - Math.exp(-dt / DUTY_RAMP_TAU));
  else duty.vel *= Math.exp(-dt / DUTY_COAST_TAU);
  if (duty.vel < 0.005) duty.vel = 0;
  const spinning = avail && duty.vel > DUTY_MIN_VEL;
  if (spinning !== duty.spinning) {
    duty.spinning = spinning;
    if (avail) sendSpin(spinning); // a new spin restarts the server's clock; a stop credits the tail
    renderHud();
  } else if (spinning && performance.now() - duty.tickAt >= DUTY_TICK_MS) sendSpin(false);
}
async function sendSpin(restart) {
  if (duty.busy) return;
  duty.busy = true;
  duty.tickAt = performance.now();
  const r = await post("/api/spin", restart ? { restart: true } : {});
  duty.busy = false;
  if (r.ok && r.j.me) applyMe(r.j.me, false, { at: r.j.serverTime, soft: true });
  else if (r.j && r.j.error === "hamster_awake") S.spin = { ...(S.spin || {}), idle: false }; // a block landed: stepDuty closes it
}
// the grab zone sits over the wheel (and its stand) only while wheel duty is open
function positionWheelGrab() {
  grabEl.hidden = !duty.avail;
  const cr = view.getBoundingClientRect(), sr = stage.getBoundingClientRect(), k = cr.width / LW;
  if (!cr.width) return;
  const x0 = WHEEL.cx - WHEEL.r - 2, x1 = WHEEL.cx + WHEEL.r + 2;
  const y0 = Math.max(WHEEL.cy - WHEEL.r - 1, (ROOM.WALL_BOTTOM + 1) * CELL), y1 = FLOOR_Y + 2; // stays clear of wall decor
  const ox = cr.left - sr.left, oy = cr.top - sr.top;
  if (duty.avail) Object.assign(grabEl.style, { left: `${Math.round(ox + x0 * k)}px`, top: `${Math.round(oy + y0 * k)}px`, width: `${Math.round((x1 - x0) * k)}px`, height: `${Math.round((y1 - y0) * k)}px` });
  if (!dutyHintEl.hidden) {
    const tw = dutyHintEl.offsetWidth;
    const left = clamp(ox + WHEEL.cx * k, tw / 2 + 4, Math.max(tw / 2 + 4, sr.width - tw / 2 - 4));
    dutyHintEl.style.left = `${Math.round(left)}px`;
    dutyHintEl.style.top = `${Math.round(oy + y0 * k - 6)}px`;
  }
}
function showDutyHint() { // once per browser session
  if (ss.get("sr_duty_hint")) return;
  ss.set("sr_duty_hint", "1");
  dutyHintEl.hidden = false;
  positionWheelGrab();
  clearTimeout(duty.hintT);
  duty.hintT = setTimeout(hideDutyHint, 9000);
}
function hideDutyHint() { clearTimeout(duty.hintT); dutyHintEl.hidden = true; }
function renderDutyHud(me) {
  const m = me.manual, el = $("duty");
  const show = !!m && (duty.avail || m.msUsedToday > 0);
  el.hidden = !show;
  if (!show) return;
  const used = m.msUsedToday / 60000, cap = m.capMs / 60000;
  $("dutyLine").textContent = `wheel duty ${used < 10 ? used.toFixed(1) : Math.floor(used)}/${cap} min`;
  const rate = $("dutyRate");
  rate.hidden = !duty.spinning;
  rate.textContent = `${+m.wattsPerMin.toFixed(2)} W/min`;
  $("dutyProg").style.width = clamp((m.msUsedToday / m.capMs) * 100, 0, 100).toFixed(2) + "%";
  el.classList.toggle("on", duty.spinning);
}
grabEl.addEventListener("pointerdown", (e) => {
  if ((e.pointerType === "mouse" && e.button !== 0) || !duty.avail) return;
  e.preventDefault();
  try { grabEl.setPointerCapture(e.pointerId); } catch {}
  grabDuty("hold");
});
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) grabEl.addEventListener(ev, () => releaseDuty("hold"));
grabEl.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press on phones
const isSpace = (e) => e.code === "Space" || e.key === " ";
addEventListener("keydown", (e) => {
  if (!isSpace(e) || !duty.avail || certOpen()) return;
  const t = e.target;
  if (t !== grabEl && t && t.closest && t.closest("input,textarea,select,button,a,summary,[contenteditable]")) return;
  e.preventDefault(); // no page scroll while you hold it
  if (!duty.key) grabDuty("key");
});
addEventListener("keyup", (e) => { if (isSpace(e) && duty.key) { e.preventDefault(); releaseDuty("key"); } });
addEventListener("blur", () => releaseDuty());

// ---------- effects: watt sparks + sleep Zs ----------
const sparks = [], zs = [];
let sparkClock = 0, zClock = 0;
function meterTarget() {
  const cr = view.getBoundingClientRect(), mr = $("watts").getBoundingClientRect();
  if (!cr.width) return { x: LW / 2, y: 4 };
  const k = cr.width / LW;
  return { x: clamp((mr.left + mr.width / 2 - cr.left) / k, 6, LW - 6), y: clamp((mr.top + mr.height / 2 - cr.top) / k, 4, LH) };
}
function spawnSpark(delay = 0) {
  const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
  const x0 = WHEEL.cx + Math.cos(a) * WHEEL.r, y0 = WHEEL.cy + Math.sin(a) * WHEEL.r;
  const tg = meterTarget();
  sparks.push({ x0, y0, cx: x0 + (Math.random() - 0.5) * 50, cy: Math.min(y0, tg.y) - 10 - Math.random() * 30, x1: tg.x + (Math.random() - 0.5) * 10, y1: tg.y, t: -delay, life: 1100 + Math.random() * 600, pop: 0, px: x0, py: y0 });
}
function stepFx(dt, st) {
  if (st.active && ham.mode === "run") {
    sparkClock -= dt;
    if (sparkClock <= 0) { spawnSpark(); sparkClock = 650 - 300 * clamp(st.speed / 1600, 0, 1) + Math.random() * 250; }
  } else if (duty.spinning) { // wheel duty: a slow drip of sparks
    sparkClock -= dt;
    if (sparkClock <= 0) { spawnSpark(); sparkClock = 1600 + Math.random() * 900; }
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.t += dt;
    if (s.t < 0) continue;
    if (s.pop) { s.pop += dt; if (s.pop > 260) sparks.splice(i, 1); continue; }
    const k = Math.min(1, s.t / s.life), e = k * k * (3 - 2 * k);
    s.px = s.x; s.py = s.y;
    s.x = (1 - e) * (1 - e) * s.x0 + 2 * (1 - e) * e * s.cx + e * e * s.x1;
    s.y = (1 - e) * (1 - e) * s.y0 + 2 * (1 - e) * e * s.cy + e * e * s.y1;
    if (k >= 1) s.pop = 1;
  }
  if (ham.mode === "sleep") {
    zClock -= dt;
    if (zClock <= 0) { zs.push({ x: BURROW.cx + 6, y: FLOOR_Y - 20, t: 0, life: 2600 }); zClock = 1900; }
  } else zClock = 400;
  for (let i = zs.length - 1; i >= 0; i--) { zs[i].t += dt; if (zs[i].t > zs[i].life) zs.splice(i, 1); }
}

// 10 fps logical sprite frames: blinks, breathing, animated-item markers
let frame10 = 0;
function tick10() {
  frame10++;
  if (ham.blink > 0) ham.blink--;
  else if (ham.mode === "sit" && Math.random() < 0.05) ham.blink = 2;
  ham.breath = Math.floor(frame10 / 12) % 2; // slow 2-phase breathing
  tickThumbs();
}

// ---------- day / night tint (real UTC hour) ----------
// [hour, multiply rgb, haze rgba]: warm midday, amber dusk, deep blue 00-08 UTC.
const TINT = [
  [0, [84, 98, 176], [18, 28, 90, 0.12]],
  [7.6, [84, 98, 176], [18, 28, 90, 0.12]],
  [9, [255, 226, 206], [255, 180, 120, 0.06]],
  [12, [255, 250, 238], [255, 230, 170, 0.05]],
  [16, [255, 243, 222], [255, 210, 140, 0.06]],
  [18.5, [255, 192, 136], [255, 140, 50, 0.12]],
  [20.5, [158, 128, 188], [90, 60, 140, 0.12]],
  [22.5, [96, 106, 180], [20, 30, 90, 0.12]],
  [24, [84, 98, 176], [18, 28, 90, 0.12]],
];
function tintAt(hour) {
  let i = 0;
  while (i < TINT.length - 2 && hour >= TINT[i + 1][0]) i++;
  const [h0, m0, z0] = TINT[i], [h1, m1, z1] = TINT[i + 1];
  const k = h1 > h0 ? clamp((hour - h0) / (h1 - h0), 0, 1) : 0;
  return { mul: m0.map((v, j) => Math.round(lerp(v, m1[j], k))), haze: z0.map((v, j) => (j < 3 ? Math.round(lerp(v, z1[j], k)) : lerp(v, z1[j], k))) };
}
function utcHour() {
  if (UTC_OVERRIDE != null && Number.isFinite(UTC_OVERRIDE)) return ((UTC_OVERRIDE % 24) + 24) % 24;
  const d = new Date(Date.now() + S.skew);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

// ---------- renderer ----------
const view = $("room"), vctx = view.getContext("2d");
const buf = canvas(LW, LH), g = buf.getContext("2d");
const stage = $("stage");
let dimLevel = 0; // eased 0..1 IDLE dimming
function fit() {
  const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, pad = 12;
  const s = Math.max(1, Math.floor(Math.min(((r.width - pad * 2) * dpr) / LW, ((r.height - pad * 2) * dpr) / LH)));
  if (view.width !== LW * s) { view.width = LW * s; view.height = LH * s; }
  view.style.width = (LW * s) / dpr + "px";
  view.style.height = (LH * s) / dpr + "px";
}
new ResizeObserver(() => { fit(); positionTool(); positionWheelGrab(); }).observe(stage);
addEventListener("resize", () => { fit(); positionTool(); positionWheelGrab(); });
(function watchDpr() { const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`); mq.addEventListener("change", () => { fit(); watchDpr(); }, { once: true }); })();

function itemsIn(zone) {
  const out = [];
  for (const p of (S.me && S.me.placed) || []) {
    if (P.mode === "move" && p.pid === P.pid) continue; // the ghost stands in for it while moving
    const it = S.catalog.get(p.item);
    if (it && it.zone === zone) out.push([p, it]);
  }
  return out;
}
// Live inputs for function sprites (clock hands, window sky, TV broadcast, cuckoo), refreshed each frame.
let FX = { t: 0, now: Date.now(), utcHour: 12, live: { key: "connecting", active: false, speed: 0, rpm: 0 }, cuckooAge: Infinity };
function fxOpts(st) {
  const t = performance.now();
  FX = { t, now: Date.now() + S.skew, utcHour: utcHour(), live: { key: st.key, active: st.active, speed: st.speed, rpm: st.rpm }, cuckooAge: cuckooAt ? t - cuckooAt : Infinity };
  return FX;
}
// fx / fr default to the live values; the certificate passes frozen ones (see renderPortrait).
function drawItem(p, it, x, y, pw, ph, c = g, fx = FX, fr = frame10) {
  const opts = { ...fx, flip: !!p.flip, w: pw, h: ph };
  if (!sprite(c, it.sprite, fr, x, y, opts)) {
    c.drawImage(placeholderItem(it, pw, ph), x, y);
    if (it.animated && fr % 10 < 5) { c.fillStyle = "#22c55e"; c.fillRect(x + pw - 4, y + 2, 2, 2); } // "this one moves" marker
  }
}
function drawRug(p, it, x, c = g, fx = FX, fr = frame10) {
  const pw = it.w * CELL;
  if (!sprite(c, it.sprite, fr, x, FLOOR_Y, { ...fx, flip: !!p.flip, w: pw, h: 16 })) c.drawImage(placeholderItem(it, pw, 12), x, FLOOR_Y + 2);
}
function render(st) {
  const me = S.me;
  fxOpts(st);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  // 1. wallpaper (+ fixed trim)
  g.drawImage(wallpaperCanvas((me && me.wallpaper) || "wp_plain"), 0, 0);
  // 2. wall decor (top-left cell)
  for (const [p, it] of itemsIn("wall").sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x)) {
    drawItem(p, it, p.x * CELL, p.y * CELL, it.w * CELL, it.h * CELL);
  }
  // 3. flooring band
  g.drawImage(floorCanvas((me && me.floor) || "fl_pine"), 0, FLOOR_Y);
  // 4. rugs (flat on the floor band)
  for (const [p, it] of itemsIn("rug").sort((a, b) => a[0].x - b[0].x)) drawRug(p, it, p.x * CELL);
  // 5. floor furniture, left to right, bottoms on the floor line
  for (const [p, it] of itemsIn("floor").sort((a, b) => a[0].x - b[0].x)) {
    const pw = it.w * CELL, ph = it.h * CELL, x = p.x * CELL, y = FLOOR_Y - ph;
    g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(x + 1, FLOOR_Y, pw - 2, 2);
    drawItem(p, it, x, y, pw, ph);
  }
  // 6. burrow
  if (!sprite(g, "burrow", frame10, BURROW.x, BURROW.y, {})) g.drawImage(burrowCanvas(), BURROW.x, BURROW.y);
  // 7. wheel (+ tier hub overlay)
  const tier = (me && me.wheelTier) | 0;
  g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(WHEEL.cx - 19, FLOOR_Y, 38, 2);
  if (sprite(g, "wheel", Math.floor(wheel.angle * 24) % 4, WHEEL.x, WHEEL.y, { angle: wheel.angle, tier })) {
    if (tier > 0) sprite(g, `wheel_t${tier}`, frame10, WHEEL.x, WHEEL.y, { angle: wheel.angle, tier });
  } else drawWheelPlaceholder(g, wheel.angle, tier);
  // 8. hamster
  drawHamster(st);
  // 9. watt sparks + sleep Zs
  drawFx();
  // 10. day/night tint, IDLE dim + burrow glow
  const t = tintAt(utcHour());
  g.globalCompositeOperation = "multiply";
  g.fillStyle = `rgb(${t.mul.join(",")})`; g.fillRect(0, 0, LW, LH);
  if (dimLevel > 0.01) { const v = Math.round(255 - 46 * dimLevel); g.fillStyle = `rgb(${v},${v},${Math.round(255 - 30 * dimLevel)})`; g.fillRect(0, 0, LW, LH); }
  g.globalCompositeOperation = "source-over";
  g.fillStyle = `rgba(${t.haze[0]},${t.haze[1]},${t.haze[2]},${t.haze[3].toFixed(3)})`; g.fillRect(0, 0, LW, LH);
  if (dimLevel > 0.01) {
    g.globalCompositeOperation = "lighter";
    const breathe = 0.85 + 0.15 * Math.sin(performance.now() / 900);
    const grd = g.createRadialGradient(BURROW.cx, FLOOR_Y - 8, 2, BURROW.cx, FLOOR_Y - 8, 46);
    grd.addColorStop(0, `rgba(255,170,70,${(0.32 * dimLevel * breathe).toFixed(3)})`);
    grd.addColorStop(1, "rgba(255,170,70,0)");
    g.fillStyle = grd; g.fillRect(BURROW.cx - 50, FLOOR_Y - 56, 100, LH - FLOOR_Y + 56);
    g.globalCompositeOperation = "source-over";
  }
  // 11. placement ghost, zone guides, selection outline (after the tint so they read at night)
  drawPlacement();
  // present: integer-scaled, no smoothing
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(buf, 0, 0, view.width, view.height);
}
function drawHamster() {
  const skin = (S.me && S.me.skin) || "skin_classic";
  let kind = "sit", frame = 0, x = ham.x, y = ham.y;
  if (ham.mode === "run") { kind = "run"; frame = Math.floor(ham.runPhase) % 4; y -= frame % 2 ? 1 : 0; }
  else if (ham.mode === "move") { kind = ham.move && ham.move.hop ? "sit" : "run"; frame = Math.floor(ham.runPhase) % 4; }
  else if (ham.mode === "sleep") { kind = "sleep"; frame = ham.breath; }
  else if (ham.blink > 0) kind = "blink";
  const id = kind === "run" ? "hamster_run" : kind === "sleep" ? "hamster_sleep" : kind === "blink" ? "hamster_blink" : "hamster_sit";
  const dx = Math.round(x - 12), dy = Math.round(y - 24), flip = ham.face < 0;
  const opts = { flip, skin, remap: (window.SKIN_REMAPS || {})[skin] };
  if (sprite(g, id, frame, dx, dy, opts)) return;
  const img = hamsterFrame(kind, frame, skin);
  if (flip) { g.save(); g.translate(dx + 24, dy); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore(); }
  else g.drawImage(img, dx, dy);
}
function drawFx() {
  for (const s of sparks) {
    if (s.t < 0) continue;
    const x = Math.round(s.x), y = Math.round(s.y);
    if (s.pop) {
      const r = s.pop < 90 ? 1 : 2, a = 1 - s.pop / 260;
      g.fillStyle = `rgba(255,248,208,${a.toFixed(2)})`;
      g.fillRect(x - r, y, 1, 1); g.fillRect(x + r, y, 1, 1); g.fillRect(x, y - r, 1, 1); g.fillRect(x, y + r, 1, 1);
      continue;
    }
    g.fillStyle = "rgba(245,166,35,.55)"; g.fillRect(Math.round(s.px), Math.round(s.py), 1, 1);
    g.fillStyle = "#ffd166"; g.fillRect(x, y, 1, 1);
  }
  for (const z of zs) {
    const k = z.t / z.life;
    g.globalAlpha = clamp(Math.min(k * 4, (1 - k) * 2), 0, 1) * 0.8;
    drawText(g, "Z", Math.round(z.x + k * 10 + Math.sin(k * 6) * 2), Math.round(z.y - k * 26), "#ffffff");
    g.globalAlpha = 1;
  }
}

// ---------- main loop: one rAF, fixed steps (60 fps easing/fx, 10 fps sprite frames) ----------
const STEP = 1000 / 60, STEP10 = 100;
let last = performance.now(), acc = 0, acc10 = 0, hudClock = 0;
function step(dt) {
  const st = liveStatus();
  stepHamster(dt, st);
  stepDuty(dt, st);
  stepWheel(dt, st);
  stepFx(dt, st);
  stepMeter(dt);
  dimLevel += ((st.active || !S.loaded ? 0 : 1) - dimLevel) * (1 - Math.exp(-dt / 1200));
  hudClock += dt;
  if (hudClock > 1000) { hudClock = 0; renderHud(); } // keeps the night countdown and staleness fresh
  return st;
}
function loop(now) {
  let dt = now - last;
  last = now;
  if (dt > 1000) dt = 1000; // tab was hidden: don't fast-forward minutes of animation (but keep time under 1 fps throttling)
  acc += dt;
  let st = null;
  while (acc >= STEP) {
    st = step(STEP);
    acc -= STEP;
    acc10 += STEP;
    while (acc10 >= STEP10) { acc10 -= STEP10; tick10(); }
  }
  render(st || liveStatus());
  requestAnimationFrame(loop);
}

// ---------- placement: client mirror of the server rules ----------
const span = (ax, aw, bx, bw) => ax < bx + bw && bx < ax + aw;
const findPlaced = (pid) => (pid && S.me && S.me.placed.find((p) => p.pid === pid)) || null;
const unplaced = (id) => (S.me ? (S.me.owned[id] || 0) - S.me.placed.filter((p) => p.item === id).length : 0);
function reservedCols() {
  const m = new Map();
  for (const [name, [a, b]] of Object.entries(ROOM.RESERVED || {})) for (let c = a; c <= b; c++) m.set(c, name);
  return m;
}
// Footprint in logical pixels. Wall: (x, y) is the top-left cell. Floor: stands on the floor line.
// Rug: the floor band under the line.
function footprint(it, x, y) {
  if (it.zone === "wall") return { x: x * CELL, y: y * CELL, w: it.w * CELL, h: it.h * CELL };
  if (it.zone === "rug") return { x: x * CELL, y: FLOOR_Y, w: it.w * CELL, h: LH - FLOOR_Y };
  return { x: x * CELL, y: FLOOR_Y - it.h * CELL, w: it.w * CELL, h: it.h * CELL };
}
// Same checks, same order as server.js validatePlacement(); the server re-validates every move.
function checkSpot(it, x, y, ignorePid = null) {
  const me = S.me;
  if (!it || !it.zone) return { ok: false, error: "not_placeable" };
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, error: "bad_coords" };
  const others = ((me && me.placed) || []).filter((p) => p.pid !== ignorePid);
  if (others.filter((p) => p.item === it.id).length >= ((me && me.owned[it.id]) || 0)) return { ok: false, error: "unowned" };
  if (x < 0 || x + it.w > ROOM.COLS || y < 0 || y >= ROOM.ROWS) return { ok: false, error: "out_of_bounds" };
  if (it.zone === "wall") {
    if (y < ROOM.WALL_TOP || y + it.h - 1 > ROOM.WALL_BOTTOM) return { ok: false, error: "out_of_bounds" };
    for (const o of others) {
      const oi = S.catalog.get(o.item);
      if (oi && oi.zone === "wall" && span(x, it.w, o.x, oi.w) && span(y, it.h, o.y, oi.h)) return { ok: false, error: "overlap", with: oi };
    }
    return { ok: true };
  }
  const res = reservedCols();
  for (let c = x; c < x + it.w; c++) if (res.has(c)) return { ok: false, error: "reserved", which: res.get(c) };
  for (const o of others) {
    const oi = S.catalog.get(o.item);
    if (oi && oi.zone === it.zone && span(x, it.w, o.x, oi.w)) return { ok: false, error: "overlap", with: oi };
  }
  return { ok: true };
}
function whichReserved(it, x) {
  if (!it || x == null) return "wheel";
  const res = reservedCols();
  for (let c = x; c < x + it.w; c++) if (res.has(c)) return res.get(c);
  return "wheel";
}
// Server error codes in words.
function errorWords(j, ctx = {}) {
  const e = (j && j.error) || "network";
  switch (e) {
    case "poor": return `Need ${fmt(j.need || 0)} more watts`;
    case "wrong_tier": return ctx.it && ctx.it.tier ? `Install the T${ctx.it.tier - 1} wheel upgrade first` : "Wheel upgrades go in order";
    case "already_owned": return ctx.it && ctx.it.cat === "wheel" ? "Your wheel already has that" : "You already own that";
    case "reserved": return (ctx.which || whichReserved(ctx.it, ctx.x)) === "burrow" ? "That's the burrow. Squeektoshi sleeps there" : "That spot is the wheel's";
    case "overlap": return ctx.with ? `The ${ctx.with.name} is already there` : "Something is already there";
    case "out_of_bounds": case "oob": return ctx.it && ctx.it.zone === "wall" ? "Wall decor has to hang on the wall" : "That doesn't fit there";
    case "unowned": return "None left to place. Buy another in the shop";
    case "bad_coords": return "Pick a spot inside the room";
    case "unknown_pid": return "That was already moved or removed";
    case "unknown_item": case "not_placeable": return "That isn't in the shop";
    case "bad_token": case "unknown_player": return "Your room hasn't loaded yet. Try again in a moment";
    case "network": return "Can't reach the room server";
    default: return `Something went wrong (${e})`;
  }
}

// ---------- placement UI ----------
// mode "place": a ghost of an inventory item; "move": a placed item picked up (toolbar Move or drag).
const P = { mode: null, it: null, pid: null, flip: false, cell: null, valid: null, busy: false, drag: null, from: null, down: false, flashUntil: 0 };
let selPid = null, press = null;
const coarse = matchMedia("(pointer: coarse)");
function logical(e) {
  const r = view.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * LW, y: ((e.clientY - r.top) / r.height) * LH, inside: e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom };
}
const wallYRange = (it) => [ROOM.WALL_TOP, ROOM.WALL_BOTTOM - it.h + 1];
function cellAt(it, L) { // the ghost is centred on the pointer and clamped into its zone
  const x = clamp(Math.round(L.x / CELL - it.w / 2), 0, ROOM.COLS - it.w);
  if (it.zone !== "wall") return { x, y: ROOM.FLOOR_ROW };
  const [y0, y1] = wallYRange(it);
  return { x, y: clamp(Math.round(L.y / CELL - it.h / 2), y0, y1) };
}
function dragCell(L) { // dragging keeps the grab offset: the item moves by whole cells
  const d = P.drag, it = P.it;
  const x = clamp(d.x0 + Math.round((L.x - d.lx) / CELL), 0, ROOM.COLS - it.w);
  if (it.zone !== "wall") return { x, y: ROOM.FLOOR_ROW };
  const [y0, y1] = wallYRange(it);
  return { x, y: clamp(d.y0 + Math.round((L.y - d.ly) / CELL), y0, y1) };
}
function updateGhost(L) {
  if (!P.mode) return;
  if (!L.inside && !P.drag) { if (P.cell) { P.cell = null; P.valid = null; renderPlacing(); } return; }
  const c = P.drag ? dragCell(L) : cellAt(P.it, L);
  if (P.cell && c.x === P.cell.x && c.y === P.cell.y) return;
  P.cell = c;
  P.valid = checkSpot(P.it, c.x, c.y, P.mode === "move" ? P.pid : null);
  renderPlacing();
}
function hitTest(L) {
  if (!S.me) return null;
  const order = { floor: 0, rug: 1, wall: 2 }; // topmost layer first
  const list = S.me.placed.map((p) => [p, S.catalog.get(p.item)]).filter(([, it]) => it && it.zone).sort((a, b) => order[a[1].zone] - order[b[1].zone]);
  for (const [p, it] of list) {
    const f = footprint(it, p.x, p.y);
    if (L.x >= f.x && L.x < f.x + f.w && L.y >= f.y && L.y < f.y + f.h) return p;
  }
  return null;
}
function enterPlace(itemId) {
  const it = S.catalog.get(itemId);
  if (!it || !it.zone || unplaced(itemId) <= 0) return;
  selPid = null;
  Object.assign(P, { mode: "place", it, pid: null, flip: false, cell: null, valid: null, drag: null, from: null, down: false });
  afterMode();
  if (matchMedia("(max-width:860px)").matches) stage.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function enterMove(pid, drag = null) {
  const p = findPlaced(pid), it = p && S.catalog.get(p.item);
  if (!it) return;
  selPid = pid;
  Object.assign(P, { mode: "move", it, pid, flip: !!p.flip, cell: { x: p.x, y: p.y }, valid: { ok: true }, drag, from: { x: p.x, y: p.y, flip: !!p.flip }, down: false });
  afterMode();
}
function cancelMode() {
  if (!P.mode) return;
  Object.assign(P, { mode: null, it: null, pid: null, cell: null, valid: null, drag: null, from: null, down: false });
  afterMode();
}
function afterMode() { renderPlacing(); renderInventory(); renderFirstHint(); positionTool(); }
async function commit() {
  if (!P.mode || !P.cell || P.busy) return;
  const { it, cell, mode, pid } = P, valid = P.valid || {};
  if (mode === "move" && P.from && cell.x === P.from.x && cell.y === P.from.y && P.flip === P.from.flip) { cancelMode(); return; } // dropped where it was
  P.busy = true;
  const r = mode === "place"
    ? await post("/api/place", { itemId: it.id, x: cell.x, y: cell.y, flip: P.flip })
    : await post("/api/move", { pid, x: cell.x, y: cell.y, flip: P.flip });
  P.busy = false;
  if (r.ok && r.j.me) {
    ls.set("sr_placed_once", "1");
    Object.assign(P, { mode: null, it: null, pid: null, cell: null, valid: null, drag: null, from: null });
    selPid = (r.j.placed && r.j.placed.pid) || pid;
    applyMe(r.j.me);
    afterMode();
    return;
  }
  toast(errorWords(r.j, { it, x: cell.x, which: valid.which, with: valid.with }), "err");
  P.flashUntil = performance.now() + 450;
  if (P.drag || r.j.error === "unknown_pid" || r.j.error === "unowned") { cancelMode(); refresh(); } // a refused drag snaps home
  renderPlacing();
}
function select(pid) { selPid = findPlaced(pid) ? pid : null; renderPlacing(); positionTool(); }
async function flipPlaced(p) {
  if (!p) return;
  const r = await post("/api/move", { pid: p.pid, x: p.x, y: p.y, flip: !p.flip });
  if (r.ok && r.j.me) applyMe(r.j.me); else toast(errorWords(r.j, { it: S.catalog.get(p.item) }), "err");
}
async function removePlaced(p) {
  if (!p) return;
  const it = S.catalog.get(p.item);
  const r = await post("/api/remove", { pid: p.pid });
  if (r.ok && r.j.me) { selPid = null; applyMe(r.j.me); toast(`${it ? it.name : "It"} is back in your things`); }
  else toast(errorWords(r.j, { it }), "err");
}
// floating toolbar above the selected item
function positionTool() {
  const el = $("itemTool");
  const p = selPid && !P.mode ? findPlaced(selPid) : null, it = p && S.catalog.get(p.item);
  if (!it) { el.hidden = true; return; }
  $("toolName").textContent = it.name;
  el.hidden = false;
  const f = footprint(it, p.x, p.y), cr = view.getBoundingClientRect(), sr = stage.getBoundingClientRect(), k = cr.width / LW;
  const tw = el.offsetWidth, th = el.offsetHeight;
  let left = cr.left - sr.left + (f.x + f.w / 2) * k, top = cr.top - sr.top + f.y * k - 6;
  if (top - th < 4) top = cr.top - sr.top + (f.y + f.h) * k + th + 6; // no room above: hang it below
  left = clamp(left, tw / 2 + 4, Math.max(tw / 2 + 4, sr.width - tw / 2 - 4));
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
}
$("itemTool").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const p = findPlaced(selPid);
  if (!p || b.dataset.act === "close") return select(null);
  if (b.dataset.act === "move") enterMove(p.pid);
  else if (b.dataset.act === "flip") flipPlaced(p);
  else if (b.dataset.act === "remove") removePlaced(p);
});
$("pFlip").onclick = () => { if (P.mode) { P.flip = !P.flip; renderPlacing(); } };
$("pCancel").onclick = () => cancelMode();
function renderPlacing() {
  const on = !!P.mode;
  $("placing").hidden = !on;
  $("invHead").hidden = on;
  view.classList.toggle("placing", on);
  view.style.touchAction = on || selPid ? "none" : "pan-y"; // touch scrolling is locked only while something is in hand
  if (!on) return;
  $("placingName").textContent = `${P.mode === "move" ? "Moving" : "Placing"} ${P.it.name}${P.flip ? " (flipped)" : ""}`;
  const why = $("placingWhy");
  if (!P.cell) { why.textContent = coarse.matches ? "· tap a spot in the room" : "· click a spot in the room · F flips · Esc cancels"; why.className = ""; }
  else if (P.valid && P.valid.ok) { why.textContent = coarse.matches ? "· tap to put it here" : "· click to put it here"; why.className = ""; }
  else { why.textContent = "· " + errorWords(P.valid || {}, { it: P.it, x: P.cell.x, which: P.valid && P.valid.which, with: P.valid && P.valid.with }); why.className = "bad"; }
}

// pointer handling (pattern from squeekplace: pointer events + capture, tap vs drag by distance)
view.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const L = logical(e);
  try { view.setPointerCapture(e.pointerId); } catch {}
  if (P.mode) { P.down = true; updateGhost(L); return; }
  const hit = hitTest(L);
  if (hit) { select(hit.pid); press = { pid: hit.pid, cx: e.clientX, cy: e.clientY, L }; }
  else select(null);
});
view.addEventListener("pointermove", (e) => {
  const L = logical(e);
  if (press && !P.mode && Math.hypot(e.clientX - press.cx, e.clientY - press.cy) > 6) {
    const p = findPlaced(press.pid);
    if (p) enterMove(p.pid, { x0: p.x, y0: p.y, lx: press.L.x, ly: press.L.y });
    press = null;
  }
  if (P.mode) { if (e.pointerType === "mouse" || P.down || P.drag) updateGhost(L); }
  else view.classList.toggle("grab", !!hitTest(L));
});
view.addEventListener("pointerup", (e) => {
  if (P.mode && (P.down || P.drag)) { updateGhost(logical(e)); P.down = false; commit(); }
  press = null;
});
view.addEventListener("pointercancel", () => { press = null; P.down = false; if (P.drag) cancelMode(); });
view.addEventListener("pointerleave", (e) => { if (P.mode && e.pointerType === "mouse" && !P.drag && P.cell) { P.cell = null; P.valid = null; renderPlacing(); } });
view.addEventListener("contextmenu", (e) => { if (P.mode || selPid) { e.preventDefault(); if (P.mode) cancelMode(); else select(null); } });
addEventListener("keydown", (e) => {
  if (certOpen()) { certKey(e); return; } // the certificate is modal: room shortcuts stay off
  if (e.target && e.target.closest && e.target.closest("input,textarea,select")) return;
  if (e.key === "Escape") { if (P.mode) cancelMode(); else select(null); }
  else if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (P.mode) { P.flip = !P.flip; renderPlacing(); } else if (selPid) flipPlaced(findPlaced(selPid));
  } else if ((e.key === "Delete" || e.key === "Backspace") && selPid && !P.mode) { e.preventDefault(); removePlaced(findPlaced(selPid)); }
});

// in-canvas overlay: zone guides, reserved columns, ghost, selection
function frameRect(x, y, w, h) { g.fillRect(x, y, w, 1); g.fillRect(x, y + h - 1, w, 1); g.fillRect(x, y, 1, h); g.fillRect(x + w - 1, y, 1, h); }
function ring(f, col) { // dark outer + bright inner: readable on cream walls and on the night sky
  g.fillStyle = "rgba(12,10,8,.9)"; frameRect(f.x - 1, f.y - 1, f.w + 2, f.h + 2);
  g.fillStyle = col; frameRect(f.x, f.y, f.w, f.h);
}
function ants(x, y, w, h, t) { // marching ants, black/white dashes
  const off = Math.floor(t / 120);
  let i = 0;
  const dot = (px, py) => { g.fillStyle = ((i++ + off) >> 1) % 2 ? "#ffffff" : "#111111"; g.fillRect(px, py, 1, 1); };
  for (let px = x; px < x + w; px++) dot(px, y);
  for (let py = y + 1; py < y + h; py++) dot(x + w - 1, py);
  for (let px = x + w - 2; px >= x; px--) dot(px, y + h - 1);
  for (let py = y + h - 2; py > y; py--) dot(x, py);
}
function drawPlacement() {
  const now = performance.now();
  if (P.mode && P.it) {
    const it = P.it;
    // cell-corner dots over the zone (light + dark pixel pair so they show on any wallpaper)
    const dots = (x, y) => { g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect(x, y, 1, 1); g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(x + 1, y, 1, 1); };
    if (it.zone === "wall") { for (let r = ROOM.WALL_TOP; r <= ROOM.WALL_BOTTOM + 1; r++) for (let c = 0; c <= ROOM.COLS; c++) dots(c * CELL, r * CELL); }
    else for (let c = 0; c <= ROOM.COLS; c++) dots(c * CELL, FLOOR_Y + 1);
    if (it.zone !== "wall") { // reserved wheel + burrow columns: hatched red on the floor band
      for (const [a, b] of Object.values(ROOM.RESERVED || {})) {
        const x0 = a * CELL, x1 = (b + 1) * CELL;
        g.fillStyle = "rgba(239,68,68,.22)"; g.fillRect(x0, FLOOR_Y, x1 - x0, LH - FLOOR_Y);
        g.fillStyle = "rgba(239,68,68,.55)";
        for (let k = x0 - (LH - FLOOR_Y); k < x1; k += 4) for (let d = 0; d < LH - FLOOR_Y; d++) { const px = k + d; if (px >= x0 && px < x1) g.fillRect(px, LH - 1 - d, 1, 1); }
        g.fillStyle = "rgba(239,68,68,.9)"; g.fillRect(x0, FLOOR_Y, x1 - x0, 1);
      }
    }
    if (P.cell) {
      const f = footprint(it, P.cell.x, P.cell.y), ok = !!(P.valid && P.valid.ok) && P.flashUntil < now;
      g.globalAlpha = 0.8;
      if (it.zone === "rug") drawRug({ flip: P.flip }, it, f.x); else drawItem({ flip: P.flip }, it, f.x, f.y, f.w, f.h);
      g.globalAlpha = 1;
      g.fillStyle = ok ? "rgba(34,197,94,.18)" : "rgba(239,68,68,.32)"; g.fillRect(f.x, f.y, f.w, f.h);
      ring(f, ok ? "#4ade80" : "#f87171");
      if (it.zone === "floor") { g.fillStyle = ok ? "#4ade80" : "#f87171"; g.fillRect(f.x, FLOOR_Y + 1, f.w, 2); } // which floor columns it takes
    }
  }
  if (selPid && !P.mode) {
    const p = findPlaced(selPid), it = p && S.catalog.get(p.item);
    if (it) { const f = footprint(it, p.x, p.y); ants(f.x - 1, f.y - 1, f.w + 2, f.h + 2, now); }
  }
}

// ---------- thumbnails (drawn live from the sprite registry) ----------
const thumbBuf = canvas(64, 64), tg = thumbBuf.getContext("2d");
function thumbPaint(it) {
  if (it.cat === "wheel") return [48, 50, () => {
    if (sprite(tg, "wheel", 0, 0, 0, { angle: 0, tier: it.tier })) sprite(tg, it.sprite, 0, 0, 0, { angle: 0, tier: it.tier });
    else tg.drawImage(placeholderItem(it, 48, 48), 0, 1);
  }];
  if (it.cat === "wallpaper" || it.cat === "floor") return [32, 32, () => {
    if (hasSprite(it.sprite)) { for (let y = 0; y < 32; y += 16) for (let x = 0; x < 32; x += 16) sprite(tg, it.sprite, 0, x, y, {}); }
    else tg.drawImage(it.cat === "floor" ? floorCanvas(it.id) : wallpaperCanvas(it.id), 0, 0, 32, 32, 0, 0, 32, 32);
  }];
  if (it.cat === "skin") return [24, 24, () => { // skin_* sprites are the sitting hamster with the skin's palette remap
    if (!sprite(tg, it.sprite, 0, 0, 0, { skin: it.id, remap: (window.SKIN_REMAPS || {})[it.id] })) tg.drawImage(hamsterFrame("sit", 0, it.id), 0, 0);
  }];
  const pw = it.w * CELL, ph = it.zone === "rug" ? 16 : it.h * CELL;
  if (it.zone === "rug") return [pw, ph, () => { if (!sprite(tg, it.sprite, frame10, 0, 0, { ...FX, w: pw, h: 16 })) tg.drawImage(placeholderItem(it, pw, 12), 0, 2); }];
  return [pw, ph, () => drawItem({ flip: false }, it, 0, 0, pw, ph, tg)];
}
function drawThumb(cv, it) {
  const [bw, bh, paint] = thumbPaint(it);
  tg.clearRect(0, 0, 64, 64);
  try { paint(); } catch (e) { console.warn("thumb", it.id, e); }
  const c = cv.getContext("2d"), W = cv.width, H = cv.height;
  const fitS = Math.min(W / bw, H / bh), s = fitS >= 1 ? Math.floor(fitS) : fitS;
  const dw = Math.round(bw * s), dh = Math.round(bh * s);
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, W, H);
  c.drawImage(thumbBuf, 0, 0, bw, bh, Math.floor((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh);
}
const isAnimatedThumb = (it) => !!it.zone && (it.animated || typeof (window.SPRITES || {})[it.sprite] === "function");
function tickThumbs() {
  if (document.hidden) return;
  for (const c of shopCards.values()) if (isAnimatedThumb(c.it)) drawThumb(c.thumb, c.it);
  for (const ch of invChips) if (isAnimatedThumb(ch.it)) drawThumb(ch.cv, ch.it);
}

// ---------- shop ----------
const TABS = [
  { id: "wheel", label: "Wheel", cats: ["wheel"] },
  { id: "decor", label: "Decor", cats: ["furniture", "wall"] },
  { id: "rugs", label: "Rugs", cats: ["rug"] },
  { id: "styles", label: "Walls & Floors", cats: ["wallpaper", "floor"] },
  { id: "skins", label: "Skins", cats: ["skin"] },
];
const SUBHEAD = { furniture: "Floor", wall: "Wall", wallpaper: "Wallpaper", floor: "Flooring" };
let shopTab = ls.get("sr_tab");
if (!TABS.some((t) => t.id === shopTab)) shopTab = "decor";
const shopCards = new Map(); // itemId -> { el, it, thumb, btn, price, own, note, state, busy, ticking }
let builtTab = null, builtSize = -1;
function buildTabs() {
  const box = $("tabs");
  box.innerHTML = "";
  for (const t of TABS) {
    const b = document.createElement("button");
    b.textContent = t.label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t.id === shopTab));
    b.onclick = () => { shopTab = t.id; ls.set("sr_tab", t.id); buildTabs(); buildCards(); b.scrollIntoView({ block: "nearest", inline: "nearest" }); };
    box.appendChild(b);
  }
}
function buildCards() {
  const box = $("cards"), tab = TABS.find((t) => t.id === shopTab);
  box.innerHTML = "";
  shopCards.clear();
  builtTab = shopTab;
  builtSize = S.catalog.size;
  if (!S.catalog.size) { box.innerHTML = "<p>Opening the shop…</p>"; return; }
  for (const cat of tab.cats) {
    const items = [...S.catalog.values()].filter((i) => i.cat === cat);
    if (!items.length) continue;
    if (tab.cats.length > 1) { const h = document.createElement("div"); h.className = "sub"; h.textContent = SUBHEAD[cat] || cat; box.appendChild(h); }
    for (const it of items) {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = '<canvas class="thumb" width="64" height="64"></canvas><div class="cname"></div><div class="cmeta"><span class="price"></span><span class="own"></span></div><div class="cnote"></div><button></button>';
      el.querySelector(".cname").textContent = it.name;
      const c = { el, it, thumb: el.querySelector("canvas"), btn: el.querySelector("button"), price: el.querySelector(".price"), own: el.querySelector(".own"), note: el.querySelector(".cnote"), state: null, busy: false, ticking: false };
      c.thumb.setAttribute("aria-hidden", "true");
      c.btn.onclick = () => cardAction(c);
      drawThumb(c.thumb, it);
      shopCards.set(it.id, c);
      box.appendChild(el);
    }
  }
  updateCards();
}
function cardState(it, me) {
  const watts = me ? me.watts : 0, owned = me ? me.owned[it.id] || 0 : 0;
  const poor = watts < it.price, need = it.price - watts;
  if (it.cat === "wheel") {
    const tier = me ? me.wheelTier : 0, mult = (S.balance && S.balance.WHEEL_MULT_PCT) || [100, 125, 160, 200, 260, 350];
    const to = `${(it.multPct / 100).toFixed(2)}×`;
    if (it.tier <= tier) return { kind: "owned", label: "Installed", disabled: true, note: `${to} watts per block` };
    if (it.tier === tier + 1) return { kind: "upgrade", label: "Upgrade", poor, need, note: `${(mult[tier] / 100).toFixed(2)}× → ${to}`, up: true };
    return { kind: "locked", label: `After T${it.tier - 1}`, disabled: true, note: `→ ${to}` };
  }
  if (!it.zone) { // wallpaper, flooring, skins: buy once, then equip
    const equipped = me && (it.cat === "skin" ? me.skin : it.cat === "wallpaper" ? me.wallpaper : me.floor) === it.id;
    if (owned) return equipped ? { kind: "equipped", label: "In use", disabled: true, note: "equipped", cur: true } : { kind: "equip", label: "Equip", alt: true, note: "owned" };
    return { kind: "buy", label: "Buy", poor, need };
  }
  const placed = me ? me.placed.filter((p) => p.item === it.id).length : 0;
  return { kind: "buy", label: owned ? "Buy another" : "Buy", poor, need, own: owned ? `own ${owned}` : "", ownTitle: owned ? `${placed} in the room, ${owned - placed} in your things` : "" };
}
function updateCards() {
  if (builtTab !== shopTab || builtSize !== S.catalog.size) return buildCards();
  const me = S.me;
  $("wallet").textContent = me ? `${fmt(me.watts)} W to spend` : "";
  for (const c of shopCards.values()) {
    const st = cardState(c.it, me), buying = st.kind === "buy" || st.kind === "upgrade";
    c.state = st;
    c.price.textContent = st.kind === "owned" || st.kind === "equip" || st.kind === "equipped" ? "" : c.it.price ? `${fmt(c.it.price)} W` : "Free";
    c.price.classList.toggle("poor", buying && !!st.poor);
    c.own.textContent = st.own || "";
    c.own.title = st.ownTitle || "";
    let note = st.note || "", cls = "cnote";
    if (buying && st.poor) { note = `need ${fmt(st.need)} more`; cls += " poor"; }
    else if (st.up) cls += " up";
    c.note.textContent = note;
    c.note.className = cls;
    c.el.classList.toggle("cur", !!st.cur);
    if (!c.busy && !c.ticking) { c.btn.textContent = st.label; c.btn.disabled = !!st.disabled; c.btn.className = st.alt ? "alt" : ""; }
    c.btn.setAttribute("aria-label", `${st.label}: ${c.it.name}${buying && c.it.price ? `, ${fmt(c.it.price)} watts` : ""}`);
  }
}
async function equip(it) {
  const r = it.cat === "skin" ? await post("/api/skin", { skinId: it.id }) : await post("/api/style", { [it.cat]: it.id });
  if (r.ok && r.j.me) applyMe(r.j.me);
  else toast(errorWords(r.j, { it }), "err");
  return r;
}
async function cardAction(c) {
  const it = c.it, st = c.state || cardState(it, S.me);
  if (c.busy || st.disabled) return;
  c.busy = true;
  c.btn.disabled = true;
  try {
    if (st.kind === "equip") { await equip(it); return; }
    const r = await post("/api/buy", { itemId: it.id });
    if (!r.ok || !r.j.me) {
      if (r.j.error === "poor") poorFeedback(c);
      toast(errorWords(r.j, { it }), "err");
      refresh(); // resync in case watts or ownership moved under us
      return;
    }
    applyMe(r.j.me);
    spendFeedback(c, it.price);
    if (it.cat === "wheel") toast(`${it.name} installed: ${(it.multPct / 100).toFixed(2)}× watts per block`, "ok");
    else if (!it.zone) await equip(it); // a new wallpaper / floor / skin goes straight on
    else enterPlace(it.id); // a new placeable goes straight into your hand
  } finally {
    c.busy = false;
    updateCards();
  }
}
function poorFeedback(c) {
  const m = $("meter");
  m.classList.remove("poor"); void m.offsetWidth; m.classList.add("poor");
  clearTimeout(poorFeedback.t);
  poorFeedback.t = setTimeout(() => m.classList.remove("poor"), 900);
  if (c) { c.el.classList.remove("shake"); void c.el.offsetWidth; c.el.classList.add("shake"); setTimeout(() => c.el.classList.remove("shake"), 500); }
}
function spendFeedback(c, price) {
  if (price > 0) {
    const s = document.createElement("span");
    s.className = "spend";
    s.textContent = `−${fmt(price)} W`;
    $("meter").appendChild(s);
    setTimeout(() => s.remove(), 1700);
  }
  if (c) {
    c.ticking = true;
    c.btn.textContent = "✓ Bought";
    c.btn.className = "ok";
    c.btn.disabled = true;
    setTimeout(() => { c.ticking = false; updateCards(); }, 1200);
  }
}

// ---------- inventory strip: owned but not yet placed ----------
let invChips = [], invSig = null;
function renderInventory() {
  const me = S.me, box = $("inv"), rows = [];
  if (me) for (const it of S.catalog.values()) if (it.zone) { const n = unplaced(it.id); if (n > 0) rows.push([it, n]); }
  const holding = P.mode === "place" ? P.it.id : "";
  const sig = rows.map(([it, n]) => `${it.id}:${n}`).join(",") + "|" + holding + "|" + (me ? me.placed.length : -1);
  if (sig === invSig) return;
  invSig = sig;
  box.innerHTML = "";
  invChips = [];
  if (!rows.length) {
    const s = document.createElement("span");
    s.className = "empty";
    s.textContent = !me ? "" : me.placed.length ? "Everything you own is out in the room. Tap a thing in the room to move it." : "Nothing yet. Things you buy wait here.";
    box.appendChild(s);
    return;
  }
  for (const [it, n] of rows) {
    const b = document.createElement("button");
    b.className = "chip2" + (holding === it.id ? " on" : "");
    b.title = `${it.name}: ${holding === it.id ? "tap again to put it back" : "tap to place"}`;
    b.setAttribute("aria-label", `${it.name}, ${n} to place`);
    b.innerHTML = `<canvas width="72" height="72"></canvas><span class="n">×${n}</span>`;
    const cv = b.querySelector("canvas");
    drawThumb(cv, it);
    b.onclick = () => (holding === it.id ? cancelMode() : enterPlace(it.id));
    box.appendChild(b);
    invChips.push({ it, cv });
  }
}

// ---------- first visit, nickname ----------
const DEFAULT_IDS = new Set(["skin_classic", "wp_plain", "fl_pine"]);
function renderFirstHint() {
  const me = S.me;
  const fresh = !!me && !me.wheelTier && !me.placed.length && !ls.get("sr_placed_once")
    && !Object.entries(me.owned || {}).some(([id, n]) => n > 0 && !DEFAULT_IDS.has(id));
  $("firstHint").hidden = !fresh || !!P.mode;
}
const nickEl = $("nick");
function syncNick() { if (S.me && document.activeElement !== nickEl && !nickEl.dataset.dirty) nickEl.value = S.me.nick === "anon" ? "" : S.me.nick; }
async function saveNick() {
  const r = await post("/api/nick", { nick: nickEl.value });
  delete nickEl.dataset.dirty;
  if (r.ok && r.j.me) { applyMe(r.j.me); toast(r.j.me.nick === "anon" ? "Room name cleared" : `Room name saved: ${r.j.me.nick}`, "ok"); }
  else toast(errorWords(r.j), "err");
}
nickEl.addEventListener("input", () => (nickEl.dataset.dirty = "1"));
nickEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveNick(); nickEl.blur(); } });
$("nickSave").onclick = saveNick;

// called after every `me` update
function afterMe() {
  if (selPid && !findPlaced(selPid)) selPid = null;
  if (P.mode === "move" && !findPlaced(P.pid)) cancelMode();
  if (P.mode === "place" && unplaced(P.it.id) <= 0) cancelMode();
  if (P.mode && P.cell) P.valid = checkSpot(P.it, P.cell.x, P.cell.y, P.mode === "move" ? P.pid : null);
  updateCards();
  renderInventory();
  renderFirstHint();
  syncNick();
  renderPlacing();
  positionTool();
  renderHud();
}
buildTabs();
buildCards();
renderInventory();
renderPlacing();

// ---------- commemorative certificate (phase 7, no chain) ----------
// The PNG is a pure function of the certificate JSON (plus the catalog and sprite data): no clock,
// no live reading, no Math.random. Everything that animates in the room (wheel, run cycle, window
// sky, clock hands, TV) is frozen to values derived from the cert's seed and claim date, so anyone
// holding the JSON can re-render the exact same pixels. That is the whole verification story.
const CERT_W = 640, CERT_H = 960; // drawn on a 2-px grid (320 x 480 units); text is the 3x5 font
const CERT_GLYPHS = { ",": [0, 0, 0, 2, 2], ":": [0, 2, 0, 2, 0], ">": [4, 2, 1, 2, 4], "º": [2, 5, 2, 0, 7], "·": [0, 0, 2, 0, 0], "_": [0, 0, 0, 0, 7], "'": [2, 2, 0, 0, 0], "(": [1, 2, 2, 2, 1], ")": [4, 2, 2, 2, 4], "=": [0, 7, 0, 7, 0], "&": [2, 5, 2, 5, 3], "@": [2, 5, 7, 4, 3], "*": [5, 2, 5, 0, 0] };
const certUpper = (s) => String(s == null ? "" : s).toUpperCase();
const certTextW = (s, k = 3) => Math.max(0, [...certUpper(s)].length * 4 * k - k);
// color: one colour, or 5 (one per glyph row) for a two-tone title
function certText(c, str, x, y, color, k = 3) {
  const rows = Array.isArray(color) ? color : null;
  if (!rows) c.fillStyle = color;
  let cx = x;
  for (const ch of certUpper(str)) {
    const gl = CERT_GLYPHS[ch] || FONT[ch] || FONT["?"];
    for (let r = 0; r < 5; r++) {
      if (rows) c.fillStyle = rows[r];
      for (let b = 0; b < 3; b++) if (gl[r] & (4 >> b)) c.fillRect(cx + b * k, y + r * k, k, k);
    }
    cx += 4 * k;
  }
}
function certTextShadow(c, str, x, y, color, k = 3, shadow = OUTLINE) { certText(c, str, x + k, y + k, shadow, k); certText(c, str, x, y, color, k); }
// accent schemes, all from the shared 16-colour palette
const CERT_SCHEMES = [
  { main: "#f5a623", light: "#ffd166", deep: "#c2410c", gem: "#3b82f6" }, // gold
  { main: "#c2410c", light: "#f5a623", deep: "#7c3f1d", gem: "#22c55e" }, // copper
  { main: "#3b82f6", light: "#a78bfa", deep: "#1e3a8a", gem: "#ffd166" }, // sapphire
  { main: "#22c55e", light: "#ffd166", deep: "#166534", gem: "#ef4444" }, // emerald
  { main: "#ef4444", light: "#ffd166", deep: "#7c3f1d", gem: "#22c55e" }, // ember
  { main: "#a78bfa", light: "#ffffff", deep: "#1e3a8a", gem: "#f472b6" }, // amethyst
  { main: "#f472b6", light: "#ffffff", deep: "#c2410c", gem: "#a78bfa" }, // rose
  { main: "#9ca3af", light: "#ffffff", deep: "#4b5563", gem: "#ef4444" }, // silver
];
// independent PRNG streams from successive 32-bit slices of the seed (the squeekplace rng())
function certSeed(cert, i) {
  const s = String((cert && cert.seed) || "");
  const v = parseInt(s.slice(i * 8, i * 8 + 8), 16);
  return Number.isFinite(v) ? v >>> 0 : hash(s + "|" + i);
}
// The frozen moment the portrait shows: the claim day at a seeded minute of his usual running hours.
function certPose(cert) {
  const r = rng(certSeed(cert, 1));
  const minute = 21 * 60 + Math.floor(r() * 180); // 21:00..23:59 UTC, when Squeektoshi tends to run
  const day = Date.parse(String(cert.claimedAt || "").slice(0, 10) + "T00:00:00Z");
  const now = (Number.isFinite(day) ? day : 0) + minute * 60_000 + Math.floor(r() * 60) * 1000;
  const speed = 800 + Math.floor(r() * 800);
  const fx = { t: Math.floor(r() * 600_000), now, utcHour: minute / 60, live: { key: "active", active: true, speed, rpm: (speed / (Math.PI * 200)) * 60 }, cuckooAge: r() < 0.5 ? 900 : Infinity };
  return { fx, frame: Math.floor(r() * 60), angle: r(), run: Math.floor(r() * 4), r };
}
// The player's room as it was at claim time, through the same painters the live room uses.
function renderPortrait(cert, pose) {
  const cv = canvas(LW, LH), c = cv.getContext("2d");
  const room = (cert && cert.room) || {}, { fx, frame: fr } = pose;
  const placed = Array.isArray(room.placed) ? room.placed : [];
  const items = (zone) => placed.map((p) => [p, p && S.catalog.get(p.item)]).filter(([p, it]) => it && it.zone === zone && Number.isInteger(p.x) && Number.isInteger(p.y));
  c.drawImage(wallpaperCanvas(room.wallpaper || "wp_plain"), 0, 0);
  for (const [p, it] of items("wall").sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x)) drawItem(p, it, p.x * CELL, p.y * CELL, it.w * CELL, it.h * CELL, c, fx, fr);
  c.drawImage(floorCanvas(room.floor || "fl_pine"), 0, FLOOR_Y);
  for (const [p, it] of items("rug").sort((a, b) => a[0].x - b[0].x)) drawRug(p, it, p.x * CELL, c, fx, fr);
  for (const [p, it] of items("floor").sort((a, b) => a[0].x - b[0].x)) {
    const pw = it.w * CELL, ph = it.h * CELL, x = p.x * CELL;
    c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(x + 1, FLOOR_Y, pw - 2, 2);
    drawItem(p, it, x, FLOOR_Y - ph, pw, ph, c, fx, fr);
  }
  if (!sprite(c, "burrow", fr, BURROW.x, BURROW.y, {})) c.drawImage(burrowCanvas(), BURROW.x, BURROW.y);
  const tier = clamp(cert.wheelTier | 0, 0, 5), angle = pose.angle;
  c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(WHEEL.cx - 19, FLOOR_Y, 38, 2);
  if (sprite(c, "wheel", Math.floor(angle * 24) % 4, WHEEL.x, WHEEL.y, { angle, tier })) {
    if (tier > 0) sprite(c, `wheel_t${tier}`, fr, WHEEL.x, WHEEL.y, { angle, tier });
  } else drawWheelPlaceholder(c, angle, tier);
  // the hamster, mid-run in the wheel
  const skin = cert.skin || "skin_classic", f = pose.run;
  const dx = Math.round(SPOT.wheel.x - 12), dy = Math.round(SPOT.wheel.y - (f % 2 ? 1 : 0) - 24);
  if (!sprite(c, "hamster_run", f, dx, dy, { flip: false, skin, remap: (window.SKIN_REMAPS || {})[skin] })) c.drawImage(hamsterFrame("run", f, skin), dx, dy);
  // a few watt sparks lifting off the rim
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI / 2 + (pose.r() - 0.5) * 1.7, d = WHEEL.r + 3 + pose.r() * 20;
    const x = Math.round(WHEEL.cx + Math.cos(a) * d), y = Math.round(WHEEL.cy + Math.sin(a) * d);
    c.fillStyle = "rgba(245,166,35,.55)"; c.fillRect(x - Math.sign(Math.cos(a)), y + 1, 1, 1);
    c.fillStyle = "#ffd166"; c.fillRect(x, y, 1, 1);
  }
  // evening light at a third of the live tint's strength (lights are on: he's running)
  const t = tintAt(fx.utcHour), soft = (v) => Math.round(255 - (255 - v) * 0.35);
  c.globalCompositeOperation = "multiply";
  c.fillStyle = `rgb(${t.mul.map(soft).join(",")})`; c.fillRect(0, 0, LW, LH);
  c.globalCompositeOperation = "source-over";
  return cv;
}
// Seeded ornament on a grid of 4-px cells (Q.fill decides the cells and their symmetry), outlined
// and lit from the top-left, with an optional cut gem. CORNER is 48 x 48, MEDAL 56 x 24.
function certOrnament(r, sch, Q) {
  const W = Q.w, H = Q.h, m = new Uint8Array(W * H);
  const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] === 1;
  Q.fill(m, r);
  const cv = canvas(W * 4, H * 4), c = cv.getContext("2d");
  c.fillStyle = OUTLINE;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (on(x, y)) c.fillRect(x * 4 - 2, y * 4 - 2, 8, 8);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!on(x, y)) continue;
    const X = x * 4, Y = y * 4;
    c.fillStyle = sch.main; c.fillRect(X, Y, 4, 4);
    c.fillStyle = sch.light; if (!on(x, y - 1)) c.fillRect(X, Y, 4, 2); if (!on(x - 1, y)) c.fillRect(X, Y, 2, 4);
    c.fillStyle = sch.deep; if (!on(x, y + 1)) c.fillRect(X, Y + 2, 4, 2); if (!on(x + 1, y)) c.fillRect(X + 2, Y, 2, 4);
  }
  if (Q.gem) { // a cut gem: outline, body, shadow, glint
    const [gx, gy, gs] = Q.gem;
    c.fillStyle = OUTLINE; c.fillRect(gx - 2, gy, gs + 4, gs); c.fillRect(gx, gy - 2, gs, gs + 4);
    c.fillStyle = sch.gem; c.fillRect(gx, gy, gs, gs);
    c.fillStyle = shade(sch.gem, -0.35); c.fillRect(gx + gs / 2, gy + gs / 2, gs / 2, gs / 2);
    c.fillStyle = "#ffffff"; c.fillRect(gx + 2, gy + 2, 2, 2);
  }
  return cv;
}
const CORNER = { w: 12, h: 12, gem: [6, 6, 8], fill(m, r) {
  const arm = 7 + Math.floor(r() * 5), curl = 6 + Math.floor(r() * 5), leaf = 0.16 + r() * 0.18;
  for (let y = 0; y < 12; y++) for (let x = 0; x <= y; x++) {
    let p = 0;
    if (y <= 4) p = 1; // the corner boss (it carries the gem)
    else if (x >= 4 && x <= 5 && y <= arm) p = 0.8; // tendril along the inner edge of the band
    else if (y - x <= 1 && y <= curl) p = 0.85; // curl along the diagonal
    else if (x + y <= 15) p = leaf * (1 - (x + y) / 18); // scattered leaves
    if (r() < p) m[y * 12 + x] = m[x * 12 + y] = 1;
  }
} };
const MEDAL = { w: 14, h: 6, gem: [24, 4, 8], fill(m, r) {
  for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) {
    const p = y <= 3 && x >= 7 - (5 - y) ? 1 : 0.35 * (1 - y / 6) * (x / 7);
    if (r() < p) m[y * 14 + x] = m[y * 14 + 13 - x] = 1;
  }
} };
function renderCert(cert) {
  const cv = canvas(CERT_W, CERT_H), c = cv.getContext("2d");
  c.imageSmoothingEnabled = false;
  const r = rng(certSeed(cert, 0));
  const sch = CERT_SCHEMES[Math.floor(r() * CERT_SCHEMES.length)];
  const U = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(x * 2, y * 2, w * 2, h * 2); };
  const BG = "#15110c", CREAM = "#f6ecd6";
  // 1. dark linen ground, seeded specks
  U(0, 0, 320, 480, BG);
  c.fillStyle = "#1f1912";
  for (let y = 0; y < 480; y++) for (let x = 0; x < 320; x++) if (r() < 0.05) c.fillRect(x * 2, y * 2, 2, 2);
  // 2. border band (8 units): outline, deep, a seeded 4-row motif mirrored both ways, light, outline
  const P = [4, 6, 8][Math.floor(r() * 3)], tones = [BG, sch.deep, sch.main, sch.light];
  const motif = [[], [], [], []];
  for (let row = 0; row < 2; row++) for (let i = 0; i < P / 2; i++) {
    const v = Math.floor(r() * 4);
    motif[row][i] = motif[row][P - 1 - i] = motif[3 - row][i] = motif[3 - row][P - 1 - i] = v;
  }
  const bandRow = (k, i) => (k === 0 || k === 7 ? OUTLINE : k === 1 ? sch.deep : k === 6 ? sch.light : tones[motif[k - 2][i % P]]);
  for (let i = 0; i < 320; i++) for (let k = 0; k < 8; k++) { U(i, k, 1, 1, bandRow(k, i)); U(i, 479 - k, 1, 1, bandRow(k, i)); }
  for (let i = 0; i < 480; i++) for (let k = 0; k < 8; k++) { U(k, i, 1, 1, bandRow(k, i)); U(319 - k, i, 1, 1, bandRow(k, i)); }
  // 3. dotted inner rule
  const dot = shade(sch.deep, -0.15);
  for (let i = 12; i < 308; i += 2) { U(i, 11, 1, 1, dot); U(i, 468, 1, 1, dot); }
  for (let i = 12; i < 468; i += 2) { U(11, i, 1, 1, dot); U(308, i, 1, 1, dot); }
  // 4. header
  const tw = certTextW("SQUEEKROOM", 6);
  certText(c, "SQUEEKROOM", Math.round((CERT_W - tw) / 2) + 6, 46, OUTLINE, 6);
  certText(c, "SQUEEKROOM", Math.round((CERT_W - tw) / 2), 40, [sch.light, sch.light, sch.main, sch.main, sch.deep], 6);
  const sub = "A ROOM POWERED BY A REAL HAMSTER";
  certTextShadow(c, sub, Math.round((CERT_W - certTextW(sub)) / 2), 86, CREAM);
  // 5. the room portrait (cols 0 and 19 lose 10 px each to the frame), 2x
  const pose = certPose(cert);
  U(7, 59, 306, 198, OUTLINE); U(8, 60, 304, 196, sch.main); U(9, 61, 302, 194, OUTLINE);
  c.drawImage(renderPortrait(cert, pose), 10, 0, 300, 192, 20, 124, 600, 384);
  // 6. stats plaque, 3x5 font at 3x
  const PX = 40, PY = 532, PW = 560, PH = 278;
  c.fillStyle = OUTLINE; c.fillRect(PX - 2, PY - 2, PW + 4, PH + 4);
  c.fillStyle = sch.main; c.fillRect(PX, PY, PW, PH);
  c.fillStyle = sch.deep; c.fillRect(PX + 2, PY + 2, PW - 4, PH - 4);
  c.fillStyle = shade(sch.deep, -0.75); c.fillRect(PX + 4, PY + 4, PW - 8, PH - 8);
  c.fillStyle = sch.light; for (const [x, y] of [[PX + 8, PY + 8], [PX + PW - 12, PY + 8], [PX + 8, PY + PH - 12], [PX + PW - 12, PY + PH - 12]]) c.fillRect(x, y, 4, 4); // rivets
  const serial = Number(cert.serial) || 0;
  const title = `SQUEEKROOM CERTIFICATE Nº ${serial}`;
  certTextShadow(c, title, Math.round((CERT_W - certTextW(title)) / 2), PY + 18, sch.light);
  c.fillStyle = sch.deep; c.fillRect(PX + 24, PY + 47, PW - 48, 2);
  const fh = (n) => (Number.isFinite(Number(n)) && n !== null ? fmt(Number(n)) : "?");
  const skinItem = S.catalog.get(cert.skin);
  const rows = [
    ["ROOM OF", cert.nick || "anon"],
    ["LIFETIME", `${fh(cert.lifetimeWatts)} W`],
    ["ACTIVE DAYS", fh(cert.activeDays)],
    ["BLOCKS", `${fh(cert.joinHeight)} -> ${fh(cert.claimHeight)}`],
    ["WHEEL", `T${cert.wheelTier | 0} · ${skinItem ? skinItem.name : String(cert.skin || "").replace(/^skin_/, "")}`],
    ["CLAIMED", String(cert.claimedAt || "").slice(0, 10)],
    ["TOKEN", cert.tokenFingerprint || ""],
    ["SEED", String(cert.seed || "").slice(0, 16)],
  ];
  const labelCol = shade(sch.main, 0.15), lead = shade(sch.deep, 0.1);
  rows.forEach(([label, value], i) => {
    const y = PY + 64 + i * 26, lx = PX + 24, rx = PX + PW - 24;
    const vw = certTextW(value), vx = rx - vw, lw = certTextW(label);
    certText(c, label, lx, y, labelCol);
    c.fillStyle = lead; for (let x = lx + lw + 9; x + 3 <= vx - 9; x += 9) c.fillRect(x, y + 12, 3, 3); // leader dots
    certText(c, value, vx, y, CREAM);
  });
  // 7. footer: the care-policy line, then the hamster himself between seeded sparkles
  const motto = "REWARDS WATCHING, NEVER RUNNING";
  certTextShadow(c, motto, Math.round((CERT_W - certTextW(motto)) / 2), 834, sch.light);
  const skin = cert.skin || "skin_classic", sit = canvas(24, 24), sg = sit.getContext("2d");
  if (!sprite(sg, "hamster_sit", 0, 0, 0, { skin, remap: (window.SKIN_REMAPS || {})[skin] })) sg.drawImage(hamsterFrame("sit", 0, skin), 0, 0);
  c.drawImage(sit, 0, 0, 24, 24, 296, 866, 48, 48);
  for (let i = 0; i < 18; i++) {
    const side = i % 2 ? 1 : -1, x = 160 + side * (34 + Math.floor(r() * 90)), y = 434 + Math.floor(r() * 22);
    U(x, y, 1, 1, r() < 0.3 ? CREAM : sch.light);
    if (r() < 0.4) { U(x - 1, y, 1, 1, sch.deep); U(x + 1, y, 1, 1, sch.deep); U(x, y - 1, 1, 1, sch.deep); U(x, y + 1, 1, 1, sch.deep); }
  }
  // 8. ornaments last, over the band: four mirrored corners, a medallion top and bottom
  const corner = certOrnament(r, sch, CORNER), medal = certOrnament(r, sch, MEDAL);
  const put = (img, x, y, sx, sy) => { c.save(); c.translate(x, y); c.scale(sx, sy); c.drawImage(img, 0, 0); c.restore(); };
  put(corner, 0, 0, 1, 1); put(corner, CERT_W, 0, -1, 1); put(corner, 0, CERT_H, 1, -1); put(corner, CERT_W, CERT_H, -1, -1);
  put(medal, (CERT_W - medal.width) / 2, 0, 1, 1); put(medal, (CERT_W - medal.width) / 2, CERT_H, 1, -1);
  return cv;
}

// what's left, in words
function certLeftWords(me) {
  const goal = (S.balance && S.balance.CERT_LIFETIME_WATTS) || 250_000, days = (S.balance && S.balance.CERT_ACTIVE_DAYS) || 7;
  const w = Math.max(0, goal - (me.lifetimeWatts | 0)), d = Math.max(0, days - (me.activeDays | 0));
  const parts = [];
  if (w) parts.push(`${fmt(w)} watt${w === 1 ? "" : "s"}`);
  if (d) parts.push(`${d} active day${d === 1 ? "" : "s"}`);
  return parts.length ? `${parts.join(" and ")} to go` : "ready to claim";
}
let claimBusy = false;
function renderCertHud(me) {
  const life = $("life"), cb = $("certBtn"), cert = me.commemorative;
  life.classList.toggle("locked", !cert && !me.certEligible);
  life.classList.toggle("ready", !cert && !!me.certEligible);
  const tip = cert ? `Certificate Nº ${cert.serial} is yours. Open it` : me.certEligible ? "You can claim your commemorative certificate" : `Commemorative certificate: ${certLeftWords(me)}`;
  if (life.title !== tip) { life.title = tip; life.setAttribute("aria-label", `${$("lifeLine").textContent}. ${tip}`); }
  cb.hidden = !cert && !me.certEligible;
  cb.classList.toggle("claimed", !!cert);
  const label = cert ? `Your certificate · Nº ${cert.serial}` : claimBusy ? "Claiming…" : "Claim your certificate";
  if (cb.textContent !== label) cb.textContent = label;
  cb.disabled = claimBusy;
}
function certAction() {
  const me = S.me;
  if (!me) return;
  if (me.commemorative) openCert(me.commemorative);
  else if (me.certEligible) claimCert();
  else toast(`${certLeftWords(me)[0].toUpperCase()}${certLeftWords(me).slice(1)} for your certificate. Watts arrive on their own.`);
}
async function claimCert() {
  if (claimBusy || !S.me) return;
  claimBusy = true;
  renderHud();
  const r = await post("/api/claim-commemorative", {});
  claimBusy = false;
  if (r.ok && r.j.cert) {
    if (S.me) S.me.commemorative = r.j.cert;
    renderHud();
    openCert(r.j.cert);
    if (!r.j.already) toast(`Certificate Nº ${r.j.cert.serial} is yours`, "ok");
    refresh();
    return;
  }
  if (r.j.error === "not_eligible") toast(`Not yet: ${certLeftWords(r.j)}`, "err");
  else toast(errorWords(r.j), "err");
  refresh();
}
$("life").onclick = certAction;
$("certBtn").onclick = certAction;

// overlay: canvas + Save PNG / Save JSON / Share
const certUi = { cert: null, src: null, blob: null, back: null };
const certOpen = () => !$("certModal").hidden;
function openCert(cert) {
  if (!cert) return;
  certUi.cert = cert;
  certUi.src = renderCert(cert);
  certUi.blob = null;
  certUi.src.toBlob((b) => { if (certUi.cert === cert) certUi.blob = b; }, "image/png"); // ready for Share's user gesture
  const view2 = $("certCanvas"), c = view2.getContext("2d");
  c.clearRect(0, 0, CERT_W, CERT_H);
  c.drawImage(certUi.src, 0, 0);
  view2.setAttribute("aria-label", `Certificate Nº ${cert.serial} for ${cert.nick}: ${fmt(cert.lifetimeWatts)} lifetime watts over ${cert.activeDays} active days, blocks ${cert.joinHeight} to ${cert.claimHeight}, with a portrait of the room.`);
  $("certTitle").textContent = `Certificate Nº ${cert.serial}`;
  $("certSub").textContent = `${cert.nick} · claimed ${String(cert.claimedAt || "").slice(0, 10)}`;
  $("certShare").hidden = typeof navigator.share !== "function";
  if (!certOpen()) certUi.back = document.activeElement;
  $("certModal").hidden = false;
  document.body.classList.add("modal-open");
  $("certClose").focus();
}
function closeCert() {
  $("certModal").hidden = true;
  document.body.classList.remove("modal-open");
  const back = certUi.back;
  certUi.back = null;
  if (back && back.focus && document.contains(back)) back.focus();
}
function certKey(e) {
  if (e.key === "Escape") { e.preventDefault(); closeCert(); return; }
  if (e.key !== "Tab") return;
  const f = [...$("certModal").querySelectorAll("button:not([hidden]):not([disabled])")];
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; a.hidden = true;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
$("certClose").onclick = closeCert;
$("certModal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeCert(); });
$("certPng").onclick = () => {
  const { cert, src } = certUi;
  if (!src) return;
  src.toBlob((b) => (b ? saveBlob(b, `squeekroom-cert-${cert.serial}.png`) : toast("Could not make the PNG here", "err")), "image/png");
};
$("certJson").onclick = () => {
  const { cert } = certUi;
  if (cert) saveBlob(new Blob([JSON.stringify(cert, null, 2) + "\n"], { type: "application/json" }), `squeekroom-cert-${cert.serial}.json`);
};
$("certShare").onclick = async () => {
  const { cert, blob } = certUi;
  if (!cert) return;
  const data = { title: `Squeekroom certificate Nº ${cert.serial}`, text: `My Squeekroom certificate Nº ${cert.serial}: ${fmt(cert.lifetimeWatts)} watts over ${cert.activeDays} active days, powered by a real hamster.` };
  const file = blob && new File([blob], `squeekroom-cert-${cert.serial}.png`, { type: "image/png" });
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) data.files = [file];
  else data.url = location.origin + "/";
  try { await navigator.share(data); }
  catch (e) { if (!e || e.name !== "AbortError") toast("Sharing didn't work here. Save the PNG instead.", "err"); }
};

// debug handle for the browser console / verification
window.__squeekroom = { S, ham, wheel, duty, sparks, meter, liveStatus, tintAt, P, checkSpot, enterPlace, select, get selPid() { return selPid; }, get FX() { return FX; },
  renderNow() { const st = liveStatus(); tick10(); render(st); }, // paints one frame even when rAF is paused (hidden tab)
  renderCert, openCert, closeCert, certLeftWords, get cert() { return certUi.cert; } };

fit();
renderHud();
refresh().then(beat);
setInterval(refresh, 5000);
setInterval(liveFetch, 10000);
setInterval(beat, 30000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { beat(); refresh(); } });
requestAnimationFrame((t) => { last = t; requestAnimationFrame(loop); });
})();

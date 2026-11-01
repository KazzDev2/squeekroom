// Squeekroom client: live state, HUD strip, and the room renderer.
// Phase 3 (renderer core): every piece of art is a placeholder painted in code. Phase 4's
// sprites.js drops real art in through the sprite registry below without touching game logic.
(() => {
"use strict";
const $ = (id) => document.getElementById(id);

// ---------- room geometry (server ROOM is the source of truth; these are the defaults) ----------
// The server's model is the flat side view: 20 x 12 cells of 16 px (320 x 192). Floor items take
// whole columns (1-D), wall items a 2-D cell on rows 2..7, rugs whole columns of their own layer.
// The live room draws that model through the iso projection below; the certificate portrait
// (renderPortrait) still paints the flat view, so the FLAT_* geometry stays alongside.
const FLAT_W = 320, FLAT_H = 192;
let ROOM = { COLS: 20, ROWS: 12, CELL: 16, FLOOR_ROW: 11, WALL_TOP: 2, WALL_BOTTOM: 7, RESERVED: {},
  ISO_NI: 11, ISO_NJ: 10, FIX_MAX_SUM: 14, FIX_GAP: 2, FIXTURE_DEFAULTS: { wheel: { i: 1, j: 5, flip: true }, bed: { i: 7, j: 2, flip: false } } };
const CERT_WHEEL_COLS = [3, 6]; // the certificate's flat room keeps the wheel where it always stood
let CELL = 16, FLOOR_Y = 176; // flat view: furniture bottoms stand on this line; the floor band is below it
const BASEBOARD = 6; // flat view: wall trim height just above the floor line
let FLAT_WHEEL = { cx: 80, cy: 150, r: 23, x: 56, y: 126 }; // 48 x 48 box centred on floor cols 3..6
let FLAT_BURROW = { cx: 280, x: 256, y: 144, w: 48, h: 32 }; // 48 x 32 mound on floor cols 16..18
let FLAT_SPOT = { wheel: { x: 80, y: 170 } };

// ---------- iso view (v2): 2:1 dimetric room, a pure client-side projection of the flat model ----------
// Floor: NI x NJ diamond tiles of 32 x 16. Tile (i, j): i runs down-right along the RIGHT back wall,
// j runs down-left along the LEFT back wall, (0, 0) is the back corner. Tile centre on screen:
//   x = X0 + (i - j) * 16,  y = Y0 + (i + j) * 8 + 8
// The floor is 11 x 10 (NI = COLS - CORNER, NJ = CORNER + 1). Floor furniture, rugs, the wheel and
// the bed stand on tiles anywhere on it (see footprint()); screenToTile() is the inverse for picking.
// Wall columns map onto the walls the flat way: column c lands at screen x = 24 + 16c, cols 0..9 up
// the left wall into the corner (CORNER = 9), cols 10..19 down the right wall (colTile()).
// Walls: wall columns share the x pitch (col c spans x 16+16c .. 32+16c); rows 2..7 stack 16 px apart
// above the floor line. The back wall is painted flat into a strip (LW x WALL_H, same x as the screen)
// and then folded: pixel column x drops so its bottom sits on wallBase(x), 1 px per 2 px from the
// corner. Wallpaper, wainscot panels, wall decor and their placement overlays all go through the fold.
// Room material (me.roomTier) is the den's trim: a short baseboard, the wall cap along the arch, the
// end posts and the floor slab. The equipped wallpaper covers the walls down to the baseboard and the
// equipped flooring covers every floor tile.
const ISO = { CORNER: 9, NI: 11, NJ: 10, X0: 168, Y0: 102, WALL_H: 100, PAD: 8, SLAB: 5, FOOT: 3 };
const LW = ISO.PAD * 2 + (ISO.NI + ISO.NJ) * 16; // 352
const LH = 240; // the floor's front tip (empty floor) runs off the bottom edge; fit() caps it at ~70% of the window height
let IWHEEL = { cx: 96, cy: 124, r: 23, x: 72, y: 100, foot: 150 }, IBURROW = { cx: 296, x: 272, y: 144, foot: 176 };
let SPOT = { wheel: { x: 96, y: 144 }, sit: { x: 136, y: 160 }, bed: { x: 248, y: 185 } };
const isoTileCenter = (i, j) => ({ x: ISO.X0 + (i - j) * 16, y: ISO.Y0 + (i + j) * 8 + 8 });
const isoTileTop = (i, j) => ({ x: ISO.X0 - 16 + (i - j) * 16, y: ISO.Y0 + (i + j) * 8 }); // 32 x 16 box
const colTile = (c) => (c <= ISO.CORNER ? [0, ISO.CORNER - c] : [c - ISO.CORNER, 0]);
const colLeft = (c) => ISO.X0 - 8 + (c - ISO.CORNER) * 16; // = 16 + 16c
const colFootY = (c) => ISO.Y0 + 8 + 8 * Math.abs(c - ISO.CORNER); // lane tile centre
// billboard ground line of an item over columns x..x+w-1: the mean of its lane tiles' centres
function footY(x, w) { let s = 0; for (let c = x; c < x + w; c++) s += colFootY(c); return Math.round(s / w) + ISO.FOOT; }
function wallBase(x) { return ISO.Y0 + (x >= ISO.X0 ? Math.floor((x - ISO.X0 + 1) / 2) : Math.floor((ISO.X0 - x) / 2)); }
const WALL_X0 = ISO.X0 - ISO.NJ * 16, WALL_X1 = ISO.X0 + ISO.NI * 16; // [8, 344)
const wallRowY = (r) => (r - ROOM.WALL_TOP) * 16 + 2; // strip y of a wall row's top
const stripTop = (x) => wallBase(x) - ISO.WALL_H; // screen y of strip row 0 at column x
function screenToTile(x, y) { const a = (x - ISO.X0) / 16, b = (y - ISO.Y0) / 8; return [(a + b) / 2, (b - a) / 2]; }
function tileToCol(i, j) { return clamp(ISO.CORNER + Math.floor(i) - Math.floor(j), 0, ROOM.COLS - 1); }
function applyRoom(room) {
  if (room && typeof room === "object") ROOM = { ...ROOM, ...room };
  CELL = ROOM.CELL || 16;
  FLOOR_Y = ROOM.FLOOR_ROW * CELL;
  const [wa, wb] = CERT_WHEEL_COLS, bur = ROOM.RESERVED && ROOM.RESERVED.burrow;
  const wcx = ((wa + wb + 1) * CELL) / 2;
  FLAT_WHEEL = { cx: wcx, cy: FLOOR_Y - 26, r: 23, x: wcx - 24, y: FLOOR_Y - 50 };
  FLAT_SPOT = { wheel: { x: wcx, y: FLAT_WHEEL.cy + FLAT_WHEEL.r - 3 } };
  // the burrow mound only exists while the server still reserves lane tiles for it (it no longer does);
  // the wheel and the bed follow the player's fixtures
  FLAT_BURROW = IBURROW = null;
  if (bur) {
    const [ba, bb] = bur, bcx = ((ba + bb + 1) * CELL) / 2;
    FLAT_BURROW = { cx: bcx, x: bcx - 24, y: FLOOR_Y - 32, w: 48, h: 32 };
    const ibx = colLeft(ba) + ((bb - ba + 1) * 16) / 2, ibf = footY(ba, bb - ba + 1);
    IBURROW = { cx: ibx, x: ibx - 24, y: ibf - 32, foot: ibf };
  }
  placeFixtures();
}
// ---------- fixtures: the wheel and the bed stand on open floor tiles (i, j) and move like furniture ----------
// They ride the placement UI as pseudo placements with pid "fx:wheel" / "fx:bed" (x = i, y = j).
const FIX_ITEM = { wheel: { id: "fx_wheel", name: "Wheel", zone: "fixture", fixture: "wheel", w: 1, h: 1 }, bed: { id: "fx_bed", name: "Bed", zone: "fixture", fixture: "bed", w: 1, h: 1 } };
const fixOf = (pid) => (typeof pid === "string" && pid.startsWith("fx:") ? pid.slice(3) : null);
let myFixtures = null; // S.me.fixtures, set by applyMe (S itself is declared further down)
function fixture(k) {
  const f = myFixtures && myFixtures[k];
  return f && Number.isInteger(f.i) && Number.isInteger(f.j) ? f : ROOM.FIXTURE_DEFAULTS[k];
}
// same rules as server.js moveFixture(): on the floor (walls included, on screen), FIX_GAP apart, off furniture
function checkFixture(k, i, j) {
  if (!(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && i < ROOM.ISO_NI && j >= 0 && j < ROOM.ISO_NJ && i + j <= ROOM.FIX_MAX_SUM)) return { ok: false, error: "out_of_bounds" };
  const o = fixture(k === "wheel" ? "bed" : "wheel");
  if (Math.max(Math.abs(o.i - i), Math.abs(o.j - j)) < ROOM.FIX_GAP) return { ok: false, error: "too_close", which: k };
  for (const p of (S.me && S.me.placed) || []) { // not onto furniture (rugs are flat: fine)
    const it = S.catalog.get(p.item);
    if (it && it.zone === "floor" && footprint(it, p.x, p.y, p.flip).some(([a, b]) => a === i && b === j)) return { ok: false, error: "occupied", with: it };
  }
  return { ok: true };
}
const IW = () => window.IsoWheel || null;
// The wheel's screen geometry on tile (i, j): the 3D wheel when sprites_iso_wheel.js loaded, else the
// front-facing billboard standing on that tile. run = the running hamster's bottom-centre.
function wheelAt(i, j, flip) {
  const so = tileSouth(i, j), w = IW();
  if (w) { const b = w.bounds(so.x, so.y, flip), r = w.runSpot(so.x, so.y, flip); return { box: b, run: r, cx: b.x + b.w / 2, cy: b.y + b.h / 2, r: Math.min(b.w, b.h) / 2 - 2, foot: so.y - 8 + ISO.FOOT }; }
  const foot = so.y - 8 + ISO.FOOT, box = { x: so.x - 24, y: foot - 50, w: 48, h: 50 };
  return { box, run: { x: so.x, y: foot - 26 + 23 - 3 }, cx: so.x, cy: foot - 26, r: 23, foot };
}
function placeFixtures() {
  const w = fixture("wheel"), b = fixture("bed"), g0 = wheelAt(w.i, w.j, !!w.flip);
  IWHEEL = { cx: g0.cx, cy: g0.cy, r: g0.r, x: g0.box.x, y: g0.box.y, foot: g0.foot };
  const si = w.i + 1 < ROOM.ISO_NI && !(w.i + 1 === b.i && w.j === b.j) ? [w.i + 1, w.j] : [w.i, Math.min(w.j + 1, ROOM.ISO_NJ - 1)];
  const sit = isoTileCenter(si[0], si[1]), bed = isoTileCenter(b.i, b.j);
  SPOT = { wheel: { x: g0.run.x, y: g0.run.y }, sit: { x: sit.x, y: sit.y + 2 }, bed: { x: bed.x, y: bed.y + ISO.FOOT } };
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
  const H = WALL_H(), c = canvas(FLAT_W, H), g = c.getContext("2d");
  const wallH = H - BASEBOARD;
  if (hasSprite(id)) {
    for (let y = 0; y < wallH; y += 16) for (let x = 0; x < FLAT_W; x += 16) sprite(g, id, 0, x, y, {});
  } else {
    const rnd = rng(hash(id));
    const pat = {
      wp_plain() { for (let x = 0; x < FLAT_W; x += 8) { g.fillStyle = (x / 8) % 2 ? "#efe3c8" : "#f6ecd6"; g.fillRect(x, 0, 8, wallH); } },
      wp_polka() { g.fillStyle = "#fde4ee"; g.fillRect(0, 0, FLAT_W, wallH); for (let y = 6, row = 0; y < wallH; y += 12, row++) for (let x = (row % 2) * 8 + 4; x < FLAT_W; x += 16) fillEllipse(g, x + 0.5, y + 0.5, 2, 2, "#f472b6"); },
      wp_forest() {
        g.fillStyle = "#d3ead2"; g.fillRect(0, 0, FLAT_W, wallH);
        g.fillStyle = "#bfe0be"; g.fillRect(0, wallH - 60, FLAT_W, 60);
        for (let x = -6; x < FLAT_W; x += 18 + Math.floor(rnd() * 10)) { const h = 30 + Math.floor(rnd() * 34), col = rnd() < 0.5 ? "#22c55e" : "#166534"; for (let k = 0; k < h; k++) { const half = Math.floor((k / h) * 9); g.fillStyle = col; g.fillRect(x + 9 - half, wallH - h + k, half * 2 + 1, 1); } }
      },
      wp_circuit() {
        g.fillStyle = "#0f3b2a"; g.fillRect(0, 0, FLAT_W, wallH);
        g.fillStyle = "#1c5a40";
        for (let y = 8; y < wallH; y += 16) g.fillRect(0, y, FLAT_W, 1);
        for (let x = 8; x < FLAT_W; x += 16) g.fillRect(x, 0, 1, wallH);
        for (let i = 0; i < 70; i++) { const x = 8 + 16 * Math.floor(rnd() * 20), y = 8 + 16 * Math.floor(rnd() * 11); g.fillStyle = rnd() < 0.5 ? "#22c55e" : "#ffd166"; g.fillRect(x - 1, y - 1, 3, 3); }
      },
      wp_night_sky() {
        for (let y = 0; y < wallH; y += 4) { g.fillStyle = `rgb(${Math.round(lerp(11, 30, y / wallH))},${Math.round(lerp(22, 58, y / wallH))},${Math.round(lerp(64, 138, y / wallH))})`; g.fillRect(0, y, FLAT_W, 4); }
        for (let i = 0; i < 90; i++) { g.fillStyle = rnd() < 0.2 ? "#ffd166" : "#ffffff"; g.fillRect(Math.floor(rnd() * FLAT_W), Math.floor(rnd() * wallH), 1, 1); }
      },
    }[id];
    if (pat) pat();
    else { const a = PH_COLORS[hash(id) % PH_COLORS.length]; for (let x = 0; x < FLAT_W; x += 8) { g.fillStyle = (x / 8) % 2 ? shade(a, 0.55) : shade(a, 0.7); g.fillRect(x, 0, 8, wallH); } }
  }
  // crown trim + baseboard (fixed room structure, not part of the swatch)
  g.fillStyle = "rgba(0,0,0,.12)"; g.fillRect(0, 0, FLAT_W, 2);
  g.fillStyle = "#7c3f1d"; g.fillRect(0, wallH, FLAT_W, BASEBOARD);
  g.fillStyle = "#a35a2a"; g.fillRect(0, wallH, FLAT_W, 1);
  g.fillStyle = "#5a2d14"; g.fillRect(0, H - 1, FLAT_W, 1);
  styleCache.set(key, c);
  return c;
}
function floorCanvas(id) {
  const key = `fl|${id}|${hasSprite(id) ? "s" : "p"}|${FLOOR_Y}`;
  if (styleCache.has(key)) return styleCache.get(key);
  const H = FLAT_H - FLOOR_Y, c = canvas(FLAT_W, H), g = c.getContext("2d");
  if (hasSprite(id)) {
    for (let y = 0; y < H; y += 16) for (let x = 0; x < FLAT_W; x += 16) sprite(g, id, 0, x, y, {});
  } else {
    const rnd = rng(hash(id));
    const pat = {
      fl_pine() {
        for (let row = 0; row * 8 < H; row++) {
          g.fillStyle = row % 2 ? "#b8783f" : "#c98b4e"; g.fillRect(0, row * 8, FLAT_W, 8);
          g.fillStyle = "#7c3f1d"; for (let x = (row % 2) * 20; x < FLAT_W; x += 40) g.fillRect(x, row * 8, 1, 8);
          g.fillStyle = "#8f5228"; g.fillRect(0, row * 8 + 7, FLAT_W, 1);
        }
        g.fillStyle = "#e0a868"; g.fillRect(0, 0, FLAT_W, 1);
      },
      fl_checker() { for (let y = 0; y < H; y += 8) for (let x = 0; x < FLAT_W; x += 8) { g.fillStyle = ((x + y) / 8) % 2 ? "#4b5563" : "#f3efe6"; g.fillRect(x, y, 8, 8); } },
      fl_pebble() { g.fillStyle = "#9ca3af"; g.fillRect(0, 0, FLAT_W, H); for (let i = 0; i < 80; i++) fillEllipse(g, rnd() * FLAT_W, rnd() * H, 2 + rnd() * 2, 1 + rnd() * 1.5, rnd() < 0.5 ? "#6b7280" : "#d1d5db"); },
      fl_cloud() { g.fillStyle = "#dbe4ff"; g.fillRect(0, 0, FLAT_W, H); for (let x = 0; x < FLAT_W; x += 14) fillEllipse(g, x + rnd() * 6, 4 + rnd() * (H - 8), 6, 3, "#ffffff"); },
    }[id];
    if (pat) pat();
    else { const a = PH_COLORS[hash(id) % PH_COLORS.length]; for (let x = 0; x < FLAT_W; x += 8) { g.fillStyle = (x / 8) % 2 ? shade(a, -0.1) : a; g.fillRect(x, 0, 8, H); } }
  }
  g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(0, 0, FLAT_W, 1); // contact line at the wall seam
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
function drawWheelPlaceholder(c, angleRev, tier, W = IWHEEL) { // W: the wheel box (iso room, or FLAT_WHEEL for the certificate)
  const { cx, cy } = W, x0 = cx - 24, y0 = cy - 24;
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
  configured: false, // GET /api/config (balance, room, catalog) has landed
  idle: false, // server's view: asleep by the chain (no settled block for IDLE_AFTER_MS): bed income flows
  meAt: 0, // serverTime of the newest `me` applied (drops an older snapshot that lands late)
};
const params = new URLSearchParams(location.search);
const UTC_OVERRIDE = params.has("utc") ? Number(params.get("utc")) : null; // ?utc=22 previews the tint at that hour

// The reading that drives the room: the server's copy (it polls the status API once for everyone).
// The browser fetches the API itself only while that copy is missing or over a minute old.
// Demo and replay use the server's hamster only.
function serverReadingFresh() {
  const h = S.hamster;
  return !!h && !!h.updatedAt && Date.now() + S.skew - Date.parse(h.updatedAt) <= 60_000;
}
function reading() { return S.demo || S.replay || serverReadingFresh() ? S.hamster || null : S.live || S.hamster || null; }
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
// Static rules (balance, room geometry, catalog) come once from /api/config; the 5 s poll of
// /api/state carries only what changes. Retries with backoff until the server answers.
async function loadConfig() {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 15_000)) {
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      applyConfig(await r.json());
      return;
    } catch {
      S.offline = true;
      renderHud();
      await new Promise((res) => setTimeout(res, wait));
    }
  }
}
function applyConfig(j) {
  S.demo = !!j.demo;
  S.replay = !!j.replay; // simulated: the server's reading is the only one (no live status to fetch)
  S.nonstop = !!(j.replay && j.replay.nonstop); // simulated, running nonstop until the real hamster goes live
  $("simNote").hidden = !S.nonstop;
  if (j.api) S.api = j.api;
  if (j.balance) S.balance = j.balance;
  if (j.room) applyRoom(j.room);
  if (Array.isArray(j.catalog)) S.catalog = new Map(j.catalog.map((i) => [i.id, i]));
  S.walletCfg = j.wallet && j.wallet.enabled ? j.wallet : null; // absent: no wallet button at all
  S.configured = true;
  walletHook("onConfig", S.walletCfg);
}
// public/wallet.js (optional, loaded after this file) registers window.SqueekWallet; every call is
// guarded so the game runs unchanged without it.
function walletHook(name, ...args) {
  const w = window.SqueekWallet;
  if (!w || typeof w[name] !== "function") return undefined;
  try { return w[name](...args); } catch (e) { console.error("wallet:", e); return undefined; }
}
async function refresh() {
  if (!S.configured) return;
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
  S.height = j.height;
  S.chain = j.chain;
  S.hamster = j.hamster;
  S.night = j.night;
  S.idle = j.idle === true;
  S.speedPct = typeof j.speedPct === "number" ? j.speedPct : 100; // speed bonus on wheel income (100 = none)
  if (typeof j.serverTime === "number") S.skew = j.serverTime - Date.now();
  if (j.me) { applyMe(j.me, first, { at: j.serverTime, soft: S.idle }); if (!first) noteTrickle(); }
  else if (j.meError) toast(j.meError === "server_full" ? "The server is full." : j.meError === "too_many_dens" ? "Too many new dens from your network. Try again in an hour." : `Couldn't load your den (${j.meError}).`, "err");
  if (j.raid !== undefined) applyRaidStatus(j.raid);
  if (typeof j.burned === "number") S.burned = j.burned;
  if (Array.isArray(j.raidFeed)) applyFeed(j.raidFeed);
  if (RU.open) renderRaid();
  if (first) { ham.init = false; liveFetch(); }
}
// Every server response that carries `me` lands here: the UI always re-renders from the server's
// copy (no optimistic updates).
// opts.at: the response's serverTime (snapshots), opts.soft: credit came while he sleeps (bed income).
function applyMe(me, first = false, opts = {}) {
  if (!me) return;
  if (typeof opts.at === "number") { if (opts.at < S.meAt) return; S.meAt = opts.at; }
  const prev = S.me;
  S.me = me;
  myFixtures = me.fixtures || null;
  placeFixtures();
  S.watching = !!me.watching;
  if (first || !prev) meter.shown = me.watts;
  else if (me.lifetimeWatts > prev.lifetimeWatts) onAccrual(me.lifetimeWatts - prev.lifetimeWatts, !!opts.soft);
  noteEarn(me, prev, first);
  meter.target = me.watts;
  afterMe();
}
// Live wheel reading straight from the public API (CORS is open). Browsers pass its edge checks
// where a hosting provider's IP may not, so this is the primary source outside demo mode.
async function liveFetch() {
  if (!S.loaded || S.demo || S.replay) return; // demo and replay use the server's own reading
  if (serverReadingFresh()) { S.live = null; return; } // fallback only: the server's copy is current
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
// shown tweens to target: a fixed METER_MS ease-out from wherever it is when the target moves
const meter = { shown: 0, target: 0, from: 0, to: 0, t0: 0, lastText: "", glowUntil: 0 };
const METER_MS = 600;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
let cuckooAt = 0; // the cuckoo clock pops its bird for ~2 s after each accrual
// soft: bed income (a watt or two now and then while he sleeps): shorter glow, one spark, no cuckoo.
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
  $("source").textContent = st.key === "offline" ? "server unreachable" : !h ? " " : S.demo ? "demo hamster" : !S.replay ? "live from api.squeekchain.com" : S.nonstop ? "simulated · always running" : "via game server";
  $("speed").textContent = st.active && st.speed > 0 ? `${(st.speed / 1000).toFixed(2)} m/s` : "—";
  $("block").textContent = S.height != null ? S.height.toLocaleString("en-US") : "—";
  if (S.chain && typeof S.chain.blockProgress === "number") $("prog").style.width = clamp((S.chain.blockProgress / 1e9) * 100, 0, 100).toFixed(1) + "%";
  const me = S.me;
  if (me) {
    $("tier").textContent = `T${me.wheelTier} · ${(me.multPct / 100).toFixed(2)}×`;
    const goal = (S.balance && S.balance.CERT_LIFETIME_WATTS) || 500_000, days = (S.balance && S.balance.CERT_ACTIVE_DAYS) || 7;
    const pct = clamp((me.lifetimeWatts / goal) * 100, 0, 100);
    $("lifeLine").textContent = `lifetime ${fmt(me.lifetimeWatts)} W · ${pct < 10 ? pct.toFixed(1) : Math.floor(pct)}% of ${fmt(goal)} · day ${Math.min(me.activeDays, days)}/${days}`;
    $("lifeProg").style.width = pct.toFixed(2) + "%";
    renderCertHud(me);
    const watching = S.watching || me.watching;
    const bonus = Math.max(me.bonusPct || 0, (S.balance && S.balance.LIVE_BONUS_PCT) || 120) - 100; // me.bonusPct lags the first heartbeat
    const speed = Math.round((S.speedPct || 100) - 100); // he's settling blocks fast: wheel watts x speedPct
    // hidden while idle: the trailing window keeps the pct up for a few minutes after a run, but no blocks settle then
    const speedChip = speed > 0 && !S.idle ? `<span class="chip on" title="Blocks are coming fast: wheel watts +${speed}%">⚡ +${speed}%</span>` : "";
    $("watchLine").innerHTML = watching || speedChip ? `${watching ? `watching<span class="chip on">+${bonus}%</span>` : ""}${speedChip}` : "&nbsp;";
    renderBedLine(me, watching ? 100 + bonus : 100);
  }
  renderRaidChip();
  renderFeed();
  if (LB.open) renderLb(); // keeps "updated Ns ago" and the raids-left line ticking
  if (RU.open && !RU.result && raidPhase() === "spent") renderRaid(); // the reset countdown
  stepMeter(0); // paints the meter text even when rAF is throttled
  $("demo").hidden = !S.demo;
  const nb = $("night");
  if (S.night) {
    const left = Math.max(0, Math.round((S.night.endsAt - (Date.now() + S.skew)) / 1000));
    $("nightInfo").textContent = `night running · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
    nb.disabled = true;
  } else { $("nightInfo").textContent = ""; nb.disabled = false; }
}
// bed T{n} · mult; while he sleeps (by the chain) also the live rate it is paying right now
function renderBedLine(me, bonusPct) {
  const el = $("bedLine");
  const mult = (me.bedMultPct || 100) / 100;
  let html = `bed T${me.bedTier | 0} · ${mult.toFixed(2)}×`;
  if (S.idle) html += `<span class="chip on">${+((me.bedWattsPerMin || 0) * bonusPct / 100).toFixed(2)} W/min</span>`;
  el.innerHTML = html;
  el.title = S.idle ? "He's asleep, so your bed is earning" : "Your bed earns while he sleeps, online or not";
}
function stepMeter() {
  const now = performance.now();
  if (meter.target !== meter.to) { meter.from = meter.shown; meter.to = meter.target; meter.t0 = now; }
  if (meter.shown !== meter.to) {
    const k = Math.min(1, (now - meter.t0) / METER_MS), e = 1 - (1 - k) * (1 - k) * (1 - k); // ease-out cubic
    meter.shown = k >= 1 ? meter.to : Math.round(meter.from + (meter.to - meter.from) * e); // whole-watt steps
  }
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
  if (r.ok) toast("He's asleep now. Beds are earning.");
  else toast(r.j.error === "night_running" ? "A night is running. Wait for it to end." : `nap failed: ${r.j.error || r.status}`);
  refresh();
};

// ---------- hamster behaviour ----------
// RUN in the wheel while ACTIVE; SLEEP in his bed once he is asleep (the chain's idle signal, or no
// fresh reading at all); otherwise (awake, just not running) REST on the open floor by the wheel,
// blinking. Switching passes through a short SIT at that same spot, with hop/walk moves between.
const SIT_MS = 1400;
const ham = { init: false, mode: "sleep", x: SPOT.bed.x, y: SPOT.bed.y, gy: SPOT.bed.y, face: -1, move: null, sitLeft: 0, runPhase: 0, blink: 0, breath: 0 };
// The bed he sleeps in: me.bedTier's sprite standing on the bed fixture's tile (i, j); sleep = where his
// bottom-centre goes. With iso art (iso_bed_tN) its iso vertex sits on that tile's south vertex (mirrored
// when flipped); id is then the iso id, so the "_front" overlay drawn at the same origin is iso_bed_tN_front.
function bedGeom(at = null) {
  const f = at || fixture("bed"), flip = !!f.flip, c = isoTileCenter(f.i, f.j), foot = c.y + ISO.FOOT;
  const tier = clamp((S.me && S.me.bedTier) | 0, 0, 5), flat = `bed_t${tier}`;
  const s = (window.SPRITES || {})[flat];
  const w = (s && s.w) || 28, h = (s && s.h) || 10, sl = (s && s.sleep) || [w >> 1, h - 3];
  const x = Math.round(c.x - w / 2), y = foot - h;
  const geom = { id: flat, tier, flip, i: f.i, j: f.j, x, y, w, h, foot, sleepX: x + (flip ? w - sl[0] : sl[0]), sleepY: y + sl[1] };
  const is = isoArt(flat);
  if (!is) return geom;
  const o = isoOrigin(is, tileSouth(f.i, f.j), flip), isl = Array.isArray(is.sleep) ? is.sleep : null;
  return { ...geom, id: `iso_${flat}`, x: o.x, y: o.y, w: is.w, h: is.h, sleepX: isl ? o.x + (flip ? is.w - isl[0] : isl[0]) : geom.sleepX, sleepY: isl ? o.y + isl[1] : geom.sleepY };
}
function spotFor(mode) {
  if (mode === "run") return SPOT.wheel;
  if (mode === "sleep") { const b = bedGeom(); return { x: b.sleepX, y: b.sleepY }; }
  return SPOT.sit;
}
// He sleeps exactly when the server says so (S.idle: the live reading has said "not running" for 20 s,
// which is also when bed income starts and raids close) and wakes the moment the reading says he runs.
// In between, a stop he may resume from, he stands still in the wheel. With no usable reading at all
// (stale, offline) he's asleep as far as we know.
function wantMode(st) {
  if (st.active) return "run";
  if (S.idle || st.key !== "idle") return "sleep";
  return ham.mode === "sleep" ? "sleep" : "run";
}
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1;
function moveTo(name) {
  const to = spotFor(name), from = { x: ham.x, y: ham.gy };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const inWheel = near(from, SPOT.wheel), inBed = near(from, spotFor("sleep"));
  const hop = inWheel || inBed || name === "run" || name === "sleep"; // in/out of the wheel or the bed is one hop
  ham.move = { name, fx: from.x, fy: from.y, tx: to.x, ty: to.y, t: 0, dur: hop ? Math.max(650, (dist / 110) * 1000) : Math.max(500, (dist / 70) * 1000), hop, steps: Math.max(1, Math.round(dist / 14)),
    wheel: inWheel || name === "run", bed: inBed || name === "sleep" };
  if (Math.abs(to.x - from.x) > 0.5) ham.face = to.x < from.x ? -1 : 1;
  ham.mode = "move";
}
function settle(mode) { ham.mode = mode; ham.face = mode === "run" ? (fixture("wheel").flip ? -1 : 1) : mode === "sleep" ? -1 : ham.face; }
function stepHamster(dt, st) {
  const want = wantMode(st);
  if (!ham.init && S.loaded && S.me) { // first reading: start in place, no transition
    ham.init = true; const s = spotFor(want); ham.x = s.x; ham.y = ham.gy = s.y; ham.move = null; settle(want);
  }
  if (ham.mode === "move") {
    const m = ham.move;
    m.t = Math.min(m.dur, m.t + dt);
    const k = m.t / m.dur;
    ham.x = lerp(m.fx, m.tx, k);
    ham.gy = lerp(m.fy, m.ty, k);
    ham.y = ham.gy - (m.hop ? 14 * Math.sin(Math.PI * k) : 2 * Math.abs(Math.sin(Math.PI * k * m.steps)));
    ham.runPhase += dt / 1000 * 8;
    if (k >= 1) {
      ham.move = null;
      ham.y = ham.gy;
      if (m.name === "sit") { if (want === "rest") settle("rest"); else { ham.mode = "sit"; ham.sitLeft = SIT_MS; ham.face = spotFor(want).x < ham.x ? -1 : 1; } }
      else if (m.name === want) settle(want);
      else moveTo("sit");
    }
  } else if (ham.mode === "sit") {
    ham.face = spotFor(want).x < ham.x ? -1 : 1;
    ham.sitLeft -= dt;
    if (ham.sitLeft <= 0) { if (want === "rest") settle("rest"); else moveTo(want); }
  } else if (ham.mode !== want) {
    if (ham.mode === "rest") moveTo(want); // already at the sit spot
    else moveTo("sit");
  } else if (ham.mode === "run") {
    ham.x = SPOT.wheel.x; ham.y = ham.gy = SPOT.wheel.y; ham.face = fixture("wheel").flip ? -1 : 1; // the wheel may have moved
    if (st.active) ham.runPhase += (dt / 1000) * (4 + 10 * clamp(st.speed / 1600, 0, 1)); // run-cycle steps per second scale with speed (frozen while he pauses)
  } else if (ham.mode === "sleep") {
    const s = spotFor("sleep"); ham.x = s.x; ham.y = ham.gy = s.y; // a bed upgrade (or a moved bed) moves the pillow
  } else if (ham.mode === "rest" && !near({ x: ham.x, y: ham.gy }, SPOT.sit)) moveTo("sit"); // the wheel moved: walk over
}

// ---------- wheel ----------
const wheel = { rpm: 0, angle: 0 };
const MAX_VIS_RPM = 160; // keeps 6 spokes under ~16 degrees per frame so the spin never reads backwards
function stepWheel(dt, st) {
  const target = ham.mode === "run" ? clamp(st.rpm || 30, 20, MAX_VIS_RPM) : 0;
  const tau = target > wheel.rpm ? 450 : 900; // spin up quickly, coast down
  wheel.rpm += (target - wheel.rpm) * (1 - Math.exp(-dt / tau));
  if (wheel.rpm < 0.5 && target === 0) wheel.rpm = 0;
  wheel.angle = (wheel.angle + (wheel.rpm / 60000) * dt) % 1; // revolutions
}

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
  const x0 = IWHEEL.cx + Math.cos(a) * IWHEEL.r, y0 = IWHEEL.cy + Math.sin(a) * IWHEEL.r;
  const tg = meterTarget();
  sparks.push({ x0, y0, cx: x0 + (Math.random() - 0.5) * 50, cy: Math.min(y0, tg.y) - 10 - Math.random() * 30, x1: tg.x + (Math.random() - 0.5) * 10, y1: tg.y, t: -delay, life: 1100 + Math.random() * 600, pop: 0, px: x0, py: y0 });
}
function stepFx(dt, st) {
  if (st.active && ham.mode === "run") {
    sparkClock -= dt;
    if (sparkClock <= 0) { spawnSpark(); sparkClock = 650 - 300 * clamp(st.speed / 1600, 0, 1) + Math.random() * 250; }
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
    if (zClock <= 0) { zs.push({ x: ham.x + 6, y: ham.y - 18, t: 0, life: 2600 }); zClock = 1900; }
  } else zClock = 400;
  for (let i = zs.length - 1; i >= 0; i--) { zs[i].t += dt; if (zs[i].t > zs[i].life) zs.splice(i, 1); }
  stepPops(dt);
  stepRaidFx(dt);
}

// 10 fps logical sprite frames: blinks, breathing, animated-item markers
let frame10 = 0;
function tick10() {
  frame10++;
  if (ham.blink > 0) ham.blink--;
  else if ((ham.mode === "sit" || ham.mode === "rest") && Math.random() < 0.05) ham.blink = 2;
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
// The player's own size: whole steps (device pixels per art pixel) above or below the automatic size,
// remembered per browser. 0 = automatic. Never past what fits the stage, never below 1.
const ZOOM_KEY = "sd_room_zoom";
let zoomStep = clamp(parseInt(ls.get(ZOOM_KEY) || "0", 10) || 0, -8, 8), zoomNow = { s: 1, auto: 1, max: 1 };
function fit() {
  stage.style.minHeight = ""; // measure the stage at its natural size (a zoom-in may have stretched it)
  const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const scaleAt = (pad) => Math.floor(Math.min(((r.width - pad * 2) * dpr) / LW, ((r.height - pad * 2) * dpr) / LH));
  const capH = Math.floor((innerHeight * 0.7 * dpr) / LH); // the room may take at most ~70% of the window height (2x, not 3x, on 1080p)
  const fits = Math.max(1, scaleAt(12), scaleAt(0)); // drop the margin when it alone costs a whole scale step (375-px phones)
  // zooming in may go as wide as the stage (and as tall as the window); the stage then grows to hold it
  const max = Math.max(fits, Math.floor(Math.min(((r.width - 24) * dpr) / LW, ((innerHeight - 24) * dpr) / LH)));
  const auto = Math.max(1, Math.min(capH, fits)), s = clamp(auto + zoomStep, 1, max);
  zoomNow = { s, auto, max };
  if ((LH * s) / dpr + 24 > r.height) stage.style.minHeight = Math.ceil((LH * s) / dpr + 24) + "px";
  $("zoomOut").disabled = s <= 1;
  $("zoomIn").disabled = s >= max;
  $("zoomFit").hidden = s === auto;
  if (view.width !== LW * s) { view.width = LW * s; view.height = LH * s; }
  view.style.width = (LW * s) / dpr + "px";
  view.style.height = (LH * s) / dpr + "px";
}
function zoomTo(s) {
  zoomStep = s - zoomNow.auto;
  ls.set(ZOOM_KEY, String(zoomStep));
  fit();
  positionTool();
}
$("zoomIn").addEventListener("click", () => zoomTo(Math.min(zoomNow.max, zoomNow.s + 1)));
$("zoomOut").addEventListener("click", () => zoomTo(Math.max(1, zoomNow.s - 1)));
$("zoomFit").addEventListener("click", () => zoomTo(zoomNow.auto));
new ResizeObserver(() => { fit(); positionTool(); }).observe(stage);
addEventListener("resize", () => { fit(); positionTool(); });
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
// Flat rug (the certificate's floor band, and the texture the iso projection samples): 16 rows tall,
// the rug art sits on rows 3..12 (its oy) like it always has.
function drawRugFlat(p, it, x, c = g, fx = FX, fr = frame10, y = FLOOR_Y) {
  const pw = it.w * CELL;
  if (!sprite(c, it.sprite, fr, x, y, { ...fx, flip: !!p.flip, w: pw, h: 16 })) c.drawImage(placeholderItem(it, pw, 12), x, y + 2);
}

// ---------- iso painters ----------
const BACKDROP = "#1d1a14";
const inDiamond = (x, y, k = 1) => Math.abs(x + 0.5 - 16) / 16 + Math.abs(y + 0.5 - 8) / 8 <= k;
const DIAMOND = Uint8Array.from({ length: 32 * 16 }, (_, n) => (inDiamond(n % 32, Math.floor(n / 32)) ? 1 : 0));
const diamondCache = new Map();
// A 32 x 16 tile-shaped overlay: fill, 1-px rim and/or diagonal hatch (null = none). k < 1 shrinks it.
function diamondCanvas(fill, rim, hatch = null, k = 1) {
  const key = `${fill}|${rim}|${hatch}|${k}`;
  if (diamondCache.has(key)) return diamondCache.get(key);
  const c = canvas(32, 16), x = c.getContext("2d");
  for (let y = 0; y < 16; y++) for (let px = 0; px < 32; px++) {
    if (!inDiamond(px, y, k)) continue;
    const edge = !inDiamond(px - 1, y, k) || !inDiamond(px + 1, y, k) || !inDiamond(px, y - 1, k) || !inDiamond(px, y + 1, k);
    const col = edge && rim ? rim : hatch && (px + 2 * y) % 6 < 2 ? hatch : fill;
    if (col) { x.fillStyle = col; x.fillRect(px, y, 1, 1); }
  }
  diamondCache.set(key, c);
  return c;
}
const drawTileOverlay = (c, i, j, img) => { const t = isoTileTop(i, j); c.drawImage(img, t.x, t.y); };
const matTier = () => clamp((S.me && S.me.roomTier) | 0, 0, 5);
function matEdge(t) { const s = (window.SPRITES || {})[`floor_mat_t${t}`]; return ((s && s.edge) || [2, 13, 14]).map((i) => PALETTE[i] || "#888888"); }
// 16 x 16 swatch canvas of a wallpaper / flooring style (sprite, or the flat painter's top-left corner)
function swatch(id, kind) {
  const c = canvas(16, 16), x = c.getContext("2d");
  if (!sprite(x, id, 0, 0, 0, {})) x.drawImage(kind === "floor" ? floorCanvas(id) : wallpaperCanvas(id), 0, kind === "floor" ? 1 : 2, 16, 16, 0, 0, 16, 16);
  return c;
}
function rgbaOf(c) { return c.getContext("2d").getImageData(0, 0, c.width, c.height).data; }

// The static room: backdrop, folded walls (wallpaper above, material wainscot below, cap, end posts),
// floor tiles (material lanes + border ring, the equipped flooring inside), the slab. Cached per look.
const roomBaseCache = { key: null, canvas: null };
function roomBase(me) {
  const wp = (me && me.wallpaper) || "wp_plain", fl = (me && me.floor) || "fl_straw", t = matTier();
  const key = `${wp}|${fl}|${t}|${hasSprite(wp)}|${hasSprite(fl)}|${hasSprite(`floor_mat_t${t}`)}`;
  if (roomBaseCache.key === key) return roomBaseCache.canvas;
  const c = roomBaseCache.canvas || canvas(LW, LH), x = c.getContext("2d");
  x.clearRect(0, 0, LW, LH);
  paintRoomBase(x, wp, fl, t);
  roomBaseCache.key = key;
  roomBaseCache.canvas = c;
  return c;
}
// The walls' top edge is a burrow arch, not the V of a box: a parabola from the corner's top that
// meets the strip's top again at both cut ends. It only adds wall above the strip (the strip itself,
// so wall decor and its rows, is unchanged).
function archTop(px) {
  const end = px < ISO.X0 ? WALL_X0 : WALL_X1 - 1, f = (px - ISO.X0) / (end - ISO.X0);
  return Math.round(stripTop(ISO.X0) + (stripTop(end) - stripTop(ISO.X0)) * f * f);
}
let ARCH_EX = 0;
for (let px = WALL_X0; px < WALL_X1; px++) ARCH_EX = Math.max(ARCH_EX, stripTop(px) - archTop(px));
function paintRoomBase(c, wp, fl, t) {
  const [hi, mid, lo] = matEdge(t), H = ISO.WALL_H, HT = H + ARCH_EX;
  c.fillStyle = BACKDROP; c.fillRect(0, 0, LW, LH);
  // walls, flat: wallpaper tiled up from the floor line (seams meet the corner) all the way down to a
  // short baseboard in the den material (the bottom BASE rows of its wall panel); the strip runs
  // ARCH_EX rows taller so the arch above the old top has wallpaper too
  const BASE = 7;
  const strip = canvas(LW, HT), s = strip.getContext("2d"), sw = swatch(wp, "wallpaper");
  for (let y = HT - 16; y > -16; y -= 16) for (let px = WALL_X0; px < WALL_X1; px += 16) s.drawImage(sw, px, y);
  const panel = canvas(16, 32), pc = panel.getContext("2d");
  if (!sprite(pc, `wall_mat_t${t}`, 0, 0, 0, {})) { pc.fillStyle = mid; pc.fillRect(0, 0, 16, 32); pc.fillStyle = lo; pc.fillRect(0, 0, 1, 32); }
  for (let px = WALL_X0; px < WALL_X1; px += 16) s.drawImage(panel, 0, 32 - BASE, 16, BASE, px, HT - BASE, 16, BASE);
  s.fillStyle = hi; s.fillRect(WALL_X0, HT - BASE, WALL_X1 - WALL_X0, 1); // the baseboard's lit top edge
  s.fillStyle = "rgba(0,0,0,.18)"; s.fillRect(WALL_X0, HT - BASE - 1, WALL_X1 - WALL_X0, 1); // and its shadow on the wallpaper
  // fold onto the two back walls from the arch down, cap along the arch; the shade deepens smoothly
  // round the corner (light from the left), so the corner reads as a curved burrow wall, not a fold
  for (let px = WALL_X0; px < WALL_X1; px++) {
    const top = archTop(px), len = wallBase(px) - top;
    c.drawImage(strip, px, HT - len, 1, len, px, top, 1, len);
    c.fillStyle = hi; c.fillRect(px, top, 1, 1);
    c.fillStyle = mid; c.fillRect(px, top + 1, 1, 1);
    c.fillStyle = "rgba(0,0,0,.3)"; c.fillRect(px, top + 2, 1, 1);
    const k = clamp((px - ISO.X0) / 48 + 0.5, 0, 1);
    c.fillStyle = `rgba(0,0,0,${(0.13 * k * k * (3 - 2 * k)).toFixed(3)})`; c.fillRect(px, top, 1, len);
  }
  // end posts in the material (the walls' cut ends)
  for (const [px, col] of [[WALL_X0, lo], [WALL_X0 + 1, mid], [WALL_X1 - 2, mid], [WALL_X1 - 1, lo]]) { c.fillStyle = col; c.fillRect(px, archTop(px), 1, wallBase(px) - archTop(px)); }
  paintFloor(c, fl, t, [hi, mid, lo]);
}
function paintFloor(c, fl, t, [hi, mid, lo]) {
  const img = c.getImageData(0, 0, LW, LH), d = img.data;
  const flTex = rgbaOf(swatch(fl, "floor")); // the equipped flooring covers every tile
  const bottom = new Int16Array(LW).fill(-1);
  for (let j = 0; j < ISO.NJ; j++) for (let i = 0; i < ISO.NI; i++) {
    const o = isoTileTop(i, j);
    for (let ly = 0; ly < 16; ly++) for (let lx = 0; lx < 32; lx++) {
      if (!DIAMOND[ly * 32 + lx]) continue;
      const X = o.x + lx, Y = o.y + ly;
      if (X < 0 || X >= LW || Y < 0) continue;
      if (Y > bottom[X]) bottom[X] = Y;
      if (Y >= LH) continue;
      // the flooring swatch on the half-texel iso lattice (2:1 lines stay 2 px per row)
      const u = clamp(Math.floor((lx + 2 * ly - 15) / 2), 0, 15), v = clamp(Math.floor((2 * ly - lx + 16) / 2), 0, 15);
      const k = (v * 16 + u) * 4, q = (Y * LW + X) * 4;
      if (!flTex[k + 3]) continue;
      d[q] = flTex[k]; d[q + 1] = flTex[k + 1]; d[q + 2] = flTex[k + 2]; d[q + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  // slab under the two front edges, in the den material (with the baseboard, the wall cap and the
  // end posts, the trim that shows the den's upgrade)
  const front = ISO.X0 + (ISO.NI - ISO.NJ) * 16; // the floor's front vertex
  for (let X = WALL_X0; X < WALL_X1; X++) {
    if (bottom[X] < 0) continue;
    for (let k = 1; k <= ISO.SLAB; k++) {
      c.fillStyle = k === ISO.SLAB ? OUTLINE : k === 1 ? hi : X < front ? mid : lo;
      c.fillRect(X, bottom[X] + k, 1, 1);
    }
  }
  // contact shadow where the walls meet the floor
  for (let X = WALL_X0; X < WALL_X1; X++) { c.fillStyle = "rgba(0,0,0,.24)"; c.fillRect(X, wallBase(X), 1, 1); c.fillStyle = "rgba(0,0,0,.1)"; c.fillRect(X, wallBase(X) + 1, 1, 1); }
}

// Wall layer: paint(ctx) draws in flat strip coordinates (x = screen x, y = strip row), then the
// columns x0..x1 fold onto the walls. Used for wall decor and for the wall placement overlays.
const wallLayer = canvas(LW, ISO.WALL_H), wl = wallLayer.getContext("2d");
function foldLayer(paint, x0 = WALL_X0, x1 = WALL_X1, c = g) {
  wl.clearRect(0, 0, LW, ISO.WALL_H);
  paint(wl);
  for (let px = Math.max(WALL_X0, Math.floor(x0)); px < Math.min(WALL_X1, Math.ceil(x1)); px++) c.drawImage(wallLayer, px, 0, 1, ISO.WALL_H, px, stripTop(px), 1, ISO.WALL_H);
}

// Floor furniture and rugs stand on floor tiles (same rules as server.js footprint()): placement
// (x, y) = (i, j) is the BACK tile of a w-tile chain along i (flip false: parallel to the right wall,
// the iso art's canonical SW face) or along j (flip true: parallel to the left wall, mirrored). Rugs
// lie RUG_DEPTH tiles deep across the chain.
const RUG_DEPTH = 2;
function footprint(it, i, j, flip) {
  const out = [], deep = it.zone === "rug" ? RUG_DEPTH : 1;
  for (let a = 0; a < it.w; a++) for (let d = 0; d < deep; d++) out.push(flip ? [i + d, j + a] : [i + a, j + d]);
  return out;
}
const tileOnFloor = ([i, j]) => i >= 0 && j >= 0 && i < ROOM.ISO_NI && j < ROOM.ISO_NJ && i + j <= ROOM.FIX_MAX_SUM;
function tilesBox(tiles) { // screen box around a set of floor tiles
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [i, j] of tiles) { const o = isoTileTop(i, j); x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + 32); y1 = Math.max(y1, o.y + 16); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// A screen point in a rug's own terms: s along its chain (0..w), d across it (0..RUG_DEPTH).
function rugAt(p, px, py) {
  const [fi, fj] = screenToTile(px, py);
  return p.flip ? { s: fj - p.y, d: fi - p.x } : { s: fi - p.x, d: fj - p.y };
}
// Rugs lie flat on their tiles: texel column u -> s = u/16 along the chain, texel row v -> d = v/8
// across it (the rug art's rows 3..12 cover d 0.4..1.6). Each screen pixel maps back through rugAt().
const rugCache = new Map();
function rugProjection(p, it) {
  const key = `${it.id}|${p.x}|${p.y}|${p.flip ? 1 : 0}|${hasSprite(it.sprite)}`;
  if (rugCache.has(key)) return rugCache.get(key);
  const pw = it.w * CELL, src = canvas(pw, 16);
  drawRugFlat(p, it, 0, src.getContext("2d"), FX, 0, 0);
  const tex = rgbaOf(src), box = tilesBox(footprint(it, p.x, p.y, p.flip)), out = canvas(Math.max(1, box.w), Math.max(1, box.h)), oc = out.getContext("2d");
  const img = oc.createImageData(out.width, out.height), d = img.data;
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const l = rugAt(p, box.x + x + 0.5, box.y + y + 0.5);
    if (l.s < 0 || l.s >= it.w || l.d < 0 || l.d >= RUG_DEPTH) continue;
    const u = Math.floor(l.s * 16), v = Math.floor(l.d * 8), k = (v * pw + u) * 4;
    if (!tex[k + 3]) continue;
    const q = (y * out.width + x) * 4;
    d[q] = tex[k]; d[q + 1] = tex[k + 1]; d[q + 2] = tex[k + 2]; d[q + 3] = 255;
  }
  oc.putImageData(img, 0, 0);
  const r = { canvas: out, x: box.x, y: box.y };
  if (rugCache.size > 200) rugCache.clear();
  rugCache.set(key, r);
  return r;
}
function rugHit(p, it, L) {
  const l = rugAt(p, L.x, L.y);
  return l.s >= 0 && l.s < it.w && l.d >= 0 && l.d < RUG_DEPTH;
}

function render(st) {
  const me = S.me;
  fxOpts(st);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  // 1. back walls + floor (cached per wallpaper / flooring / room material)
  g.drawImage(roomBase(me), 0, 0);
  // 2. wall decor, painted flat then folded onto the walls
  const walls = itemsIn("wall").sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x);
  if (walls.length) {
    let x0 = Infinity, x1 = -Infinity;
    for (const [p, it] of walls) { x0 = Math.min(x0, colLeft(p.x)); x1 = Math.max(x1, colLeft(p.x) + it.w * CELL); }
    foldLayer((s) => { for (const [p, it] of walls) drawItem(p, it, colLeft(p.x), wallRowY(p.y), it.w * CELL, it.h * CELL, s); }, x0, x1);
  }
  // 3. rugs, flat on their lanes
  for (const [p, it] of itemsIn("rug").sort((a, b) => a[0].x - b[0].x)) { const r = rugProjection(p, it); g.drawImage(r.canvas, r.x, r.y); }
  // 4. everything standing on tiles: furniture, burrow, wheel, bed, hamster, back to front
  drawStanding(me);
  // 5. watt sparks + sleep Zs
  drawFx();
  // 6. day/night tint, IDLE dim + a warm glow over the bed
  const t = tintAt(utcHour());
  g.globalCompositeOperation = "multiply";
  g.fillStyle = `rgb(${t.mul.join(",")})`; g.fillRect(0, 0, LW, LH);
  if (dimLevel > 0.01) { const v = Math.round(255 - 46 * dimLevel); g.fillStyle = `rgb(${v},${v},${Math.round(255 - 30 * dimLevel)})`; g.fillRect(0, 0, LW, LH); }
  g.globalCompositeOperation = "source-over";
  g.fillStyle = `rgba(${t.haze[0]},${t.haze[1]},${t.haze[2]},${t.haze[3].toFixed(3)})`; g.fillRect(0, 0, LW, LH);
  if (dimLevel > 0.01) {
    g.globalCompositeOperation = "lighter";
    const breathe = 0.85 + 0.15 * Math.sin(performance.now() / 900), gx = SPOT.bed.x, gy = SPOT.bed.y - 10;
    const grd = g.createRadialGradient(gx, gy, 2, gx, gy, 46);
    grd.addColorStop(0, `rgba(255,170,70,${(0.32 * dimLevel * breathe).toFixed(3)})`);
    grd.addColorStop(1, "rgba(255,170,70,0)");
    g.fillStyle = grd; g.fillRect(gx - 50, gy - 50, 100, 100);
    g.globalCompositeOperation = "source-over";
  }
  // 6b. raid fx (embers, flashes) over the tint so they glow at night
  drawRaidFx();
  // 6c. "+N W" / "-N W" popups, untinted so they read at night
  drawPops();
  // 7. placement ghost, zone guides, selection outline (after the tint so they read at night)
  drawPlacement();
  // present: integer-scaled, no smoothing
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(buf, 0, 0, view.width, view.height);
}
// ---------- dimetric art ("iso_" + id) ----------
// An iso sprite is a SPRITES entry with iso: { ax, ay } = the south (lowest) vertex of its base
// footprint, as a lattice POINT in sprite pixels (the corner between pixels, like isoTileCenter's
// south vertex): a lone 32 x 16 tile diamond drawn at the sprite's origin has ax 16, ay 16 (its
// 2-px bottom tip is pixels 15..16 of row 15). Canonical art faces SW with its tile chain running
// down-right (as it stands on the right wall); mirrored (flip) it faces SE with the chain running
// down-left (the left wall), and the mirrored vertex sits at w - ax. No ox/oy on iso art.
// Anything without iso art (or straddling the corner) stays a billboard.
function isoArt(id) { const s = (window.SPRITES || {})["iso_" + id]; return s && s.iso && s.w && hasSprite("iso_" + id) ? s : null; }
function tileSouth(i, j) { const c = isoTileCenter(i, j); return { x: c.x, y: c.y + 8 }; }
function isoOrigin(s, S, flip) { return { x: S.x - (flip ? s.w - s.iso.ax : s.iso.ax), y: S.y - s.iso.ay }; }
// iso art of `id` standing on lane columns x..x+w-1, anchored on the nearest (lowest) of them: right
// wall unflipped, left wall mirrored; a 1-wide item honours its own flip. null -> billboard.
// d: painter's key = the ground line of its BACK-most tile (not the billboard's mean): a long block
// hugging the wall is behind anything standing a row in front of any of its tiles; along one wall
// the order of lane items is unchanged.
function isoSpan(id, x, w, flip) {
  const s = isoArt(id);
  if (!s || (x <= ISO.CORNER && x + w - 1 > ISO.CORNER)) return null;
  const right = x > ISO.CORNER, f = w === 1 ? !!flip : !right;
  const [i, j] = colTile(right ? x + w - 1 : x), o = isoOrigin(s, tileSouth(i, j), f);
  return { id: "iso_" + id, flip: f, x: o.x, y: o.y, w: s.w, h: s.h, d: footY(right ? x : x + w - 1, 1) };
}
// A floor item on tile (i, j) (its back tile; see footprint()): its iso art anchored on the south
// vertex of its FRONT tile (mirrored when flipped), else a billboard standing on that tile.
// d: painter's key = the ground line of its back tile, so anything a row in front of any of its
// tiles draws over it.
function floorGeom(it, i, j, flip) {
  const f = !!flip, front = f ? [i, j + it.w - 1] : [i + it.w - 1, j], d = isoTileCenter(i, j).y + ISO.FOOT;
  const s = isoArt(it.id);
  if (s) { const o = isoOrigin(s, tileSouth(front[0], front[1]), f); return { art: { id: "iso_" + it.id, flip: f }, x: o.x, y: o.y, w: s.w, h: s.h, d }; }
  const c = isoTileCenter(front[0], front[1]), pw = it.w * CELL, ph = it.h * CELL;
  return { art: null, x: Math.round(c.x - pw / 2), y: c.y + ISO.FOOT - ph, w: pw, h: ph, d };
}
function drawFloorItem(p, it, c = g) {
  const G = floorGeom(it, p.x, p.y, p.flip);
  if (G.art && sprite(c, G.art.id, frame10, G.x, G.y, { ...FX, flip: G.art.flip })) return;
  drawItem(p, it, G.x, G.y, G.w, G.h, c);
}
function drawBurrow() {
  const [ba, bb] = ROOM.RESERVED.burrow, a = isoSpan("burrow", ba, bb - ba + 1, false);
  if (a && sprite(g, a.id, frame10, a.x, a.y, { flip: a.flip })) return;
  if (!sprite(g, "burrow", frame10, IBURROW.x, IBURROW.y, {})) g.drawImage(burrowCanvas(), IBURROW.x, IBURROW.y);
}

// Billboards: every front-facing sprite stands bottom-centre on its tiles. Painter's order is the
// ground line (screen y of the feet = iso depth i + j), then x. Contact shadows go down first.
// Iso art stands on the same tiles and sorts by the same ground line.
const SHADOW = () => diamondCanvas("rgba(0,0,0,.2)", null, null, 0.72);
function drawStanding(me) {
  const list = [];
  for (const [p, it] of itemsIn("floor")) {
    for (const [i, j] of footprint(it, p.x, p.y, p.flip)) drawTileOverlay(g, i, j, SHADOW());
    const G = floorGeom(it, p.x, p.y, p.flip);
    list.push({ d: G.d, x: G.x, draw: () => drawFloorItem(p, it) });
  }
  if (IBURROW) {
    const [ba, bb] = ROOM.RESERVED.burrow, ab = isoSpan("burrow", ba, bb - ba + 1, false);
    list.push({ d: ab ? ab.d : IBURROW.foot, x: IBURROW.x, draw: drawBurrow });
  }
  const m = ham.mode === "move" ? ham.move : null;
  const hamInWheel = ham.mode === "run" || (m && m.wheel), hamInBed = ham.mode === "sleep" || (m && m.bed);
  const moving = P.mode === "move" ? fixOf(P.pid) : null; // a fixture being moved fades in place
  const wf = fixture("wheel");
  drawTileOverlay(g, wf.i, wf.j, SHADOW());
  list.push({ d: IWHEEL.foot, x: IWHEEL.x, draw: () => drawWheel(wf.i, wf.j, !!wf.flip, (me && me.wheelTier) | 0, hamInWheel, moving === "wheel" ? 0.35 : 1) });
  const b = bedGeom();
  drawTileOverlay(g, b.i, b.j, SHADOW());
  list.push({ d: b.foot, x: b.x, draw: () => drawBed(b, hamInBed, moving === "bed" ? 0.35 : 1) });
  if (!hamInWheel && !hamInBed) {
    g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(Math.round(ham.x) - 6, Math.round(ham.gy) - 1, 12, 2); // his own little shadow
    list.push({ d: ham.gy, x: ham.x, draw: drawHamster });
  }
  list.sort((a, c) => a.d - c.d || a.x - c.x);
  for (const e of list) e.draw();
}
// the wheel on tile (i, j): back layer, the running hamster, front layer (3D), or the old billboard
function drawWheel(i, j, flip, tier, withHam = false, alpha = 1, c = g) {
  c.globalAlpha = alpha;
  const w = IW();
  if (w) {
    const so = tileSouth(i, j), o = { angle: wheel.angle, tier, flip, t: performance.now() };
    w.draw(c, "back", so.x, so.y, o);
    if (withHam) drawHamster();
    w.draw(c, "front", so.x, so.y, o);
  } else {
    const B = wheelAt(i, j, flip).box, W = { cx: B.x + 24, cy: B.y + 24, r: 23, x: B.x, y: B.y };
    if (sprite(c, "wheel", Math.floor(wheel.angle * 24) % 4, W.x, W.y, { angle: wheel.angle, tier })) {
      if (tier > 0) sprite(c, `wheel_t${tier}`, frame10, W.x, W.y, { angle: wheel.angle, tier });
    } else drawWheelPlaceholder(c, wheel.angle, tier, W);
    if (withHam) drawHamster();
  }
  c.globalAlpha = 1;
}
function drawBed(b, withHam = false, alpha = 1, c = g) {
  c.globalAlpha = alpha;
  if (!sprite(c, b.id, frame10, b.x, b.y, { flip: b.flip })) c.drawImage(placeholderItem({ id: b.id, name: "bed" }, b.w, b.h), b.x, b.y);
  if (withHam) { drawHamster(); if (ham.mode === "sleep") sprite(c, `${b.id}_front`, frame10, b.x, b.y, { flip: b.flip }); } // iso: iso_bed_tN_front, same origin
  c.globalAlpha = 1;
}
function fixtureRect(k, i, j, flip) {
  if (k === "wheel") return wheelAt(i, j, flip).box;
  const b = bedGeom({ i, j, flip });
  return { x: b.x, y: b.y, w: b.w, h: b.h };
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

// ---------- earn popups: "+N W" floats at the income source, "-N W" when someone raids me ----------
// Earned = growth of me.lifetimeWatts, which the server only moves through creditWatts() (wheel blocks
// and bed time). Purchases and raid transfers move me.watts alone, so they can never pop here; raids
// keep their own fx (sparks/embers/flash, the raid result card). A high-water mark makes it monotonic,
// so an out-of-order response (a stale poll landing after a buy reply) can't pop the same watts twice.
// Pool: POP_N fixed slots, each with its own small canvas, text rasterised once per spawn (3x5 FONT,
// 1px OUTLINE ring); the frame loop only blits, so nothing allocates at 60 fps.
const POP_N = 6, POP_CW = 84, POP_CH = 14;
const pops = Array.from({ length: POP_N }, () => ({ on: false, c: null, w: 0, h: 0, x: 0, y: 0, t: 0, life: 0, rise: 0, kind: "", n: 0 }));
const earnMark = { pid: null, hw: -1, poll: false };
// compact amounts: the 3x5 font has no comma ("12.3K", "1.2M")
function popAmt(n) {
  n = Math.max(0, Math.round(n));
  if (n < 10_000) return String(n);
  const [d, s] = n < 1e6 ? [1e3, "K"] : [1e6, "M"], v = n / d;
  return (v < 100 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.floor(v))) + s;
}
function rasterPop(p, str, color, sc) {
  if (!p.c) { p.c = document.createElement("canvas"); p.c.width = POP_CW; p.c.height = POP_CH; }
  const c = p.c.getContext("2d");
  c.clearRect(0, 0, POP_CW, POP_CH);
  p.w = Math.min(POP_CW, (str.length * 4 - 1) * sc + 2); p.h = 5 * sc + 2;
  for (let pass = 0; pass < 2; pass++) { // 0: outline ring, 1: fill
    c.fillStyle = pass ? color : OUTLINE;
    let cx = 1;
    for (const ch of str) {
      const gl = FONT[ch] || FONT["?"];
      for (let r = 0; r < 5; r++) for (let b = 0; b < 3; b++) {
        if (!(gl[r] & (4 >> b))) continue;
        const x = cx + b * sc, y = 1 + r * sc;
        if (pass) c.fillRect(x, y, sc, sc); else c.fillRect(x - 1, y - 1, sc + 2, sc + 2);
      }
      cx += 4 * sc;
    }
  }
}
// kind: "earn" (yellow, at the wheel or bed), "pip" (bare "+" trickle while he sleeps), "hit" (red, top centre)
function spawnPop(kind, n = 0) {
  let p = null;
  for (const q of pops) if (q.on && q.kind === kind && kind !== "pip" && q.t < 250) { p = q; n += q.n; break; } // same poll burst: one popup
  if (!p) for (const q of pops) if (!q.on) { p = q; break; }
  if (!p) { p = pops[0]; for (const q of pops) if (q.t > p.t) p = q; } // all busy: recycle the oldest
  const asleep = S.idle;
  let x, y, str, color = "#ffd166", sc = 1, rise = 18, life = 1200;
  if (kind === "hit") {
    str = `-${popAmt(n)} W`; color = "#ff5a5a"; sc = 2; x = LW / 2; y = 26; rise = 14; life = 1600;
  } else {
    const at = asleep ? SPOT.bed : SPOT.wheel;
    x = at.x + (asleep ? -8 : 0); // left of the bed: the sleep Zs drift off to the right
    y = asleep ? at.y - 30 : IWHEEL.cy - 6;
    if (kind === "pip") { str = "+"; rise = 10; life = 900; }
    else { str = `+${popAmt(n)} W`; sc = n >= 100 ? 2 : 1; } // big wheel paydays read bigger
  }
  if (!p.on || p.kind !== kind || p.t >= 250) { p.x = x; p.y = y; p.t = 0; } // a merged burst keeps flying from where it is
  p.on = true; p.kind = kind; p.n = n; p.rise = rise; p.life = life;
  rasterPop(p, str, color, sc);
}
// called from applyMe on every server copy of `me`
function noteEarn(me, prev, first) {
  const pid = me.publicId || null, lw = Number(me.lifetimeWatts) || 0;
  if (first || !prev || pid !== earnMark.pid || earnMark.hw < 0) { earnMark.pid = pid; earnMark.hw = lw; return; } // first sight / other room: baseline
  if (lw <= earnMark.hw) return;
  const d = lw - earnMark.hw;
  earnMark.hw = lw;
  earnMark.poll = true;
  spawnPop("earn", d); // whole watts from the server, so a 1 W bed trickle still shows "+1 W"
}
// a poll that saw no new watts while the bed is paying (it carries fractions server-side): a bare "+"
function noteTrickle() {
  if (!earnMark.poll && S.idle && S.me && (S.me.bedWattsPerMin || 0) > 0) spawnPop("pip");
  earnMark.poll = false;
}
function stepPops(dt) {
  for (const p of pops) if (p.on && (p.t += dt) >= p.life) p.on = false;
}
function drawPops() {
  for (const p of pops) {
    if (!p.on) continue;
    const k = p.t / p.life, e = 1 - (1 - k) * (1 - k) * (1 - k);
    const a = k < 0.08 ? k / 0.08 : k > 0.6 ? (1 - k) / 0.4 : 1;
    const pop = k < 0.12 ? Math.round(2 * (1 - k / 0.12)) : 0; // springs up from 2px low
    const x = clamp(Math.round(p.x - p.w / 2), 1, LW - p.w - 1), y = Math.max(1, Math.round(p.y - p.h + pop - p.rise * e));
    g.globalAlpha = clamp(a, 0, 1) * (p.kind === "pip" ? 0.85 : 1);
    g.drawImage(p.c, 0, 0, p.w, p.h, x, y, p.w, p.h);
  }
  g.globalAlpha = 1;
}

// ---------- main loop: one rAF, fixed steps (60 fps easing/fx, 10 fps sprite frames) ----------
const STEP = 1000 / 60, STEP10 = 100;
let last = performance.now(), acc = 0, acc10 = 0, hudClock = 0;
function step(dt) {
  const st = liveStatus();
  stepHamster(dt, st);
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
function findPlaced(pid) {
  const k = fixOf(pid);
  if (k) { if (!S.me) return null; const f = fixture(k); return { pid, item: FIX_ITEM[k].id, x: f.i, y: f.j, flip: !!f.flip, fixture: k }; }
  return (pid && S.me && S.me.placed.find((p) => p.pid === pid)) || null;
}
const itemOf = (p) => (p && p.fixture ? FIX_ITEM[p.fixture] : p && S.catalog.get(p.item));
const unplaced = (id) => (S.me ? (S.me.owned[id] || 0) - S.me.placed.filter((p) => p.item === id).length : 0);
// Where an item at server cell (x, y) shows on screen (iso logical pixels). Floor: its iso sprite's
// box, else its billboard box. Rug: the box around its tiles. Wall: the bounding box of the folded
// rect (wallRect is the same rect in flat strip coordinates).
const wallRect = (it, x, y) => ({ x: colLeft(x), y: wallRowY(y), w: it.w * CELL, h: it.h * CELL });
function isoRect(it, x, y, flip = false) {
  if (it.zone === "fixture") return fixtureRect(it.fixture, x, y, flip);
  if (it.zone === "wall") {
    const f = wallRect(it, x, y);
    let top = Infinity, bot = -Infinity;
    for (let px = f.x; px < f.x + f.w; px++) { const t = stripTop(clamp(px, WALL_X0, WALL_X1 - 1)) + f.y; top = Math.min(top, t); bot = Math.max(bot, t + f.h); }
    return { x: f.x, y: top, w: f.w, h: bot - top };
  }
  if (it.zone === "rug") return tilesBox(footprint(it, x, y, flip));
  const G = floorGeom(it, x, y, flip);
  return { x: G.x, y: G.y, w: G.w, h: G.h };
}
// Same checks, same order as server.js validatePlacement(); the server re-validates every move.
function checkSpot(it, x, y, ignorePid = null, flip = false) {
  const me = S.me;
  if (!it || !it.zone) return { ok: false, error: "not_placeable" };
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, error: "bad_coords" };
  const others = ((me && me.placed) || []).filter((p) => p.pid !== ignorePid);
  if (others.filter((p) => p.item === it.id).length >= ((me && me.owned[it.id]) || 0)) return { ok: false, error: "unowned" };
  if (it.zone === "wall") {
    if (x < 0 || x + it.w > ROOM.COLS || y < ROOM.WALL_TOP || y + it.h - 1 > ROOM.WALL_BOTTOM) return { ok: false, error: "out_of_bounds" };
    for (const o of others) {
      const oi = S.catalog.get(o.item);
      if (oi && oi.zone === "wall" && span(x, it.w, o.x, oi.w) && span(y, it.h, o.y, oi.h)) return { ok: false, error: "overlap", with: oi };
    }
    return { ok: true };
  }
  const tiles = footprint(it, x, y, flip);
  if (!tiles.every(tileOnFloor)) return { ok: false, error: "out_of_bounds" };
  const mine = new Set(tiles.map(([i, j]) => i * 100 + j));
  for (const o of others) {
    const oi = S.catalog.get(o.item);
    if (oi && oi.zone === it.zone && footprint(oi, o.x, o.y, o.flip).some(([i, j]) => mine.has(i * 100 + j))) return { ok: false, error: "overlap", with: oi };
  }
  if (it.zone === "floor") for (const k of ["wheel", "bed"]) { const f = fixture(k); if (mine.has(f.i * 100 + f.j)) return { ok: false, error: "fixture", which: k }; }
  return { ok: true };
}
// Server error codes in words.
function errorWords(j, ctx = {}) {
  const e = (j && j.error) || "network";
  switch (e) {
    case "poor": return `Need ${fmt(j.need || 0)} more watts`;
    case "wrong_tier": {
      const it = ctx.it, prev = it && it.tier ? `T${it.tier - 1}` : "";
      if (it && it.cat === "bed") return prev ? `Get the ${prev} bed first` : "Beds go in order";
      if (it && it.cat === "room") return prev ? `Build the ${prev} den first` : "Den materials go in order";
      return prev ? `Install the ${prev} wheel upgrade first` : "Wheel upgrades go in order";
    }
    case "already_owned": {
      const cat = ctx.it && ctx.it.cat;
      return cat === "wheel" ? "Your wheel already has that" : cat === "bed" ? "Your bed is already that good" : cat === "room" ? "Your den is already built of that (or better)" : "You already own that";
    }
    case "fixture": return `The ${ctx.which || j.which || "wheel"} is there`;
    case "occupied": { const w = ctx.with || (j.with && S.catalog.get(j.with)); return w ? `The ${w.name} is there` : "Something is already there"; }
    case "too_close": return ctx.which === "bed" ? "Too close to the wheel" : "Too close to the bed";
    case "bad_fixture": return "That can't move";
    case "overlap": return ctx.with ? `The ${ctx.with.name} is already there` : "Something is already there";
    case "out_of_bounds": case "oob": return ctx.it && ctx.it.zone === "wall" ? "Wall decor goes on the wall" : ctx.it && ctx.it.zone === "fixture" ? "Keep it on the open floor" : "Doesn't fit there";
    case "unowned": return "None left. Buy another in the shop";
    case "bad_coords": return "Pick a spot inside the den";
    case "unknown_pid": return "That was already moved or removed";
    case "unknown_item": case "not_placeable": return "That isn't in the shop";
    case "bad_token": case "unknown_player": return "Your den is still loading";
    case "network": return "Can't reach the server";
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
// Screen (iso) point -> the flat-room point the placement maths (and the server) speak. Floor + rugs:
// screen -> the tile under the pointer -> its lane column (inverse of colTile), as that column's
// centre. Wall: unfold the wall (strip coordinates), then rows count from the top like the flat wall.
function toFlat(L, zone) {
  if (zone !== "wall") return { x: L.x, y: L.y }; // the floor speaks tiles: keep the screen point
  if (zone === "wall") {
    const px = clamp(Math.floor(L.x), WALL_X0, WALL_X1 - 1);
    return { x: L.x - colLeft(0), y: L.y - stripTop(px) - wallRowY(0) };
  }
}
function fixtureCell(x, y) { // screen point -> the floor tile under it, clamped onto the floor
  const [i, j] = screenToTile(x, y);
  return { x: clamp(Math.floor(i), 0, ROOM.ISO_NI - 1), y: clamp(Math.floor(j), 0, ROOM.ISO_NJ - 1) };
}
function floorCell(it, fi, fj, flip) { // tile under the pointer -> back tile, the chain centred on it
  const back = Math.floor((it.w - 1) / 2), along = flip ? [0, back] : [back, 0];
  return { x: clamp(Math.floor(fi) - along[0], 0, ROOM.ISO_NI - 1), y: clamp(Math.floor(fj) - along[1], 0, ROOM.ISO_NJ - 1) };
}
function cellAt(it, Ls) { // the ghost is centred on the pointer and clamped into its zone
  if (it.zone === "fixture") return fixtureCell(Ls.x, Ls.y);
  if (it.zone !== "wall") { const [fi, fj] = screenToTile(Ls.x, Ls.y); return floorCell(it, fi, fj, P.flip); }
  const L = toFlat(Ls, it.zone);
  const x = clamp(Math.round(L.x / CELL - it.w / 2), 0, ROOM.COLS - it.w);
  const [y0, y1] = wallYRange(it);
  return { x, y: clamp(Math.round(L.y / CELL - it.h / 2), y0, y1) };
}
function dragCell(Ls) { // dragging keeps the grab offset: the item moves by whole cells (d.lx/ly: flat press point)
  const d = P.drag, it = P.it, L = toFlat(Ls, it.zone);
  if (it.zone !== "wall") { // floor: the back tile follows the pointer by whole tiles
    const c = isoTileCenter(d.x0, d.y0), x = c.x + L.x - d.lx, y = c.y + L.y - d.ly;
    if (it.zone === "fixture") return fixtureCell(x, y);
    const [fi, fj] = screenToTile(x, y);
    return { x: clamp(Math.floor(fi), 0, ROOM.ISO_NI - 1), y: clamp(Math.floor(fj), 0, ROOM.ISO_NJ - 1) };
  }
  const x = clamp(d.x0 + Math.round((L.x - d.lx) / CELL), 0, ROOM.COLS - it.w);
  const [y0, y1] = wallYRange(it);
  return { x, y: clamp(d.y0 + Math.round((L.y - d.ly) / CELL), y0, y1) };
}
function updateGhost(L) {
  if (!P.mode) return;
  if (!L.inside && !P.drag) { if (P.cell) { P.cell = null; P.valid = null; renderPlacing(); } return; }
  // auto-facing until the player flips by hand: floor items nearer the left wall run along it (and
  // face into the room); wall decor on the left half mirrors
  const flip0 = P.flip;
  if (P.mode === "place" && !P.userFlip) {
    if (P.it.zone === "floor" || P.it.zone === "rug") { const [fi, fj] = screenToTile(L.x, L.y); P.flip = fi < fj; }
    else if (P.it.zone === "wall") { const F = toFlat(L, "wall"); P.flip = F.x / CELL < ROOM.COLS / 2; }
  }
  const c = P.drag ? dragCell(L) : cellAt(P.it, L);
  if (P.cell && c.x === P.cell.x && c.y === P.cell.y && P.flip === flip0) return;
  P.cell = c;
  revalidate();
  renderPlacing();
}
function revalidate() {
  if (!P.mode || !P.cell) return;
  const c = P.cell;
  P.valid = P.it.zone === "fixture" ? checkFixture(P.it.fixture, c.x, c.y) : checkSpot(P.it, c.x, c.y, P.mode === "move" ? P.pid : null, P.flip);
}
function hitTest(L) {
  if (!S.me) return null;
  const order = { floor: 0, rug: 1, wall: 2 }; // topmost layer first; floor billboards front-most first
  const depth = (p, it) => (it.zone === "floor" ? floorGeom(it, p.x, p.y, p.flip).d : 0);
  const list = S.me.placed.map((p) => [p, S.catalog.get(p.item)]).filter(([, it]) => it && it.zone)
    .sort((a, b) => order[a[1].zone] - order[b[1].zone] || depth(...b) - depth(...a));
  const inside = (f, x, y) => x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h;
  // the wheel and the bed stand in front of every lane: they win, front-most first
  const fx = ["wheel", "bed"].map((k) => findPlaced("fx:" + k)).sort((a, b) => b.x + b.y - (a.x + a.y));
  for (const p of fx) if (inside(fixtureRect(p.fixture, p.x, p.y, p.flip), L.x, L.y)) return p;
  const sy = L.y - stripTop(clamp(Math.floor(L.x), WALL_X0, WALL_X1 - 1)); // the pointer on the unfolded wall
  for (const [p, it] of list) {
    if (it.zone === "rug" ? rugHit(p, it, L) : it.zone === "wall" ? inside(wallRect(it, p.x, p.y), L.x, sy) : inside(isoRect(it, p.x, p.y, p.flip), L.x, L.y)) return p;
  }
  return null;
}
function enterPlace(itemId) {
  const it = S.catalog.get(itemId);
  if (!it || !it.zone || unplaced(itemId) <= 0) return;
  selPid = null;
  Object.assign(P, { mode: "place", it, pid: null, flip: false, userFlip: false, cell: null, valid: null, drag: null, from: null, down: false });
  afterMode();
  if (matchMedia("(max-width:860px)").matches) stage.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function enterMove(pid, drag = null) {
  const p = findPlaced(pid), it = itemOf(p);
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
  const r = it.zone === "fixture" ? await post("/api/fixture", { which: it.fixture, i: cell.x, j: cell.y, flip: P.flip })
    : mode === "place"
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
  toast(errorWords(r.j, { it, x: cell.x, which: it.zone === "fixture" ? it.fixture : valid.which, with: valid.with }), "err");
  P.flashUntil = performance.now() + 450;
  if (P.drag || r.j.error === "unknown_pid" || r.j.error === "unowned") { cancelMode(); refresh(); } // a refused drag snaps home
  renderPlacing();
}
function select(pid) { selPid = findPlaced(pid) ? pid : null; renderPlacing(); positionTool(); }
async function flipPlaced(p) {
  if (!p) return;
  const r = p.fixture ? await post("/api/fixture", { which: p.fixture, i: p.x, j: p.y, flip: !p.flip })
    : await post("/api/move", { pid: p.pid, x: p.x, y: p.y, flip: !p.flip });
  if (r.ok && r.j.me) applyMe(r.j.me); else toast(errorWords(r.j, { it: itemOf(p) }), "err");
}
async function removePlaced(p) {
  if (!p || p.fixture) return; // the wheel and the bed stay in the room
  const it = S.catalog.get(p.item);
  const r = await post("/api/remove", { pid: p.pid });
  if (r.ok && r.j.me) { selPid = null; applyMe(r.j.me); toast(`${it ? it.name : "It"} is back in your things`); }
  else toast(errorWords(r.j, { it }), "err");
}
// floating toolbar above the selected item
function positionTool() {
  const el = $("itemTool");
  const p = selPid && !P.mode ? findPlaced(selPid) : null, it = itemOf(p);
  if (!it) { el.hidden = true; return; }
  $("toolName").textContent = it.name;
  el.querySelector('[data-act="remove"]').hidden = !!p.fixture;
  el.hidden = false;
  const f = isoRect(it, p.x, p.y, p.flip), cr = view.getBoundingClientRect(), sr = stage.getBoundingClientRect(), k = cr.width / LW;
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
$("pFlip").onclick = () => { if (P.mode) { P.flip = !P.flip; P.userFlip = true; revalidate(); renderPlacing(); } };
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
  if (!P.cell) { why.textContent = coarse.matches ? "· tap a spot in the den" : "· click a spot in the den · F flips · Esc cancels"; why.className = ""; }
  else if (P.valid && P.valid.ok) { why.textContent = coarse.matches ? "· tap to put it here" : "· click to put it here"; why.className = ""; }
  else { why.textContent = "· " + errorWords(P.valid || {}, { it: P.it, x: P.cell.x, which: P.it.zone === "fixture" ? P.it.fixture : P.valid && P.valid.which, with: P.valid && P.valid.with }); why.className = "bad"; }
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
    const pi = itemOf(p);
    if (p && pi) { const F = toFlat(press.L, pi.zone); enterMove(p.pid, { x0: p.x, y0: p.y, lx: F.x, ly: F.y }); }
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
  if (walletHook("isOpen")) { walletHook("key", e); return; } // the wallet modal sits above everything
  if (certOpen()) { certKey(e); return; } // the certificate is modal: room shortcuts stay off
  if (RU.open) { raidKey(e); return; } // so is the raid
  if (LB.open && e.key === "Escape") { closeLb(); return; }
  if (e.target && e.target.closest && e.target.closest("input,textarea,select")) return;
  if (e.key === "Escape") { if (P.mode) cancelMode(); else select(null); }
  else if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (P.mode) { P.flip = !P.flip; P.userFlip = true; revalidate(); renderPlacing(); } else if (selPid) flipPlaced(findPlaced(selPid));
  } else if ((e.key === "Delete" || e.key === "Backspace") && selPid && !P.mode && !fixOf(selPid)) { e.preventDefault(); removePlaced(findPlaced(selPid)); }
});

// in-canvas overlay: zone guides, ghost, selection. Floor + rugs mark floor tiles; wall overlays are
// painted on the flat wall strip and folded with it.
function frameRect(x, y, w, h, c = g) { c.fillRect(x, y, w, 1); c.fillRect(x, y + h - 1, w, 1); c.fillRect(x, y, 1, h); c.fillRect(x + w - 1, y, 1, h); }
function ring(f, col, c = g) { // dark outer + bright inner: readable on cream walls and on the night sky
  c.fillStyle = "rgba(12,10,8,.9)"; frameRect(f.x - 1, f.y - 1, f.w + 2, f.h + 2, c);
  c.fillStyle = col; frameRect(f.x, f.y, f.w, f.h, c);
}
function ants(x, y, w, h, t, c = g) { // marching ants, black/white dashes
  const off = Math.floor(t / 120);
  let i = 0;
  const dot = (px, py) => { c.fillStyle = ((i++ + off) >> 1) % 2 ? "#ffffff" : "#111111"; c.fillRect(px, py, 1, 1); };
  for (let px = x; px < x + w; px++) dot(px, y);
  for (let py = y + 1; py < y + h; py++) dot(x + w - 1, py);
  for (let px = x + w - 2; px >= x; px--) dot(px, y + h - 1);
  for (let py = y + h - 2; py > y; py--) dot(x, py);
}
const OV = {
  lane: () => diamondCanvas(null, "rgba(255,255,255,.38)"),
  reserved: () => diamondCanvas("rgba(239,68,68,.2)", "rgba(239,68,68,.9)", "rgba(239,68,68,.55)"),
  ok: () => diamondCanvas("rgba(34,197,94,.3)", "#4ade80"),
  bad: () => diamondCanvas("rgba(239,68,68,.38)", "#f87171"),
  sel: () => diamondCanvas(null, "rgba(255,255,255,.85)"),
};
function drawPlacement() {
  const now = performance.now();
  if (P.mode && P.it && P.it.zone === "fixture") { // open-floor tiles, the target tile, a ghost of the fixture
    const it = P.it, k = it.fixture;
    for (let i = 0; i < ROOM.ISO_NI; i++) for (let j = 0; j < ROOM.ISO_NJ; j++) if (i + j <= ROOM.FIX_MAX_SUM) drawTileOverlay(g, i, j, OV.lane());
    if (P.cell) {
      const ok = !!(P.valid && P.valid.ok) && P.flashUntil < now, { x: ci, y: cj } = P.cell;
      drawTileOverlay(g, ci, cj, ok ? OV.ok() : OV.bad());
      if (k === "wheel") drawWheel(ci, cj, P.flip, (S.me && S.me.wheelTier) | 0, false, 0.8);
      else drawBed(bedGeom({ i: ci, j: cj, flip: P.flip }), false, 0.8);
      ring(fixtureRect(k, ci, cj, P.flip), ok ? "#4ade80" : "#f87171");
    }
  } else if (P.mode && P.it) {
    const it = P.it;
    if (it.zone === "wall") { // cell-corner dots over the wall (light + dark pixel pair so they show on any wallpaper)
      for (let r = ROOM.WALL_TOP; r <= ROOM.WALL_BOTTOM + 1; r++) for (let c = 0; c <= ROOM.COLS; c++) {
        const x = Math.min(colLeft(c), WALL_X1 - 2), y = stripTop(x) + wallRowY(r);
        g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect(x, y, 1, 1); g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(x + 1, y, 1, 1);
      }
    } else { // every floor tile outlined; for furniture the wheel's and the bed's hatched red
      for (let i = 0; i < ROOM.ISO_NI; i++) for (let j = 0; j < ROOM.ISO_NJ; j++) if (tileOnFloor([i, j])) drawTileOverlay(g, i, j, OV.lane());
      if (it.zone === "floor") for (const k of ["wheel", "bed"]) { const f = fixture(k); drawTileOverlay(g, f.i, f.j, OV.reserved()); }
    }
    if (P.cell) {
      const ok = !!(P.valid && P.valid.ok) && P.flashUntil < now, col = ok ? "#4ade80" : "#f87171";
      if (it.zone === "wall") {
        const f = wallRect(it, P.cell.x, P.cell.y);
        foldLayer((s) => {
          s.globalAlpha = 0.8; drawItem({ flip: P.flip }, it, f.x, f.y, f.w, f.h, s); s.globalAlpha = 1;
          s.fillStyle = ok ? "rgba(34,197,94,.18)" : "rgba(239,68,68,.32)"; s.fillRect(f.x, f.y, f.w, f.h);
          ring(f, col, s);
        }, f.x - 1, f.x + f.w + 1);
      } else {
        for (const [i, j] of footprint(it, P.cell.x, P.cell.y, P.flip)) if (tileOnFloor([i, j])) drawTileOverlay(g, i, j, ok ? OV.ok() : OV.bad());
        g.globalAlpha = 0.8;
        const gp = { x: P.cell.x, y: P.cell.y, flip: P.flip };
        if (it.zone === "rug") { const r = rugProjection(gp, it); g.drawImage(r.canvas, r.x, r.y); }
        else { const f = isoRect(it, gp.x, gp.y, gp.flip); drawFloorItem(gp, it); g.globalAlpha = 1; ring(f, col); } // what you see is what lands
        g.globalAlpha = 1;
      }
    }
  }
  if (selPid && !P.mode) {
    const p = findPlaced(selPid), it = itemOf(p);
    if (it && it.zone === "fixture") { drawTileOverlay(g, p.x, p.y, OV.sel()); const f = fixtureRect(p.fixture, p.x, p.y, p.flip); ants(f.x - 1, f.y - 1, f.w + 2, f.h + 2, now); }
    else if (it && it.zone === "wall") { const f = wallRect(it, p.x, p.y); foldLayer((s) => ants(f.x - 1, f.y - 1, f.w + 2, f.h + 2, now, s), f.x - 1, f.x + f.w + 1); }
    else if (it) {
      for (const [i, j] of footprint(it, p.x, p.y, p.flip)) drawTileOverlay(g, i, j, OV.sel());
      if (it.zone === "floor") { const f = isoRect(it, p.x, p.y, p.flip); ants(f.x - 1, f.y - 1, f.w + 2, f.h + 2, now); }
    }
  }
}

// ---------- thumbnails (drawn live from the sprite registry) ----------
const thumbBuf = canvas(64, 64), tg = thumbBuf.getContext("2d");
function thumbPaint(it) {
  if (it.cat === "wheel") return [48, 50, () => {
    if (sprite(tg, "wheel", 0, 0, 0, { angle: 0, tier: it.tier })) sprite(tg, it.sprite, 0, 0, 0, { angle: 0, tier: it.tier });
    else tg.drawImage(placeholderItem(it, 48, 48), 0, 1);
  }];
  if (it.cat === "bed" || it.cat === "room") { // bed art (bed_tN), or a corner of the room built of that material (room_tN)
    const s = (window.SPRITES || {})[it.sprite], bw = (s && s.w) || 48, bh = (s && s.h) || 48;
    return [bw, bh, () => { if (!sprite(tg, it.sprite, 0, 0, 0, { tier: it.tier })) tg.drawImage(placeholderItem(it, bw, bh), 0, 0); }];
  }
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
  { id: "bed", label: "Bed", cats: ["bed"] },
  { id: "room", label: "Den", cats: ["room"] },
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
// Tier ladders (bought strictly in order; buying sets me[field]). Same order rules as the server.
const DEFAULT_MULT = [100, 125, 160, 200, 260, 350];
const TIERED = {
  wheel: { field: "wheelTier", mults: "WHEEL_MULT_PCT", unit: "watts per block", done: "Installed" },
  bed: { field: "bedTier", mults: "BED_MULT_PCT", unit: "bed watts while he sleeps", done: "Installed" },
  room: { field: "roomTier", done: "Built" }, // no multiplier: the material is the point
};
const roomMaterial = (tier) => (tier > 0 && (S.catalog.get(`room_t${tier}`) || {}).material) || "Wood";
function tierCardState(it, me, poor, need) {
  const t = TIERED[it.cat], tier = me ? me[t.field] | 0 : 0;
  let cur, to, doneNote;
  if (t.mults) {
    const mult = (S.balance && S.balance[t.mults]) || DEFAULT_MULT;
    cur = `${(mult[tier] / 100).toFixed(2)}×`; to = `${(it.multPct / 100).toFixed(2)}×`; doneNote = `${to} ${t.unit}`;
  } else {
    cur = roomMaterial(tier); to = it.material || it.name; doneNote = tier === it.tier ? `your den is ${to}` : `${to} · built`;
  }
  if (it.tier <= tier) return { kind: "owned", label: t.done, disabled: true, note: doneNote };
  if (it.tier === tier + 1) return { kind: "upgrade", label: "Upgrade", poor, need, note: `${cur} → ${to}`, up: true };
  return { kind: "locked", label: `After T${it.tier - 1}`, disabled: true, note: `→ ${to}` };
}
function cardState(it, me) {
  const watts = me ? me.watts : 0, owned = me ? me.owned[it.id] || 0 : 0;
  const poor = watts < it.price, need = it.price - watts;
  if (Object.hasOwn(TIERED, it.cat)) return tierCardState(it, me, poor, need);
  if (!it.zone) { // wallpaper, flooring, skins: buy once, then equip
    const equipped = me && (it.cat === "skin" ? me.skin : it.cat === "wallpaper" ? me.wallpaper : me.floor) === it.id;
    if (owned) return equipped ? { kind: "equipped", label: "In use", disabled: true, note: "equipped", cur: true } : { kind: "equip", label: "Equip", alt: true, note: "owned" };
    return { kind: "buy", label: "Buy", poor, need };
  }
  const placed = me ? me.placed.filter((p) => p.item === it.id).length : 0;
  return { kind: "buy", label: owned ? "Buy another" : "Buy", poor, need, own: owned ? `own ${owned}` : "", ownTitle: owned ? `${placed} in the den, ${owned - placed} in your things` : "" };
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
    if (it.cat === "wheel") toast(`${it.name}: ${(it.multPct / 100).toFixed(2)}× watts per block`, "ok");
    else if (it.cat === "bed") toast(`${it.name}: ${(it.multPct / 100).toFixed(2)}× bed watts`, "ok");
    else if (it.cat === "room") toast(`Your den is now ${it.material || it.name}`, "ok");
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
    s.textContent = !me || me.placed.length ? "" : "Nothing yet. Things you buy show up here.";
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
const DEFAULT_IDS = new Set(["skin_classic", "wp_dirt", "wp_plain", "fl_straw", "fl_pine"]);
function renderFirstHint() {
  const me = S.me;
  const fresh = !!me && !me.wheelTier && !me.placed.length && !ls.get("sr_placed_once")
    && !Object.entries(me.owned || {}).some(([id, n]) => n > 0 && !DEFAULT_IDS.has(id));
  $("firstHint").hidden = !fresh || !!P.mode;
}
// Username: unique, 3-16 of [A-Za-z0-9_] (the server re-checks). Picked in the onboarding step
// (nameModal, after the tutorial), changed here in the side panel. No wallet needed.
function nameProblem(v) {
  if (!v) return "3–16 letters, numbers or _";
  if (/[^A-Za-z0-9_]/.test(v)) return "Only letters, numbers and _ (no spaces or symbols)";
  if (v.length < 3) return `Too short: ${v.length}/3 characters minimum`;
  if (v.length > 16) return "Too long: 16 characters max";
  return null;
}
function nameErrorWords(j, want) {
  const e = j && j.error;
  return e === "username_taken" ? `“${want}” is already taken. Try another.` : e === "bad_username" ? "Not allowed: 3–16 letters, numbers or _." : errorWords(j);
}
async function saveUsername(want) {
  const r = await post("/api/username", { username: want });
  if (r.ok && r.j.me) { applyMe(r.j.me); if (LB.open) loadLb(); }
  return r;
}
const nickEl = $("nick");
function syncNick() { if (S.me && document.activeElement !== nickEl && !nickEl.dataset.dirty) nickEl.value = S.me.username || ""; }
async function saveNick() {
  const want = nickEl.value.trim();
  if (S.me && want === S.me.username) { delete nickEl.dataset.dirty; return; }
  const bad = nameProblem(want);
  if (bad) { toast(bad, "err"); return; }
  const r = await saveUsername(want);
  if (r.ok) { delete nickEl.dataset.dirty; toast(`Username saved: ${r.j.me.username}`, "ok"); }
  else toast(nameErrorWords(r.j, want), "err");
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
  maybeAskName();
  renderPlacing();
  positionTool();
  renderHud();
  if (RU.open) renderRaid();
  walletHook("onMe", S.me);
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
  const cv = canvas(FLAT_W, FLAT_H), c = cv.getContext("2d");
  const room = (cert && cert.room) || {}, { fx, frame: fr } = pose;
  const placed = Array.isArray(room.placed) ? room.placed : [];
  const items = (zone) => placed.map((p) => [p, p && S.catalog.get(p.item)]).filter(([p, it]) => it && it.zone === zone && Number.isInteger(p.x) && Number.isInteger(p.y));
  c.drawImage(wallpaperCanvas(room.wallpaper || "wp_plain"), 0, 0);
  for (const [p, it] of items("wall").sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x)) drawItem(p, it, p.x * CELL, p.y * CELL, it.w * CELL, it.h * CELL, c, fx, fr);
  c.drawImage(floorCanvas(room.floor || "fl_pine"), 0, FLOOR_Y);
  // floor items stand on tiles in the den: flatten each to the column under its middle, back to front
  const flatX = (p, it) => {
    const t = footprint(it, p.x, p.y, p.flip), cx = t.reduce((s, [i, j]) => s + isoTileCenter(i, j).x, 0) / t.length;
    return clamp(Math.round((cx - 16) / CELL - it.w / 2), 0, ROOM.COLS - it.w) * CELL;
  };
  const backToFront = (a, b) => a[0].x + a[0].y - (b[0].x + b[0].y);
  for (const [p, it] of items("rug").sort(backToFront)) drawRugFlat(p, it, flatX(p, it), c, fx, fr);
  for (const [p, it] of items("floor").sort(backToFront)) {
    const pw = it.w * CELL, ph = it.h * CELL, x = flatX(p, it);
    c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(x + 1, FLOOR_Y, pw - 2, 2);
    drawItem(p, it, x, FLOOR_Y - ph, pw, ph, c, fx, fr);
  }
  if (FLAT_BURROW && !sprite(c, "burrow", fr, FLAT_BURROW.x, FLAT_BURROW.y, {})) c.drawImage(burrowCanvas(), FLAT_BURROW.x, FLAT_BURROW.y);
  const tier = clamp(cert.wheelTier | 0, 0, 5), angle = pose.angle;
  c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(FLAT_WHEEL.cx - 19, FLOOR_Y, 38, 2);
  if (sprite(c, "wheel", Math.floor(angle * 24) % 4, FLAT_WHEEL.x, FLAT_WHEEL.y, { angle, tier })) {
    if (tier > 0) sprite(c, `wheel_t${tier}`, fr, FLAT_WHEEL.x, FLAT_WHEEL.y, { angle, tier });
  } else drawWheelPlaceholder(c, angle, tier, FLAT_WHEEL);
  // the hamster, mid-run in the wheel
  const skin = cert.skin || "skin_classic", f = pose.run;
  const dx = Math.round(FLAT_SPOT.wheel.x - 12), dy = Math.round(FLAT_SPOT.wheel.y - (f % 2 ? 1 : 0) - 24);
  if (!sprite(c, "hamster_run", f, dx, dy, { flip: false, skin, remap: (window.SKIN_REMAPS || {})[skin] })) c.drawImage(hamsterFrame("run", f, skin), dx, dy);
  // a few watt sparks lifting off the rim
  for (let i = 0; i < 4; i++) {
    const a = -Math.PI / 2 + (pose.r() - 0.5) * 1.7, d = FLAT_WHEEL.r + 3 + pose.r() * 20;
    const x = Math.round(FLAT_WHEEL.cx + Math.cos(a) * d), y = Math.round(FLAT_WHEEL.cy + Math.sin(a) * d);
    c.fillStyle = "rgba(245,166,35,.55)"; c.fillRect(x - Math.sign(Math.cos(a)), y + 1, 1, 1);
    c.fillStyle = "#ffd166"; c.fillRect(x, y, 1, 1);
  }
  // evening light at a third of the live tint's strength (lights are on: he's running)
  const t = tintAt(fx.utcHour), soft = (v) => Math.round(255 - (255 - v) * 0.35);
  c.globalCompositeOperation = "multiply";
  c.fillStyle = `rgb(${t.mul.map(soft).join(",")})`; c.fillRect(0, 0, FLAT_W, FLAT_H);
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
  const tw = certTextW("SQUEEK DEN", 6);
  certText(c, "SQUEEK DEN", Math.round((CERT_W - tw) / 2) + 6, 46, OUTLINE, 6);
  certText(c, "SQUEEK DEN", Math.round((CERT_W - tw) / 2), 40, [sch.light, sch.light, sch.main, sch.main, sch.deep], 6);
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
  const title = `SQUEEK DEN CERTIFICATE Nº ${serial}`;
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
  const goal = (S.balance && S.balance.CERT_LIFETIME_WATTS) || 500_000, days = (S.balance && S.balance.CERT_ACTIVE_DAYS) || 7;
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
  const tip = cert ? `Open certificate Nº ${cert.serial}` : me.certEligible ? "Your certificate is ready to claim" : `Certificate: ${certLeftWords(me)}`;
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
  view2.setAttribute("aria-label", `Certificate Nº ${cert.serial} for ${cert.nick}: ${fmt(cert.lifetimeWatts)} lifetime watts over ${cert.activeDays} active days, blocks ${cert.joinHeight} to ${cert.claimHeight}, with a portrait of the den.`);
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
  src.toBlob((b) => (b ? saveBlob(b, `squeek-den-cert-${cert.serial}.png`) : toast("Could not make the PNG here", "err")), "image/png");
};
$("certJson").onclick = () => {
  const { cert } = certUi;
  if (cert) saveBlob(new Blob([JSON.stringify(cert, null, 2) + "\n"], { type: "application/json" }), `squeek-den-cert-${cert.serial}.json`);
};
$("certShare").onclick = async () => {
  const { cert, blob } = certUi;
  if (!cert) return;
  const data = { title: `Squeek Den certificate Nº ${cert.serial}`, text: `My Squeek Den certificate Nº ${cert.serial}: ${fmt(cert.lifetimeWatts)} watts over ${cert.activeDays} active days, powered by a real hamster.` };
  const file = blob && new File([blob], `squeek-den-cert-${cert.serial}.png`, { type: "image/png" });
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) data.files = [file];
  else data.url = location.origin + "/";
  try { await navigator.share(data); }
  catch (e) { if (!e || e.name !== "AbortError") toast("Sharing doesn't work here. Save the PNG instead.", "err"); }
};

// ---------- raids: header chip, leaderboard, raid modal, result, feed ----------
// The server rolls and re-validates every raid (window, daily allowance, eligibility, stake); the
// client mirrors the maths so each option shows its odds and loot. EV is never shown on purpose.
// A failed raid burns the whole wager (the defender gets nothing), and a den raids and can be raided
// only once it has earned MIN_EARNED watts from the wheel or bed.
const RAID_DEFAULTS = { EDGE_PCT: 110, MULT_PCT: [150, 200, 300, 500, 1000], DEFENSE_PCT: [0, 5, 10, 15, 20, 25], TILT_EXP: 0.25, TILT_MIN_PCT: 75, TILT_MAX_PCT: 175,
  P_MIN_PCT: 2, P_MAX_PCT: 90, LOOT_U_MIN_PCT: 75, LOOT_U_MAX_PCT: 125, CRIT_CHANCE_PCT: 5, CRIT_MULT_PCT: 150, LOOT_MAX_DEF_PCT: 25, STAKE_MIN: 50, STAKE_MIN_BAL_PCT: 5,
  ELIGIBLE_MIN_PCT: 70, REVENGE_WINDOW_MS: 86_400_000, PER_DAY: 10, MIN_EARNED: 5000 };
const RB = () => ({ ...RAID_DEFAULTS, ...((S.balance && S.balance.RAID) || {}) });
// p = clamp((EDGE / M) x (1 - d) x clamp((def / me) ^ 0.25, 0.75, 1.75), 0.02, 0.90), M as a percentage,
// and at least 1/M when the target holds at least my watts
function raidP(multPct, defTier, myWatts, defWatts) {
  const R = RB();
  const ratio = defWatts / myWatts;
  const tilt = clamp(Number.isNaN(ratio) ? 1 : Math.pow(ratio, R.TILT_EXP), R.TILT_MIN_PCT / 100, R.TILT_MAX_PCT / 100);
  const d = R.DEFENSE_PCT[defTier | 0] ?? R.DEFENSE_PCT[0];
  let p = (R.EDGE_PCT / multPct) * (1 - d / 100) * tilt;
  if (defWatts >= myWatts) p = Math.max(p, 100 / multPct);
  return clamp(p, R.P_MIN_PCT / 100, R.P_MAX_PCT / 100);
}
const lootCap = (defWatts) => Math.floor((Math.max(0, defWatts) * RB().LOOT_MAX_DEF_PCT) / 100);
// [max(50, 5% of my watts), min(my watts, the target's loot cap / ((M - 1) x 1.25))], as the server
// computes it; limit says which bound set max. max < min: no raid at this multiplier.
function raidStakeBounds(watts, defWatts = null, multPct = null) {
  const R = RB(), bal = Math.max(0, Math.floor(watts));
  const min = Math.max(R.STAKE_MIN, Math.ceil((bal * R.STAKE_MIN_BAL_PCT) / 100));
  if (defWatts == null || multPct == null) return { min, max: bal, limit: "balance" };
  const top = Math.floor((lootCap(defWatts) * 10_000) / ((multPct - 100) * R.LOOT_U_MAX_PCT));
  return top < bal ? { min, max: top, limit: "target" } : { min, max: bal, limit: "balance" };
}
function lootRange(multPct, stake, defWatts) {
  const R = RB(), cap = lootCap(defWatts), base = (multPct - 100) * stake;
  return [Math.min(Math.floor((base * R.LOOT_U_MIN_PCT) / 10_000), cap), Math.min(Math.floor((base * R.LOOT_U_MAX_PCT) / 10_000), cap)];
}
const multLabel = (m) => `${+(m / 100).toFixed(2)}×`;
const pctText = (p) => { const v = p * 100; return `${v < 10 ? +v.toFixed(1) : Math.round(v)}%`; };
const durText = (ms) => { const m = Math.max(1, Math.ceil(ms / 60_000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const agoText = (at) => {
  const s = Math.max(0, Math.round((Date.now() + S.skew - at) / 1000));
  return s < 45 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86_400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`;
};
function elx(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const myPid = () => (S.me && S.me.publicId) || null;

// raid window + this player's raids left today (snapshot every 5 s, the leaderboard, raid replies)
S.raid = null; S.raidFeed = []; S.burned = 0;
function applyRaidStatus(raid) {
  if (!raid || typeof raid !== "object") { S.raid = null; return; }
  const per = Number(raid.perDay) || RB().PER_DAY;
  const need = Number(raid.needEarned) || RB().MIN_EARNED;
  S.raid = { open: !!raid.open, left: Number.isFinite(raid.raidsLeft) ? raid.raidsLeft : per, perDay: per, resetAt: Date.now() + Math.max(0, Number(raid.resetMs) || 0),
    ready: raid.ready !== false, earned: Number(raid.earned) || 0, need };
}
const raidsLeftNow = () => (S.raid ? (Date.now() >= S.raid.resetAt ? S.raid.perDay : S.raid.left) : 0);
const resetIn = () => (S.raid ? Math.max(0, S.raid.resetAt - Date.now()) : 0);
// earned so far toward the raid floor: the live lifetime when we have it (it only grows), else the server's count
const earnedNow = () => Math.max(S.raid ? S.raid.earned : 0, (S.me && S.me.lifetimeWatts) || 0);
const raidNeed = () => (S.raid && S.raid.need) || RB().MIN_EARNED;
const freshWords = () => `Earn ${fmt(raidNeed())} W from the wheel or bed first. Fresh dens can't raid or be raided.`;
function raidPhase() { // none | fresh | open | spent | locked
  if (!S.raid || !S.me) return "none";
  if (!S.raid.ready && earnedNow() < raidNeed()) return "fresh";
  if (!S.raid.open) return "locked";
  return raidsLeftNow() > 0 ? "open" : "spent";
}
const lockedWhy = () => (S.idle ? "he's asleep" : "waiting for a block");
let chipSig = "";
function renderRaidChip() {
  const el = $("raidChip"), ph = raidPhase();
  el.hidden = ph === "none";
  if (ph === "none") return;
  const html = `⚔ Raid <span class="cd">${ph === "fresh" ? `${fmt(Math.min(earnedNow(), raidNeed()))}/${fmt(raidNeed())} W` : ph === "locked" ? lockedWhy() : `${raidsLeftNow()} left`}</span>`;
  const sig = ph + html;
  if (sig === chipSig) return;
  chipSig = sig;
  el.className = `raidchip ${ph === "fresh" ? "locked fresh" : ph}`;
  el.innerHTML = html;
  el.title = ph === "fresh" ? freshWords() : ph === "locked" ? "Raids only work while Squeektoshi runs" : ph === "spent" ? `Out of raids. More in ${durText(resetIn())}` : "Leaderboard";
  el.setAttribute("aria-expanded", String(LB.open));
}

// ----- leaderboard drawer -----
const LB = { open: false, data: null, at: 0, timer: 0, busy: false, err: false, sig: "", back: null };
const matUrls = new Map();
function matSwatchUrl(t) {
  t = clamp(t | 0, 0, 5);
  if (matUrls.has(t)) return matUrls.get(t);
  const c = canvas(32, 16), x = c.getContext("2d");
  if (!sprite(x, `floor_mat_t${t}`, 0, 0, 0, {})) { const [, mid, lo] = matEdge(t); x.drawImage(diamondCanvas(mid, lo), 0, 0); }
  const u = c.toDataURL();
  matUrls.set(t, u);
  return u;
}
const defensePct = (t) => RB().DEFENSE_PCT[t | 0] ?? 0;
// display name: the server's `name` (wallet username, else the room nick); nick for older payloads
const rowName = (r) => (r && (r.name || r.nick)) || "anon";
function verifiedBadge() { const b = elx("span", "vbadge", "✓"); b.title = "Wallet-verified username"; b.setAttribute("aria-label", "wallet verified"); return b; }
const rowMatLine = (r) => `${roomMaterial(r.roomTier | 0)} den${defensePct(r.roomTier) ? ` · −${defensePct(r.roomTier)}% odds` : ""}`;
// recomputed against my live watts (the server's flag uses the same rule; it re-checks on raid)
function rowRaidable(r) {
  const me = S.me;
  if (!me || r.you || r.publicId === myPid() || r.fresh || raidPhase() === "fresh") return false;
  return r.watts * 100 >= me.watts * RB().ELIGIBLE_MIN_PCT || !!r.revenge;
}
const minTarget = () => (S.me ? Math.ceil((S.me.watts * RB().ELIGIBLE_MIN_PCT) / 100) : 0);
function loadLb() { // concurrent callers share one request
  if (!LB.busy) LB.p = fetchLb();
  return LB.p;
}
async function fetchLb() {
  LB.busy = true;
  try {
    const r = await fetch(`/api/leaderboard?token=${encodeURIComponent(token)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    LB.data = j; LB.at = Date.now(); LB.err = false;
    if (j.raid) applyRaidStatus(j.raid);
  } catch { LB.err = true; }
  LB.busy = false;
  LB.sig = "";
  if (LB.open) renderLb();
  if (RU.open) renderRaid();
  renderRaidChip();
}
function openLb() {
  if (!LB.open) LB.back = document.activeElement;
  LB.open = true;
  $("lb").hidden = false;
  LB.sig = "";
  renderLb();
  loadLb();
  clearInterval(LB.timer);
  LB.timer = setInterval(() => { if (document.visibilityState === "visible") loadLb(); }, 10_000);
  chipSig = "";
  renderRaidChip();
  $("lbClose").focus({ preventScroll: true });
}
function closeLb() {
  LB.open = false;
  $("lb").hidden = true;
  clearInterval(LB.timer);
  chipSig = "";
  renderRaidChip();
  const back = LB.back; LB.back = null;
  if (back && back.focus && document.contains(back)) back.focus({ preventScroll: true });
}
function raidStateWords() {
  const ph = raidPhase();
  if (ph === "open") return ["open", `<b>${raidsLeftNow()}/${S.raid.perDay}</b> raids left today`];
  if (ph === "spent") return ["", `Out of raids. More in <b>${durText(resetIn())}</b>`];
  if (ph === "locked") return ["", S.idle ? "Squeektoshi is asleep. Raids open when he runs." : "Waiting for a fresh block."];
  if (ph === "fresh") return ["", `${freshWords()} You're at <b>${fmt(Math.min(earnedNow(), raidNeed()))} W</b>.`];
  return ["", "Loading…"];
}
function renderLb() {
  if (!LB.open) return;
  const d = LB.data, me = S.me;
  const [cls, words] = raidStateWords();
  const st = $("lbState");
  st.className = "lbstate" + (cls ? " " + cls : "");
  const targets = d ? d.rows.filter(rowRaidable).length : 0;
  st.innerHTML = words + (me && d && cls ? ` · ${targets} target${targets === 1 ? "" : "s"}` : "");
  const age = LB.at ? Math.round((Date.now() - LB.at) / 1000) : null;
  $("lbMeta").textContent = !d ? (LB.err ? "can't reach the server" : "loading…") : `${fmt(d.total)} den${d.total === 1 ? "" : "s"} · ${LB.err ? `couldn't refresh, showing ${age}s old` : age < 3 ? "just updated" : `updated ${age}s ago`}`;
  const sig = d ? `${LB.at}|${me ? me.watts : ""}|${raidPhase()}` : "none";
  if (sig === LB.sig) return;
  LB.sig = sig;
  const box = $("lbRows"), focusPid = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.pid : null;
  box.innerHTML = "";
  if (!d) return;
  if (!d.rows.length) { box.appendChild(elx("li", "lbnote", "No dens yet.")); return; }
  for (const r of d.rows) {
    const raidable = rowRaidable(r), you = r.you || r.publicId === myPid();
    const li = elx("li");
    const row = elx(raidable ? "button" : "div", "lbrow" + (raidable ? " raidable" : you ? " you" : " dim") + (r.revenge ? " revenge" : ""));
    if (raidable) { row.type = "button"; row.dataset.pid = r.publicId; row.onclick = () => openRaid(r); }
    row.appendChild(elx("span", "rk", `#${r.rank}`));
    const img = elx("img", "mat"); img.src = matSwatchUrl(r.roomTier); img.alt = ""; row.appendChild(img);
    const who = elx("span", "who"), nm = elx("span", "nm", rowName(r));
    if (r.verified) nm.appendChild(verifiedBadge());
    if (you) nm.appendChild(elx("span", "tag you", "YOU"));
    if (r.revenge) nm.appendChild(elx("span", "tag rev", "REVENGE"));
    who.appendChild(nm);
    who.appendChild(elx("span", "mt", rowMatLine(r)));
    row.appendChild(who);
    const wt = elx("span", "wt", `${fmt(r.watts)} W`);
    if (raidable && me) {
      wt.appendChild(elx("span", "go", "RAID"));
    } else if (!you) wt.appendChild(elx("small", null, r.fresh ? "new den" : raidPhase() === "fresh" ? "" : "too small"));
    row.title = raidable ? `Raid ${rowName(r)}${r.revenge ? " (revenge)" : ""}` : you ? "Your den"
      : r.fresh ? `New den. It can't be raided until it earns ${fmt(raidNeed())} W.` : raidPhase() === "fresh" ? freshWords() : `Under 70% of your watts (${fmt(minTarget())} W). You can only raid up.`;
    row.setAttribute("aria-label", `Rank ${r.rank}, ${rowName(r)}${r.verified ? " (wallet verified)" : ""}${you ? " (you)" : ""}, ${roomMaterial(r.roomTier | 0)} den, ${fmt(r.watts)} watts${raidable ? ", raidable" : ""}${r.revenge ? ", revenge" : ""}`);
    row.appendChild(wt);
    li.appendChild(row);
    box.appendChild(li);
  }
  if (focusPid) { const f = box.querySelector(`[data-pid="${CSS.escape(focusPid)}"]`); if (f) f.focus({ preventScroll: true }); }
}
$("raidChip").onclick = () => (LB.open ? closeLb() : openLb());
$("lbClose").onclick = closeLb;

// ----- raid modal -----
const RU = { open: false, row: null, mult: 0, stake: 0, busy: false, result: null, back: null, built: false, countRaf: 0 };
{ const m = Number(ls.get("sr_mult")); RU.mult = RAID_DEFAULTS.MULT_PCT.includes(m) ? m : 200; RU.stake = Number(ls.get("sr_stake")) || 0; }
function raidTarget() { // the freshest copy of the target's row
  const d = LB.data, pid = RU.row && RU.row.publicId;
  return (d && d.rows.find((x) => x.publicId === pid)) || RU.row;
}
// bounds for my watts against the current target at the chosen multiplier; v = the stake to send
function stakeNow(mult = RU.mult) {
  const t = raidTarget(), b = raidStakeBounds(S.me ? S.me.watts : 0, t ? t.watts : null, t ? mult : null);
  return { ...b, v: clamp(Math.round(RU.stake) || b.min, b.min, Math.max(b.min, b.max)) };
}
function openRaid(row) {
  if (!row || !S.me) return;
  if (!RU.open) RU.back = document.activeElement;
  RU.open = true; RU.row = row; RU.result = null; RU.busy = false;
  if (!RU.stake) { const b = raidStakeBounds(S.me.watts); RU.stake = clamp(Math.floor(b.max / 10), b.min, Math.max(b.min, b.max)); }
  $("raidErr").textContent = "";
  $("raidForm").style.display = "flex";
  $("raidResult").hidden = true;
  $("raidModal").hidden = false;
  document.body.classList.add("modal-open");
  buildMults();
  renderRaid(true);
  const sel = $("raidMults").querySelector('[aria-checked="true"]');
  (sel || $("raidClose")).focus({ preventScroll: true });
}
function closeRaid() {
  if (!RU.open) return;
  RU.open = false; RU.busy = false;
  cancelAnimationFrame(RU.countRaf);
  $("raidModal").hidden = true;
  if ($("certModal").hidden) document.body.classList.remove("modal-open");
  const back = RU.back; RU.back = null;
  if (back && back.focus && document.contains(back)) back.focus({ preventScroll: true });
}
function buildMults() {
  if (RU.built) return;
  RU.built = true;
  const box = $("raidMults");
  box.innerHTML = "";
  for (const m of RB().MULT_PCT) {
    const b = elx("button", "mult");
    b.type = "button"; b.setAttribute("role", "radio"); b.dataset.m = String(m);
    b.innerHTML = `<span class="mx"></span><span class="pc"></span>`;
    b.querySelector(".mx").textContent = multLabel(m);
    b.onclick = () => { RU.mult = m; ls.set("sr_mult", String(m)); renderRaid(); };
    box.appendChild(b);
  }
  box.addEventListener("keydown", (e) => { // arrow keys move the radio choice
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const L = RB().MULT_PCT, i = L.indexOf(RU.mult), n = clamp(i + (e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1), 0, L.length - 1);
    RU.mult = L[n]; ls.set("sr_mult", String(RU.mult)); renderRaid();
    box.querySelector(`[data-m="${L[n]}"]`).focus();
  });
}
// Why the RAID button can't fire right now (null = it can). The server re-checks all of it anyway.
function raidBlock(t, sb) {
  const ph = raidPhase();
  if (ph === "locked") return { lock: true, msg: S.idle ? "Squeektoshi is asleep. Raids open when he runs." : "Waiting for a fresh block." };
  if (ph === "spent") return { lock: true, msg: `No raids left today. More in ${durText(resetIn())}.` };
  if (ph === "fresh") return { lock: true, msg: freshWords() };
  if (t.fresh) return { lock: true, msg: `${escapeHtml(rowName(t))} is a new den. It can't be raided until it earns ${fmt(raidNeed())} W.` };
  if (!rowRaidable(t)) return { lock: true, msg: `${escapeHtml(rowName(t))} has under 70% of your watts now.` };
  if (sb.max < sb.min) return { lock: true, msg: stakeLockWords(sb) };
  return null;
}
function stakeLockWords(sb) {
  if (sb.limit === "balance") return `You need at least ${fmt(sb.min)} W to raid.`;
  return RB().MULT_PCT.some((m) => { const b = stakeNow(m); return b.max >= b.min; })
    ? `Their den is too small for a ${multLabel(RU.mult)} raid at your size. Pick a lower multiplier.`
    : `Their den is too small to raid with your minimum wager of ${fmt(sb.min)} W.`;
}
function renderRaid(force = false) {
  if (!RU.open || !S.me) return;
  const t = raidTarget(), me = S.me, R = RB();
  const tb = $("raidTarget");
  const tsig = `${t.publicId}|${rowName(t)}|${t.verified}|${t.roomTier}|${t.watts}|${t.revenge}`;
  if (force || tb.dataset.sig !== tsig) {
    tb.dataset.sig = tsig;
    tb.innerHTML = "";
    const img = elx("img"); img.src = matSwatchUrl(t.roomTier); img.alt = ""; tb.appendChild(img);
    const tn = elx("div", "tn", rowName(t)); if (t.verified) tn.appendChild(verifiedBadge());
    tb.appendChild(tn);
    tb.appendChild(elx("div", "tw", `${fmt(t.watts)} W`));
  }
  const rev = !!t.revenge;
  $("raidBox").classList.toggle("revenge", rev);
  $("raidRev").hidden = !rev;
  $("raidTitle").textContent = rev ? "Revenge" : "Raid";
  if (RU.result) return; // the result view is showing
  const sb = stakeNow(), S0 = sb.v, myW = me.watts;
  // multiplier choices: odds only; dimmed where the target's loot cap leaves no stake in range
  for (const b of $("raidMults").children) {
    const m = Number(b.dataset.m), p = raidP(m, t.roomTier, myW, t.watts), mb = stakeNow(m), off = mb.max < mb.min;
    b.setAttribute("aria-checked", String(m === RU.mult));
    b.tabIndex = m === RU.mult ? 0 : -1;
    b.classList.toggle("off", off);
    b.querySelector(".pc").textContent = pctText(p);
    b.setAttribute("aria-label", `${multLabel(m)}, ${pctText(p)} chance to win${off ? ", not available against this den" : ""}`);
  }
  // stake controls (left alone while being typed in)
  const num = $("stakeNum"), rng2 = $("stakeRange"), maxShown = Math.max(sb.min, sb.max);
  num.min = rng2.min = String(sb.min); num.max = rng2.max = String(maxShown);
  if (document.activeElement !== num) num.value = String(S0);
  rng2.value = String(S0);
  rng2.disabled = num.disabled = sb.max < sb.min;
  // what's at stake, one line
  const m = RU.mult, [lo, hi] = lootRange(m, S0, t.watts);
  $("raidSum").innerHTML = sb.max < sb.min
    ? `<span><small>win</small><b>—</b></span><span><small>lose</small><b>—</b></span>`
    : `<span><small>win</small><b class="pos">+${lo === hi ? fmt(hi) : `${fmt(lo)}–${fmt(hi)}`} W</b></span><span><small>lose</small><b class="neg">−${fmt(S0)} W</b></span>`;
  // lock banner + button
  const blk = raidBlock(t, sb), lock = $("raidLock");
  lock.hidden = !blk;
  if (blk) lock.innerHTML = blk.msg;
  const go = $("raidGo");
  go.disabled = !!blk || RU.busy;
  go.classList.toggle("busy", RU.busy);
  go.textContent = RU.busy ? "Rolling…" : `${rev ? "Revenge" : "Raid"} · ${multLabel(m)}`;
  $("raidLeft").textContent = S.raid ? `${raidsLeftNow()} of ${S.raid.perDay} raids left today` : "";
}
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
function setStake(v) { RU.stake = Math.round(Number(v)) || 0; RU.stake = stakeNow().v; ls.set("sr_stake", String(RU.stake)); renderRaid(); }
$("stakeRange").addEventListener("input", (e) => setStake(e.target.value));
$("stakeNum").addEventListener("input", (e) => {
  const v = Math.round(Number(e.target.value)), sb = stakeNow();
  e.target.style.borderColor = Number.isFinite(v) && v >= sb.min && v <= sb.max ? "" : "#dc2626";
  if (Number.isFinite(v) && v > 0) { RU.stake = v; renderRaid(); }
});
$("stakeNum").addEventListener("change", (e) => { e.target.style.borderColor = ""; setStake(e.target.value); e.target.value = String(stakeNow().v); });
$("stakeNum").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
document.querySelectorAll("#raidForm [data-q]").forEach((b) => (b.onclick = () => { const sb = stakeNow(); setStake(Math.max(sb.min, Math.floor((sb.max * Number(b.dataset.q)) / 100))); }));
$("raidGo").onclick = doRaid;
$("raidClose").onclick = closeRaid;
$("resClose").onclick = closeRaid;
$("resBack").onclick = () => { closeRaid(); if (!LB.open) openLb(); };
$("raidModal").addEventListener("click", (e) => { if (e.target === e.currentTarget && !RU.busy) closeRaid(); });
function raidKey(e) {
  if (e.key === "Escape") { e.preventDefault(); if (!RU.busy) closeRaid(); return; }
  if (e.key !== "Tab") return;
  const f = [...$("raidBox").querySelectorAll("button,input")].filter((x) => !x.disabled && x.offsetParent !== null && x.tabIndex >= 0);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
}
function raidErrorWords(j) {
  const e = (j && j.error) || "network", t = raidTarget();
  switch (e) {
    case "hamster_asleep": return "Too late, he just fell asleep.";
    case "chain_unknown": return "No blocks seen yet.";
    case "chain_stale": return "Waiting for a fresh block.";
    case "no_raids_left": return `No raids left today. More in ${durText(j.resetMs || 0)}.`;
    case "bad_target": return "That den is gone.";
    case "not_eligible":
      if (j.reason === "fresh_attacker") return freshWords();
      if (j.reason === "fresh_target") return `${t ? rowName(t) : "That den"} is a new den. It can't be raided until it earns ${fmt(j.needEarned || raidNeed())} W.`;
      return `${t ? rowName(t) : "They"} dropped under 70% of your watts.`;
    case "self_target": return "That's your own den.";
    case "bad_mult": return "Pick a multiplier.";
    case "bad_stake": case "stake_out_of_range": return j.max < j.min ? stakeLockWords(j) : `Wager ${fmt(j.min)} to ${fmt(j.max)} W${j.limit === "target" ? ` against this den at ${multLabel(RU.mult)}` : ""}.`;
    default: return errorWords(j);
  }
}
async function doRaid() {
  if (RU.busy || !RU.open || !S.me) return;
  const t = raidTarget(), sb = stakeNow(), mult = RU.mult;
  if (raidBlock(t, sb)) { renderRaid(); return; }
  RU.busy = true;
  $("raidErr").textContent = "";
  renderRaid();
  const r = await post("/api/raid", { target: t.publicId, stake: sb.v, mult });
  RU.busy = false;
  if (r.ok && r.j && r.j.result) { onRaidResult(r.j, t); return; }
  const j = r.j || {}, e = j.error;
  if (e === "no_raids_left") applyRaidStatus({ open: true, raidsLeft: 0, perDay: S.raid && S.raid.perDay, resetMs: j.resetMs });
  else if (e === "hamster_asleep" || e === "chain_unknown" || e === "chain_stale") { if (S.raid) S.raid.open = false; else applyRaidStatus({ open: false }); }
  else if (e === "stake_out_of_range" || e === "bad_stake") { if (Number.isFinite(j.max) && j.max >= j.min) RU.stake = clamp(sb.v, j.min, j.max); refresh(); }
  if (e === "not_eligible" && j.reason === "fresh_attacker" && S.raid) { S.raid.ready = false; if (Number.isFinite(j.earned)) S.raid.earned = j.earned; }
  if (e === "not_eligible" || e === "bad_target") loadLb();
  chipSig = "";
  renderRaidChip();
  if (RU.open) {
    $("raidErr").textContent = raidErrorWords(j);
    const box = $("raidBox"); box.classList.remove("shake"); void box.offsetWidth; box.classList.add("shake");
    renderRaid();
  } else toast(raidErrorWords(j), "err");
}
// the reply: apply `me` at once, then the drama
function onRaidResult(j, t) {
  const res = j.result, before = S.me ? S.me.watts : 0;
  if (j.me) applyMe(j.me, false, { at: Date.now() + S.skew - 250 });
  if (S.raid) S.raid.left = Number.isFinite(res.raidsLeft) ? res.raidsLeft : Math.max(0, S.raid.left - 1);
  if (j.feed) { const k = feedKey(j.feed); if (!S.raidFeed.some((e) => feedKey(e) === k)) S.raidFeed = [...S.raidFeed, j.feed].slice(-20); FEED.seen.add(k); FEED.fresh = new Set([k]); FEED.sig = ""; renderFeed(); }
  chipSig = "";
  renderRaidChip();
  loadLb();
  RU.result = res;
  showRaidResult(res, t, before);
}
function showRaidResult(res, t, before) {
  $("raidForm").style.display = "none";
  $("raidLock").hidden = true;
  const box = $("raidResult"), win = !!res.win;
  box.hidden = false;
  box.className = "rresult " + (win ? "win" : "loss");
  box.querySelectorAll(".fxp").forEach((n) => n.remove());
  $("resCrit").hidden = !(win && res.crit);
  const m = res.multPct || RU.mult;
  if (win) {
    $("resBig").textContent = res.revenge ? "Revenge!" : "You won";
    $("resDet").textContent = `from ${rowName(t)} at ${multLabel(m)}`;
    countUp($("resAmt"), res.loot, res.crit ? 1700 : 1200);
    for (let i = 0; i < (res.crit ? 36 : 22); i++) {
      const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 110, p = elx("i", "fxp coin");
      p.style.setProperty("--dx", `${Math.round(Math.cos(a) * d)}px`); p.style.setProperty("--dy", `${Math.round(Math.sin(a) * d * 0.7)}px`);
      p.style.animationDelay = `${Math.round(Math.random() * 250)}ms`;
      box.appendChild(p);
    }
    raidFx(res.crit ? "crit" : "win");
    gainFlash(res.loot);
    toast(`${res.crit ? "Crit! " : ""}+${fmt(res.loot)} W from ${rowName(t)}`, "ok");
  } else {
    $("resBig").textContent = "You lost";
    $("resAmt").textContent = `−${fmt(res.stakeLost || res.stake)} W`;
    $("resDet").textContent = `wager burned at ${multLabel(m)}`;
    for (let i = 0; i < 28; i++) {
      const p = elx("i", "fxp ember");
      p.style.left = `${5 + Math.random() * 90}%`;
      p.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 60)}px`);
      p.style.setProperty("--t", `${(1.1 + Math.random() * 1.2).toFixed(2)}s`);
      p.style.setProperty("--d", `${(Math.random() * 0.9).toFixed(2)}s`);
      box.appendChild(p);
    }
    const rb = $("raidBox"); rb.classList.remove("shake"); void rb.offsetWidth; rb.classList.add("shake");
    raidFx("burn");
    const s = elx("span", "spend", `−${fmt(res.stakeLost || res.stake)} W burned`);
    $("meter").appendChild(s); setTimeout(() => s.remove(), 1700);
  }
  $("resBack").focus({ preventScroll: true });
}
function countUp(el, to, dur) {
  cancelAnimationFrame(RU.countRaf);
  const t0 = performance.now();
  const stepC = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = `+${fmt(to * e)} W`;
    if (k < 1) RU.countRaf = requestAnimationFrame(stepC);
  };
  el.textContent = "+0 W";
  RU.countRaf = requestAnimationFrame(stepC);
}
function gainFlash(delta) {
  meter.glowUntil = performance.now() + 1800;
  $("meter").classList.add("glow");
  const gEl = $("gain");
  gEl.textContent = `+${fmt(delta)}`;
  gEl.classList.remove("show"); void gEl.offsetWidth; gEl.classList.add("show");
}

// ----- canvas fx: loot sparks, burning embers, flashes -----
const embers = [];
let rflash = null; // { rgb, a, t, life }
function raidFx(kind) {
  if (kind === "win" || kind === "crit") {
    const n = kind === "crit" ? 16 : 10;
    for (let i = 0; i < n; i++) spawnSpark(i * 60);
    rflash = { rgb: "255,209,102", a: kind === "crit" ? 0.45 : 0.28, t: 0, life: 700 };
  } else { // burn (my lost stake) / hit (someone raided me)
    const hit = kind === "hit";
    for (let i = 0; i < (hit ? 40 : 34); i++) {
      embers.push({ x: 20 + Math.random() * (LW - 40), y: LH - 10 - Math.random() * 70, vx: (Math.random() - 0.5) * 0.02, vy: -(0.025 + Math.random() * 0.045), t: -Math.random() * 600, life: 1200 + Math.random() * 1400, big: Math.random() < 0.3 });
    }
    rflash = { rgb: hit ? "220,38,38" : "249,115,22", a: hit ? 0.5 : 0.32, t: 0, life: hit ? 1100 : 800 };
  }
}
function stepRaidFx(dt) {
  for (let i = embers.length - 1; i >= 0; i--) {
    const e = embers[i];
    e.t += dt;
    if (e.t < 0) continue;
    e.x += e.vx * dt + Math.sin((e.t + i * 97) / 140) * 0.15;
    e.y += e.vy * dt;
    if (e.t > e.life) embers.splice(i, 1);
  }
  if (rflash) { rflash.t += dt; if (rflash.t > rflash.life) rflash = null; }
}
function drawRaidFx() {
  if (rflash) { g.fillStyle = `rgba(${rflash.rgb},${(rflash.a * (1 - rflash.t / rflash.life)).toFixed(3)})`; g.fillRect(0, 0, LW, LH); }
  for (const e of embers) {
    if (e.t < 0) continue;
    const k = e.t / e.life, x = Math.round(e.x), y = Math.round(e.y);
    g.fillStyle = k < 0.3 ? "#fde047" : k < 0.65 ? "#f97316" : "#b91c1c";
    g.globalAlpha = clamp(1.2 - k, 0, 1);
    g.fillRect(x, y, e.big ? 2 : 1, e.big ? 2 : 1);
    g.globalAlpha = 1;
  }
}

// ----- raid feed (snapshot.raidFeed, oldest first; shown newest first) -----
const FEED = { seen: new Set(), init: false, fresh: new Set(), sig: "", collapsed: null };
const feedKey = (e) => `${e.at}|${e.atkId}|${e.defId}`;
FEED.collapsed = ls.get("sr_feed") != null ? ls.get("sr_feed") === "1" : matchMedia("(max-width:860px)").matches;
function applyFeed(list) {
  const mine = myPid(), fresh = [];
  for (const e of list) if (e && !FEED.seen.has(feedKey(e)) && FEED.init) fresh.push(e);
  if (mine) { FEED.init = true; FEED.seen = new Set(list.map(feedKey)); }
  S.raidFeed = list;
  if (fresh.length) { FEED.fresh = new Set(fresh.map(feedKey)); FEED.sig = ""; }
  for (const e of fresh) if (e.defId === mine && e.atkId !== mine) raidedMe(e);
  renderFeed();
}
// someone raided me between two polls: make sure I notice
function raidedMe(e) {
  const w = !!e.win;
  toast(w ? `${e.atk} raided you: −${fmt(e.amount)} W` : `${e.atk} tried to raid you and lost ${fmt(e.amount)} W`, w ? "err" : undefined);
  for (const id of ["feed", "stage"]) { const n = $(id); n.classList.remove("hit"); void n.offsetWidth; n.classList.add("hit"); setTimeout(() => n.classList.remove("hit"), 1600); }
  if (w) { const m = $("meter"); m.classList.remove("poor"); void m.offsetWidth; m.classList.add("poor"); setTimeout(() => m.classList.remove("poor"), 900); }
  raidFx("hit");
  if (w && e.amount > 0) spawnPop("hit", e.amount); // the flash and embers carry no number: say what it cost
  if (FEED.collapsed) { FEED.collapsed = false; FEED.sig = ""; } // open it for this one (not remembered)
  if (LB.open) loadLb();
}
function setFeedCollapsed(v) { FEED.collapsed = v; ls.set("sr_feed", v ? "1" : "0"); FEED.sig = ""; renderFeed(); }
$("feedHead").onclick = () => setFeedCollapsed(!FEED.collapsed);
function feedLine(e, mine) {
  const li = elx("li"), tx = elx("span", "tx"), amt = fmt(e.amount);
  const atkMe = e.atkId === mine, defMe = e.defId === mine;
  if (defMe) li.className = "me"; else if (atkMe) li.className = "mine";
  const name = (s) => elx("b", null, s || "anon");
  const parts = [];
  if (e.win) {
    parts.push(atkMe ? name("You") : name(e.atk), " raided ", defMe ? name("you") : name(e.def), " ");
    parts.push(elx("span", "w", `${atkMe ? "+" : "−"}${amt} W`));
    if (e.crit) parts.push(" ", elx("span", "critf", "crit"));
  } else {
    parts.push(atkMe ? name("You") : name(e.atk), " failed on ", defMe ? name("you") : name(e.def), " ");
    parts.push(elx("span", "b", `−${amt} W`));
  }
  for (const p of parts) tx.append(p);
  li.appendChild(tx);
  if (defMe && !atkMe && Date.now() + S.skew - e.at < RB().REVENGE_WINDOW_MS) {
    const rv = elx("button", "rv", "revenge");
    rv.type = "button"; rv.title = `Raid ${e.atk} back`;
    rv.onclick = (ev) => { ev.stopPropagation(); revengeOn(e.atkId); };
    li.appendChild(rv);
  }
  li.appendChild(elx("span", "ag", agoText(e.at)));
  if (FEED.fresh.has(feedKey(e))) li.classList.add("fresh");
  return li;
}
async function revengeOn(pid) {
  openLb();
  await loadLb();
  const r = LB.data && LB.data.rows.find((x) => x.publicId === pid);
  if (r) openRaid(r); else toast("They're not on the leaderboard.", "err");
}
function renderFeed() {
  const box = $("feed");
  if (!S.me) { box.hidden = true; return; }
  box.hidden = false;
  const list = S.raidFeed || [], mine = myPid();
  const sig = list.map(feedKey).join(",") + `|${mine}|${FEED.collapsed}|${Math.floor(Date.now() / 20_000)}`;
  if (sig === FEED.sig) return;
  FEED.sig = sig;
  box.classList.toggle("collapsed", !!FEED.collapsed);
  $("feedHead").setAttribute("aria-expanded", String(!FEED.collapsed));
  $("feedCar").textContent = FEED.collapsed ? "▸" : "▾";
  $("feedCount").textContent = list.length ? `· ${list.length}` : "";
  const ol = $("feedList");
  ol.innerHTML = "";
  if (!list.length) { ol.appendChild(elx("li", "empty", "No raids yet.")); return; }
  for (let i = list.length - 1; i >= 0; i--) ol.appendChild(feedLine(list[i], mine));
  setTimeout(() => { FEED.fresh = new Set(); }, 1300);
}

// ---------- how to play: five short steps, each a tiny live scene drawn from the game's own sprites ----------
// The stage is 192 x 108 (scaled up, pixelated): the packed-dirt wall and straw floor of a den, floor line y = 80.
const TUT_W = 192, TUT_H = 108, TUT_FLOOR = 80;
const tutCv = $("tutCv"), tutCtx = tutCv.getContext("2d");
tutCtx.imageSmoothingEnabled = false;
const tutSkin = () => (S.me && S.me.skin) || "skin_classic";
function tutBg(c, night) {
  const wp = wallpaperCanvas("wp_plain"), fl = floorCanvas("fl_straw");
  c.drawImage(wp, 0, wp.height - TUT_FLOOR, TUT_W, TUT_FLOOR, 0, 0, TUT_W, TUT_FLOOR);
  c.drawImage(fl, 0, 0, TUT_W, fl.height, 0, TUT_FLOOR, TUT_W, fl.height);
  for (let y = TUT_FLOOR + fl.height; y < TUT_H; y += fl.height - 1) c.drawImage(fl, 0, 1, TUT_W, fl.height - 1, 0, y, TUT_W, fl.height - 1); // the flat floor is shorter than the stage: tile it (minus its seam row)
  if (night) { c.fillStyle = "rgba(14,20,58,.5)"; c.fillRect(0, 0, TUT_W, TUT_H); }
}
function tutHam(c, kind, frame, x, y, flip = false) { // x, y: his bottom-centre
  const id = kind === "run" ? "hamster_run" : kind === "sleep" ? "hamster_sleep" : "hamster_sit", skin = tutSkin();
  const dx = Math.round(x - 12), dy = Math.round(y - 24);
  if (sprite(c, id, frame, dx, dy, { flip, skin, remap: (window.SKIN_REMAPS || {})[skin] })) return;
  const img = hamsterFrame(kind, frame, skin);
  if (flip) { c.save(); c.translate(dx + 24, dy); c.scale(-1, 1); c.drawImage(img, 0, 0); c.restore(); }
  else c.drawImage(img, dx, dy);
}
function tutWheel(c, x, y, angle, tier) { // 48 x 50 box, foot on y + 50
  c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(x + 5, y + 50, 38, 2);
  if (sprite(c, "wheel", Math.floor(angle * 24) % 4, x, y, { angle, tier })) { if (tier > 0) sprite(c, `wheel_t${tier}`, frame10, x, y, { angle, tier }); }
  else drawWheelPlaceholder(c, angle, tier, { cx: x + 24, cy: y + 24, r: 23, x, y });
}
function tutBed(c, tier, cx) { // standing on the floor line; returns where a sleeper's bottom-centre goes
  const id = `bed_t${tier}`, s = (window.SPRITES || {})[id];
  const w = (s && s.w) || 28, h = (s && s.h) || 10, sl = (s && s.sleep) || [w >> 1, h - 3];
  const x = Math.round(cx - w / 2), y = TUT_FLOOR - h;
  c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(x + 2, TUT_FLOOR, w - 4, 2);
  if (!sprite(c, id, frame10, x, y, {})) c.drawImage(placeholderItem({ id, name: "bed" }, w, h), x, y);
  return { id, x, y, sx: x + sl[0], sy: y + sl[1] };
}
function tutText(c, str, x, y, col, center = true) {
  const px = Math.round(center ? x - (str.length * 4 - 1) / 2 : x);
  drawText(c, str, px + 1, y + 1, OUTLINE);
  drawText(c, str, px, y, col);
}
// rising "+N W" pops: n of them, one every `every` s, from (x, y) up `rise` px
function tutPops(c, t, str, x, y, n, every, rise, col = "#ffd166") {
  for (let k = 0; k < n; k++) {
    const ph = ((t / every + k / n) % 1 + 1) % 1;
    c.globalAlpha = Math.min(1, (1 - ph) * 2);
    tutText(c, str, x + ((k * 13) % 25) - 12, Math.round(y - ph * rise), col);
  }
  c.globalAlpha = 1;
}
function tutCoin(c, x, y) { fillEllipse(c, x, y, 4, 2.5, OUTLINE); fillEllipse(c, x, y - 0.5, 3, 1.6, "#ffd166"); c.fillStyle = "#c2410c"; c.fillRect(Math.round(x) - 3, Math.round(y) + 1, 6, 1); }
function tutStack(c, x, n) { for (let k = 0; k < n; k++) tutCoin(c, x, TUT_FLOOR - 3 - k * 3); }
function tutArrowUp(c, x, y, col) {
  c.fillStyle = OUTLINE; c.fillRect(x - 1, y + 2, 3, 6); for (let r = 0; r < 4; r++) c.fillRect(x - r - 1, y + r, 2 * r + 3, 1);
  c.fillStyle = col; c.fillRect(x, y + 3, 1, 5); for (let r = 1; r < 3; r++) c.fillRect(x - r, y + r, 2 * r + 1, 1);
}
const TUT_MULT = ["1X", "1.25X", "1.6X", "2X", "2.6X", "3.5X"];

const TUT = [
  { title: "He runs, you earn", text: "Squeektoshi is a real hamster. Every Squeek block he runs generates electricity (Watts), even while you're away.",
    draw(c, t) {
      tutBg(c, false);
      const f = Math.floor(t * 12) % 4;
      tutWheel(c, 72, 30, t * 1.4, 0);
      tutHam(c, "run", f, 96, 74 - (f % 2));
      tutPops(c, t, "+10W", 96, 24, 3, 1.4, 18);
      tutText(c, `BLOCK ${5204 + Math.floor(t * 1.5)}`, 6, 6, "#eef0f5", false);
    } },
  { title: "Sleep pays too", text: "When he naps, your bed earns about half as fast. Keep this tab open for +20%.",
    draw(c, t) {
      tutBg(c, true);
      fillEllipse(c, 168, 18, 8, 8, "#f2e6b8");
      for (const [x, y, k] of [[20, 12, 0], [60, 22, 1], [104, 10, 2], [140, 30, 3]]) if ((Math.floor(t * 2) + k) % 4) { c.fillStyle = "#fff"; c.fillRect(x, y, 1, 1); }
      c.globalAlpha = 0.5; tutWheel(c, 16, 30, 0, 0); c.globalAlpha = 1;
      const b = tutBed(c, 1, 124);
      tutHam(c, "sleep", Math.floor(t * 1.2) % 2, b.sx, b.sy);
      sprite(c, `${b.id}_front`, frame10, b.x, b.y, {});
      for (let k = 0; k < 3; k++) { const ph = (t * 0.45 + k / 3) % 1; c.globalAlpha = 1 - ph; tutText(c, "Z", b.sx + 8 + ph * 10, Math.round(b.sy - 20 - ph * 16), "#eef0f5"); }
      c.globalAlpha = 1;
      tutPops(c, t, "+5W", b.sx - 22, b.sy - 22, 2, 2.6, 14);
    } },
  { title: "Upgrade", text: "A better wheel and a better bed make more Watts. Spend the rest on decorating your den.",
    draw(c, t) {
      tutBg(c, false);
      const step = t / 1.1, tier = Math.floor(step) % 6, ph = step % 1, f = Math.floor(t * 14) % 4;
      tutWheel(c, 24, 30, t * (1.2 + tier * 0.35), tier);
      tutHam(c, "run", f, 48, 74 - (f % 2));
      tutBed(c, tier, 142);
      for (const x of [48, 142]) {
        tutText(c, TUT_MULT[tier], x, 14, tier ? "#ffd166" : "#eef0f5");
        if (tier && ph < 0.6) { c.globalAlpha = 1 - ph / 0.6; tutArrowUp(c, x, Math.round(24 - ph * 10), "#22c55e"); c.globalAlpha = 1; }
        for (let k = 0; k < 5; k++) { c.fillStyle = OUTLINE; c.fillRect(x - 12 + k * 5, 6, 4, 4); c.fillStyle = k < tier ? "#22c55e" : "#4b5563"; c.fillRect(x - 11 + k * 5, 7, 2, 2); }
      }
    } },
  { title: "Raid richer dens", text: "Once your den has earned 5,000 W, wager Watts while he runs to rob a den worth at least 0.7x yours. The richer the target, the better your odds.",
    draw(c, t) {
      tutBg(c, false);
      const P = 2.6, moved = Math.floor(t / P) % 4, p = (t % P) / P, f = Math.floor(t * 14) % 4;
      tutStack(c, 30, 2 + moved);
      tutStack(c, 162, 11 - moved);
      tutText(c, "YOU", 30, 40, "#eef0f5");
      tutText(c, "RICH", 162, 30, "#ffd166");
      const go = p < 0.5, k = go ? p / 0.5 : (p - 0.5) / 0.5, x = go ? lerp(46, 146, k) : lerp(146, 46, k);
      tutHam(c, "run", f, x, TUT_FLOOR - (f % 2), !go);
      if (!go) tutCoin(c, x, TUT_FLOOR - 24 - (f % 2));
      if (Math.floor(t * 2) % 2) tutText(c, "RAIDS OPEN", 96, 8, "#22c55e");
    } },
  { title: "Guard your spot", text: "Getting raided always costs you, and the top of the leaderboard is the juiciest target. Upgrade your den so raids on you fail more often.",
    draw(c, t) {
      tutBg(c, false);
      for (const [x, h, n, col] of [[44, 26, "#2", "#9ca3af"], [96, 40, "#1", "#ffd166"], [148, 16, "#3", "#c2410c"]]) {
        c.fillStyle = OUTLINE; c.fillRect(x - 19, TUT_FLOOR - h - 1, 38, h + 1);
        c.fillStyle = col; c.fillRect(x - 18, TUT_FLOOR - h, 36, h);
        c.fillStyle = "rgba(255,255,255,.35)"; c.fillRect(x - 18, TUT_FLOOR - h, 36, 2);
        drawText(c, n, x - 3, TUT_FLOOR - h + 6, "#1d1a14");
      }
      const top = TUT_FLOOR - 40;
      tutHam(c, "sit", 0, 96, top);
      if (Math.floor(t * 3) % 2) { // the crosshair on the leader
        c.fillStyle = "#ef4444";
        for (const [dx, dy] of [[-15, -28], [11, -28], [-15, -2], [11, -2]]) {
          c.fillRect(96 + dx, top + dy, 4, 1);
          c.fillRect(96 + dx + (dx < 0 ? 0 : 3), top + dy + (dy < -10 ? 0 : -3), 1, 4);
        }
      }
      // his Den's walls, cycling through the materials, turn the raids away
      const tier = Math.floor(t / 1.2) % 6, [hi, mid, lo] = matEdge(tier), sx = 118, sy = top - 26;
      for (let y = 0; y < 21; y++) {
        const half = y < 13 ? 6 : 6 - (y - 12);
        if (half < 0) break;
        c.fillStyle = OUTLINE; c.fillRect(sx - half - 1, sy + y, half * 2 + 3, 1);
        c.fillStyle = y < 2 ? hi : mid; c.fillRect(sx - half, sy + y, half * 2 + 1, 1);
      }
      c.fillStyle = lo; c.fillRect(sx, sy + 2, 1, 14);
      for (let k = 0; k < 2; k++) {
        const ph = (t * 0.8 + k / 2) % 1, ay = sy + 6 + k * 8;
        if (ph < 0.7) { const ax = Math.round(lerp(190, sx + 8, ph / 0.7)); c.fillStyle = "#ef4444"; c.fillRect(ax, ay, 8, 1); c.fillRect(ax + 1, ay - 1, 1, 3); }
        else {
          const q = (ph - 0.7) / 0.3;
          c.globalAlpha = 1 - q; c.fillStyle = "#ffd166";
          for (const [dx, dy] of [[2, -2], [3, 0], [2, 2], [5, -3], [5, 3]]) c.fillRect(Math.round(sx + 7 + dx * (1 + q * 3)), Math.round(ay + dy * (1 + q * 2)), 1, 1);
          c.globalAlpha = 1;
        }
      }
    } },
];
const TUT_SEEN = "sd_tutorial_done";
const tut = { i: 0, raf: 0, t0: 0, back: null, still: matchMedia("(prefers-reduced-motion: reduce)").matches };
const tutDots = TUT.map((s, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("aria-label", `Step ${i + 1}: ${s.title}`);
  b.addEventListener("click", () => tutGo(i));
  $("tutDots").appendChild(b);
  return b;
});
function tutFrame(now) {
  const t = tut.still ? 1.2 : (now - tut.t0) / 1000;
  tutCtx.clearRect(0, 0, TUT_W, TUT_H);
  TUT[tut.i].draw(tutCtx, t);
  if (!tut.still && !$("tut").hidden) tut.raf = requestAnimationFrame(tutFrame);
}
function tutGo(i) {
  tut.i = clamp(i, 0, TUT.length - 1);
  const s = TUT[tut.i], last = tut.i === TUT.length - 1;
  $("tutStep").textContent = `${tut.i + 1} / ${TUT.length}`;
  $("tutTitle").textContent = s.title;
  $("tutText").textContent = s.text;
  $("tutBack").disabled = tut.i === 0;
  $("tutNext").textContent = last ? "Let's go" : "Next";
  tutDots.forEach((b, k) => (k === tut.i ? b.setAttribute("aria-current", "step") : b.removeAttribute("aria-current")));
  cancelAnimationFrame(tut.raf);
  tut.t0 = performance.now();
  tut.raf = requestAnimationFrame(tutFrame);
}
function openTut(i = 0) {
  tut.back = document.activeElement;
  $("tut").hidden = false;
  tutGo(i);
  $("tutNext").focus();
}
function closeTut() {
  $("tut").hidden = true;
  cancelAnimationFrame(tut.raf);
  ls.set(TUT_SEEN, "1");
  if (tut.back && tut.back.focus) tut.back.focus();
  maybeAskName();
}
$("helpBtn").addEventListener("click", () => openTut(0));
$("tutX").addEventListener("click", closeTut);
$("tutBack").addEventListener("click", () => tutGo(tut.i - 1));
$("tutNext").addEventListener("click", () => (tut.i === TUT.length - 1 ? closeTut() : tutGo(tut.i + 1)));
$("tut").addEventListener("click", (e) => { if (e.target === $("tut")) closeTut(); });
addEventListener("keydown", (e) => { // capture phase: while it's open, the room's own keys (Esc, F) stay out of it
  if ($("tut").hidden) return;
  if (e.key === "Escape") closeTut();
  else if (e.key === "ArrowRight") tutGo(tut.i + 1);
  else if (e.key === "ArrowLeft") tutGo(tut.i - 1);
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
let tutSwipe = null;
tutCv.addEventListener("pointerdown", (e) => { tutSwipe = e.clientX; });
tutCv.addEventListener("pointerup", (e) => { // swipe either way; a plain tap moves on
  if (tutSwipe == null) return;
  const dx = e.clientX - tutSwipe;
  tutSwipe = null;
  tutGo(tut.i + (Math.abs(dx) > 30 && dx > 0 ? -1 : 1));
});
if (!ls.get(TUT_SEEN)) setTimeout(() => openTut(0), 300); // first visit

// ---------- onboarding: a den without a username must pick one (after the tutorial) ----------
const nameUi = { open: false, busy: false, err: "" };
function maybeAskName() {
  if (nameUi.open || !S.me || S.me.username || !ls.get(TUT_SEEN) || !$("tut").hidden) return;
  nameUi.open = true;
  nameUi.err = "";
  $("nameModal").hidden = false;
  $("nameInput").value = "";
  nameValidate();
  $("nameInput").focus();
}
function nameValidate() {
  const v = $("nameInput").value, bad = nameProblem(v), hint = $("nameHint");
  hint.className = "whint" + (nameUi.err || (bad && v) ? " bad" : bad ? "" : " good");
  hint.textContent = nameUi.err || bad || "Looks good. We'll check it's free when you save.";
  $("nameSave").disabled = nameUi.busy || !!bad;
  return !bad;
}
async function nameSubmit() {
  if (nameUi.busy || !nameValidate()) return;
  const want = $("nameInput").value;
  nameUi.busy = true;
  $("nameSave").textContent = "Saving…";
  nameValidate();
  const r = await saveUsername(want);
  nameUi.busy = false;
  $("nameSave").textContent = "Save";
  if (r.ok) {
    nameUi.open = false;
    $("nameModal").hidden = true;
    toast(`Welcome, ${r.j.me.username}!`, "ok");
    return;
  }
  nameUi.err = nameErrorWords(r.j, want);
  nameValidate();
  $("nameInput").focus();
}
$("nameInput").addEventListener("input", () => { nameUi.err = ""; nameValidate(); });
$("nameSave").addEventListener("click", nameSubmit);
addEventListener("keydown", (e) => { // capture phase: it can't be dismissed, and the room's keys stay out of it
  if (!nameUi.open || e.key === "Tab") return;
  if (e.key === "Enter") { e.preventDefault(); nameSubmit(); }
  else if (e.key === "Escape") e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// debug handle for the browser console / verification
window.__squeekroom = { S, tut: { TUT, W: TUT_W, H: TUT_H }, ham, wheel, sparks, meter, pops, spawnPop, liveStatus, tintAt, P, checkSpot, enterPlace, select,
  raid: { LB, RU, FEED, raidP, raidStakeBounds, lootRange, openLb, closeLb, openRaid, closeRaid, loadLb, raidFx, applyFeed },
  get iso() { return { ISO, LW, LH, SPOT, IWHEEL, IBURROW, fixture, checkFixture, fixtureRect, colTile, colLeft, footY, tileToCol, screenToTile, wallBase, toFlat, isoRect, bedGeom, laneAt, isoSpan, isoFloor }; },
  get selPid() { return selPid; }, get FX() { return FX; },
  renderNow() { const st = liveStatus(); tick10(); render(st); }, // paints one frame even when rAF is paused (hidden tab)
  renderCert, openCert, closeCert, certLeftWords, get cert() { return certUi.cert; } };
// the narrow surface public/wallet.js builds on (it never touches game internals beyond this)
window.__squeekroom.bridge = { S, post, applyMe, toast, errorWords, refreshLb() { if (LB.open) loadLb(); } };

fit();
renderHud();
loadConfig().then(() => {
  refresh().then(beat);
  setInterval(refresh, 5000);
  setInterval(liveFetch, 10000);
  setInterval(beat, 30000);
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { beat(); refresh(); } });
requestAnimationFrame((t) => { last = t; requestAnimationFrame(loop); });
})();

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
let ROOM = { COLS: 20, ROWS: 12, CELL: 16, FLOOR_ROW: 11, WALL_TOP: 2, WALL_BOTTOM: 7, RESERVED: { wheel: [3, 6], burrow: [16, 18] } };
let CELL = 16, FLOOR_Y = 176; // flat view: furniture bottoms stand on this line; the floor band is below it
const BASEBOARD = 6; // flat view: wall trim height just above the floor line
let FLAT_WHEEL = { cx: 80, cy: 150, r: 23, x: 56, y: 126 }; // 48 x 48 box centred on floor cols 3..6
let FLAT_BURROW = { cx: 280, x: 256, y: 144, w: 48, h: 32 }; // 48 x 32 mound on floor cols 16..18
let FLAT_SPOT = { wheel: { x: 80, y: 170 } };

// ---------- iso view (v2): 2:1 dimetric room, a pure client-side projection of the flat model ----------
// Floor: NI x NJ diamond tiles of 32 x 16. Tile (i, j): i runs down-right along the RIGHT back wall,
// j runs down-left along the LEFT back wall, (0, 0) is the back corner. Tile centre on screen:
//   x = X0 + (i - j) * 16,  y = Y0 + (i + j) * 8 + 8
// Column mapping, the bijection between the server's 20 floor columns and the "lane" tiles lining
// the two back walls (an L that turns at the corner):
//   c <= CORNER (9):  tile (0, CORNER - c)     cols 0..9 run up the left wall into the corner
//   c >  CORNER:      tile (c - CORNER, 0)     cols 10..19 run down the right wall
// so the floor is 11 x 10 (NI = COLS - CORNER, NJ = CORNER + 1). Column c always lands at screen
// x = 24 + 16c: the flat room's left-to-right order and 16-px pitch survive (only y bends into the V of
// the walls), sprite widths still match their column counts, and no multi-column item can split
// (it just bends round the corner, like a sofa pushed into it).
// Inverse (picking, placement ghost): screen -> tile (i, j) -> column CORNER + i - j. Any floor tile
// projects straight back (vertically on screen) onto the lane column in line with it.
// Lanes off a wall: rugs lie flat 2 tiles deep (lanes 0..1) off their wall; the rest of the floor is
// open play area, where the hamster rests and his bed stands (BED_TILE, clear of every column).
// Walls: wall columns share the x pitch (col c spans x 16+16c .. 32+16c); rows 2..7 stack 16 px apart
// above the floor line. The back wall is painted flat into a strip (LW x WALL_H, same x as the screen)
// and then folded: pixel column x drops so its bottom sits on wallBase(x), 1 px per 2 px from the
// corner. Wallpaper, wainscot panels, wall decor and their placement overlays all go through the fold.
// Room material (me.roomTier) frames the room: wainscot panels + wall cap + end posts, the furniture
// lanes and the front border ring of floor tiles, and the floor slab. Inside that frame the equipped
// wallpaper covers the upper walls and the equipped flooring covers the open floor.
const ISO = { CORNER: 9, NI: 11, NJ: 10, X0: 168, Y0: 102, WALL_H: 100, PAD: 8, SLAB: 5, FOOT: 3 };
const LW = ISO.PAD * 2 + (ISO.NI + ISO.NJ) * 16; // 352
const LH = 240; // the floor's front tip (empty floor) runs off the bottom edge: keeps 3x scale on 1080p
const BED_TILE = [7, 2]; // open floor in front of cols 13..14, two tiles off the right wall, left of the burrow
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
// lane space (s along the walls in columns, d tiles out from the wall) -> screen, and back
function laneToScreen(s, d) {
  const left = s < ISO.CORNER + 1, i = left ? d : s - ISO.CORNER, j = left ? ISO.CORNER + 1 - s : d;
  return { x: ISO.X0 + (i - j) * 16, y: ISO.Y0 + (i + j) * 8 };
}
function applyRoom(room) {
  if (room && typeof room === "object") ROOM = { ...ROOM, ...room };
  CELL = ROOM.CELL || 16;
  FLOOR_Y = ROOM.FLOOR_ROW * CELL;
  const [wa, wb] = ROOM.RESERVED.wheel, [ba, bb] = ROOM.RESERVED.burrow;
  const wcx = ((wa + wb + 1) * CELL) / 2, bcx = ((ba + bb + 1) * CELL) / 2;
  FLAT_WHEEL = { cx: wcx, cy: FLOOR_Y - 26, r: 23, x: wcx - 24, y: FLOOR_Y - 50 };
  FLAT_BURROW = { cx: bcx, x: bcx - 24, y: FLOOR_Y - 32, w: 48, h: 32 };
  FLAT_SPOT = { wheel: { x: wcx, y: FLAT_WHEEL.cy + FLAT_WHEEL.r - 3 } };
  // iso: the wheel and the burrow stand on their reserved lane tiles, front-facing
  const iwx = colLeft(wa) + ((wb - wa + 1) * 16) / 2, iwf = footY(wa, wb - wa + 1);
  IWHEEL = { cx: iwx, cy: iwf - 26, r: 23, x: iwx - 24, y: iwf - 50, foot: iwf };
  const ibx = colLeft(ba) + ((bb - ba + 1) * 16) / 2, ibf = footY(ba, bb - ba + 1);
  IBURROW = { cx: ibx, x: ibx - 24, y: ibf - 32, foot: ibf };
  const sit = isoTileCenter(2, ISO.CORNER + 2 - (wb + 1)), bed = isoTileCenter(BED_TILE[0], BED_TILE[1]); // sit: in front of the column right of the wheel
  SPOT = { wheel: { x: iwx, y: IWHEEL.cy + IWHEEL.r - 3 }, sit: { x: sit.x, y: sit.y + 2 }, bed: { x: bed.x, y: bed.y + ISO.FOOT } };
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
  if (typeof j.serverTime === "number") S.skew = j.serverTime - Date.now();
  if (j.me) applyMe(j.me, first, { at: j.serverTime, soft: S.idle });
  else if (j.meError) toast(j.meError === "server_full" ? "The server is full right now." : `Could not load your room (${j.meError}).`, "err");
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
    renderBedLine(me, watching ? 100 + bonus : 100);
  }
  renderRaidChip();
  renderFeed();
  if (LB.open) renderLb(); // keeps "updated Ns ago" and the cooldown lines ticking
  if (RU.open && !RU.result && raidPhase() === "cool") renderRaid();
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
  el.title = S.idle ? "He's asleep: your bed is earning (every room earns, online or not)" : "Bed income: while he sleeps (no block for 10 minutes) every room earns from its bed, online or not";
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
  if (r.ok) toast("The chain has been quiet for 11 minutes. He's asleep: beds are earning.");
  else toast(r.j.error === "night_running" ? "A night is running. Wait for it to end." : `nap failed: ${r.j.error || r.status}`);
  refresh();
};

// ---------- hamster behaviour ----------
// RUN in the wheel while ACTIVE; SLEEP in his bed once he is asleep (the chain's idle signal, or no
// fresh reading at all); otherwise (awake, just not running) REST on the open floor by the wheel,
// blinking. Switching passes through a short SIT at that same spot, with hop/walk moves between.
const SIT_MS = 1400;
const ham = { init: false, mode: "sleep", x: SPOT.bed.x, y: SPOT.bed.y, gy: SPOT.bed.y, face: -1, move: null, sitLeft: 0, runPhase: 0, blink: 0, breath: 0 };
// The bed he sleeps in: me.bedTier's sprite standing on BED_TILE; sleep = where his bottom-centre goes.
function bedGeom() {
  const tier = clamp((S.me && S.me.bedTier) | 0, 0, 5), id = `bed_t${tier}`;
  const s = (window.SPRITES || {})[id];
  const w = (s && s.w) || 28, h = (s && s.h) || 10, sl = (s && s.sleep) || [w >> 1, h - 3];
  const x = Math.round(SPOT.bed.x - w / 2), y = SPOT.bed.y - h;
  return { id, tier, x, y, w, h, foot: SPOT.bed.y, sleepX: x + sl[0], sleepY: y + sl[1] };
}
function spotFor(mode) {
  if (mode === "run") return SPOT.wheel;
  if (mode === "sleep") { const b = bedGeom(); return { x: b.sleepX, y: b.sleepY }; }
  return SPOT.sit;
}
function wantMode(st) {
  if (st.active) return "run";
  return S.idle || st.key !== "idle" ? "sleep" : "rest"; // stale / offline / no reading: he's asleep as far as we know
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
function settle(mode) { ham.mode = mode; ham.face = mode === "run" ? 1 : mode === "sleep" ? -1 : ham.face; }
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
    ham.runPhase += (dt / 1000) * (4 + 10 * clamp(st.speed / 1600, 0, 1)); // run-cycle steps per second scale with speed
  } else if (ham.mode === "sleep") {
    const s = spotFor("sleep"); ham.x = s.x; ham.y = ham.gy = s.y; // a bed upgrade moves the pillow
  }
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
function fit() {
  const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const scaleAt = (pad) => Math.floor(Math.min(((r.width - pad * 2) * dpr) / LW, ((r.height - pad * 2) * dpr) / LH));
  const s = Math.max(1, scaleAt(12), scaleAt(0)); // drop the margin when it alone costs a whole scale step (375-px phones)
  if (view.width !== LW * s) { view.width = LW * s; view.height = LH * s; }
  view.style.width = (LW * s) / dpr + "px";
  view.style.height = (LH * s) / dpr + "px";
}
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
  const wp = (me && me.wallpaper) || "wp_plain", fl = (me && me.floor) || "fl_pine", t = matTier();
  const key = `${wp}|${fl}|${t}|${hasSprite(wp)}|${hasSprite(fl)}|${hasSprite(`floor_mat_t${t}`)}`;
  if (roomBaseCache.key === key) return roomBaseCache.canvas;
  const c = roomBaseCache.canvas || canvas(LW, LH), x = c.getContext("2d");
  x.clearRect(0, 0, LW, LH);
  paintRoomBase(x, wp, fl, t);
  roomBaseCache.key = key;
  roomBaseCache.canvas = c;
  return c;
}
function paintRoomBase(c, wp, fl, t) {
  const [hi, mid, lo] = matEdge(t), H = ISO.WALL_H;
  c.fillStyle = BACKDROP; c.fillRect(0, 0, LW, LH);
  // walls, flat: wallpaper tiled up from the floor line (seams meet the corner), wainscot, cap
  const strip = canvas(LW, H), s = strip.getContext("2d"), sw = swatch(wp, "wallpaper");
  for (let y = H - 16; y > -16; y -= 16) for (let px = WALL_X0; px < WALL_X1; px += 16) s.drawImage(sw, px, y);
  for (let px = WALL_X0; px < WALL_X1; px += 16) {
    if (!sprite(s, `wall_mat_t${t}`, 0, px, H - 32, {})) { s.fillStyle = mid; s.fillRect(px, H - 32, 16, 32); s.fillStyle = lo; s.fillRect(px, H - 32, 1, 32); }
  }
  s.fillStyle = "rgba(0,0,0,.18)"; s.fillRect(WALL_X0, H - 33, WALL_X1 - WALL_X0, 1); // the wainscot's shadow on the wallpaper
  s.fillStyle = hi; s.fillRect(WALL_X0, 0, WALL_X1 - WALL_X0, 1);
  s.fillStyle = mid; s.fillRect(WALL_X0, 1, WALL_X1 - WALL_X0, 1);
  s.fillStyle = "rgba(0,0,0,.3)"; s.fillRect(WALL_X0, 2, WALL_X1 - WALL_X0, 1);
  // fold onto the two back walls; the right wall sits a shade darker (light from the left)
  for (let px = WALL_X0; px < WALL_X1; px++) c.drawImage(strip, px, 0, 1, H, px, stripTop(px), 1, H);
  c.fillStyle = "rgba(0,0,0,.13)";
  for (let px = ISO.X0; px < WALL_X1; px++) c.fillRect(px, stripTop(px), 1, H);
  // end posts in the material (the walls' cut ends)
  for (const [px, col] of [[WALL_X0, lo], [WALL_X0 + 1, mid], [WALL_X1 - 2, mid], [WALL_X1 - 1, lo]]) { c.fillStyle = col; c.fillRect(px, stripTop(px), 1, H); }
  paintFloor(c, fl, t, [hi, mid, lo]);
}
function paintFloor(c, fl, t, [hi, mid, lo]) {
  const img = c.getImageData(0, 0, LW, LH), d = img.data;
  const flTex = rgbaOf(swatch(fl, "floor"));
  const mc = canvas(32, 16), mx = mc.getContext("2d");
  if (!sprite(mx, `floor_mat_t${t}`, 0, 0, 0, {})) mx.drawImage(diamondCanvas(mid, lo), 0, 0);
  const matTex = rgbaOf(mc);
  const bottom = new Int16Array(LW).fill(-1);
  for (let j = 0; j < ISO.NJ; j++) for (let i = 0; i < ISO.NI; i++) {
    const frame = i === 0 || j === 0 || i === ISO.NI - 1 || j === ISO.NJ - 1; // lanes along the walls + the front ring
    const o = isoTileTop(i, j);
    for (let ly = 0; ly < 16; ly++) for (let lx = 0; lx < 32; lx++) {
      if (!DIAMOND[ly * 32 + lx]) continue;
      const X = o.x + lx, Y = o.y + ly;
      if (X < 0 || X >= LW || Y < 0) continue;
      if (Y > bottom[X]) bottom[X] = Y;
      if (Y >= LH) continue;
      let k;
      if (frame) k = (ly * 32 + lx) * 4;
      else { // the flooring swatch on the half-texel iso lattice (2:1 lines stay 2 px per row)
        const u = clamp(Math.floor((lx + 2 * ly - 15) / 2), 0, 15), v = clamp(Math.floor((2 * ly - lx + 16) / 2), 0, 15);
        k = (v * 16 + u) * 4;
      }
      const src = frame ? matTex : flTex, q = (Y * LW + X) * 4;
      if (!src[k + 3]) continue;
      d[q] = src[k]; d[q + 1] = src[k + 1]; d[q + 2] = src[k + 2]; d[q + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  // the open floor sits a touch lower than the frame: a soft inner shadow along its back edges
  c.fillStyle = "rgba(0,0,0,.16)";
  for (let i = 1; i < ISO.NI - 1; i++) { const o = isoTileTop(i, 1); for (let lx = 16; lx < 32; lx++) c.fillRect(o.x + lx, o.y + Math.floor((lx - 15) / 2), 1, 1); }
  for (let j = 1; j < ISO.NJ - 1; j++) { const o = isoTileTop(1, j); for (let lx = 0; lx < 16; lx++) c.fillRect(o.x + lx, o.y + Math.floor((16 - lx) / 2), 1, 1); }
  // slab under the two front edges, in the material
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

// Rugs lie flat in lanes 0..1 off their wall: texel column u -> lane position s = x + u/16, texel row
// v -> d = v/8 tiles out (so the rug art's rows 3..12 cover d 0.4..1.6, under the furniture's front
// and out onto the floor). Each screen pixel maps back through laneAt() and samples the flat rug.
// At the corner the left-wall part and the right-wall part fold round it.
function laneAt(px, py) { // both lane readings of a screen point: [{ s, d, arm }]
  const [i, j] = screenToTile(px, py);
  return [{ s: ISO.CORNER + 1 - j, d: i, arm: "left" }, { s: i + ISO.CORNER, d: j, arm: "right" }]
    .filter((l) => (l.arm === "left" ? l.s < ISO.CORNER + 1 : l.s >= ISO.CORNER + 1));
}
const RUG_DEPTH = 2;
function laneBox(x, w, d0 = 0, d1 = RUG_DEPTH) {
  const pts = [];
  for (const s of [x, x + w, ...(x < ISO.CORNER + 1 && x + w > ISO.CORNER + 1 ? [ISO.CORNER + 1 - 1e-6, ISO.CORNER + 1] : [])]) for (const d of [d0, d1]) pts.push(laneToScreen(s, d));
  const x0 = Math.floor(Math.min(...pts.map((p) => p.x))), x1 = Math.ceil(Math.max(...pts.map((p) => p.x)));
  const y0 = Math.floor(Math.min(...pts.map((p) => p.y))), y1 = Math.ceil(Math.max(...pts.map((p) => p.y)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const rugCache = new Map();
function rugProjection(p, it) {
  const key = `${it.id}|${p.x}|${p.flip ? 1 : 0}|${hasSprite(it.sprite)}`;
  if (rugCache.has(key)) return rugCache.get(key);
  const pw = it.w * CELL, src = canvas(pw, 16);
  drawRugFlat(p, it, 0, src.getContext("2d"), FX, 0, 0);
  const tex = rgbaOf(src), box = laneBox(p.x, it.w), out = canvas(Math.max(1, box.w), Math.max(1, box.h)), oc = out.getContext("2d");
  const img = oc.createImageData(out.width, out.height), d = img.data;
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    for (const l of laneAt(box.x + x + 0.5, box.y + y + 0.5)) {
      if (l.s < p.x || l.s >= p.x + it.w || l.d < 0 || l.d >= RUG_DEPTH) continue;
      const u = Math.floor((l.s - p.x) * 16), v = Math.floor(l.d * 8), k = (v * pw + u) * 4;
      if (!tex[k + 3]) continue;
      const q = (y * out.width + x) * 4;
      d[q] = tex[k]; d[q + 1] = tex[k + 1]; d[q + 2] = tex[k + 2]; d[q + 3] = 255;
      break;
    }
  }
  oc.putImageData(img, 0, 0);
  const r = { canvas: out, x: box.x, y: box.y };
  if (rugCache.size > 200) rugCache.clear();
  rugCache.set(key, r);
  return r;
}
function rugHit(p, it, L) {
  return laneAt(L.x, L.y).some((l) => l.s >= p.x && l.s < p.x + it.w && l.d >= 0 && l.d < RUG_DEPTH);
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
  // 7. placement ghost, zone guides, selection outline (after the tint so they read at night)
  drawPlacement();
  // present: integer-scaled, no smoothing
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(buf, 0, 0, view.width, view.height);
}
// Billboards: every front-facing sprite stands bottom-centre on its tiles. Painter's order is the
// ground line (screen y of the feet = iso depth i + j), then x. Contact shadows go down first.
const SHADOW = () => diamondCanvas("rgba(0,0,0,.2)", null, null, 0.72);
function drawStanding(me) {
  const list = [];
  const shadowCols = (x, w) => { for (let c = x; c < x + w; c++) { const [i, j] = colTile(c); drawTileOverlay(g, i, j, SHADOW()); } };
  for (const [p, it] of itemsIn("floor")) {
    const pw = it.w * CELL, ph = it.h * CELL, x = colLeft(p.x), fy = footY(p.x, it.w);
    shadowCols(p.x, it.w);
    list.push({ d: fy, x, draw: () => drawItem(p, it, x, fy - ph, pw, ph) });
  }
  list.push({ d: IBURROW.foot, x: IBURROW.x, draw: () => { if (!sprite(g, "burrow", frame10, IBURROW.x, IBURROW.y, {})) g.drawImage(burrowCanvas(), IBURROW.x, IBURROW.y); } });
  const tier = (me && me.wheelTier) | 0, [wa, wb] = ROOM.RESERVED.wheel;
  shadowCols(wa + 1, Math.max(1, wb - wa - 1));
  const m = ham.mode === "move" ? ham.move : null;
  const hamInWheel = ham.mode === "run" || (m && m.wheel), hamInBed = ham.mode === "sleep" || (m && m.bed);
  list.push({ d: IWHEEL.foot, x: IWHEEL.x, draw: () => {
    if (sprite(g, "wheel", Math.floor(wheel.angle * 24) % 4, IWHEEL.x, IWHEEL.y, { angle: wheel.angle, tier })) {
      if (tier > 0) sprite(g, `wheel_t${tier}`, frame10, IWHEEL.x, IWHEEL.y, { angle: wheel.angle, tier });
    } else drawWheelPlaceholder(g, wheel.angle, tier);
    if (hamInWheel) drawHamster();
  } });
  const b = bedGeom();
  drawTileOverlay(g, BED_TILE[0], BED_TILE[1], SHADOW());
  list.push({ d: b.foot, x: b.x, draw: () => {
    if (!sprite(g, b.id, frame10, b.x, b.y, {})) g.drawImage(placeholderItem({ id: b.id, name: "bed" }, b.w, b.h), b.x, b.y);
    if (hamInBed) { drawHamster(); if (ham.mode === "sleep") sprite(g, `${b.id}_front`, frame10, b.x, b.y, {}); }
  } });
  if (!hamInWheel && !hamInBed) {
    g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(Math.round(ham.x) - 6, Math.round(ham.gy) - 1, 12, 2); // his own little shadow
    list.push({ d: ham.gy, x: ham.x, draw: drawHamster });
  }
  list.sort((a, c) => a.d - c.d || a.x - c.x);
  for (const e of list) e.draw();
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
// Where an item at server cell (x, y) shows on screen (iso logical pixels). Floor: its billboard
// box. Rug: the bounding box of its two lanes. Wall: the bounding box of the folded rect (wallRect
// is the same rect in flat strip coordinates).
const wallRect = (it, x, y) => ({ x: colLeft(x), y: wallRowY(y), w: it.w * CELL, h: it.h * CELL });
function isoRect(it, x, y) {
  if (it.zone === "wall") {
    const f = wallRect(it, x, y);
    let top = Infinity, bot = -Infinity;
    for (let px = f.x; px < f.x + f.w; px++) { const t = stripTop(clamp(px, WALL_X0, WALL_X1 - 1)) + f.y; top = Math.min(top, t); bot = Math.max(bot, t + f.h); }
    return { x: f.x, y: top, w: f.w, h: bot - top };
  }
  if (it.zone === "rug") return laneBox(x, it.w);
  const ph = it.h * CELL;
  return { x: colLeft(x), y: footY(x, it.w) - ph, w: it.w * CELL, h: ph };
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
    case "wrong_tier": {
      const it = ctx.it, prev = it && it.tier ? `T${it.tier - 1}` : "";
      if (it && it.cat === "bed") return prev ? `Get the ${prev} bed first` : "Beds go in order";
      if (it && it.cat === "room") return prev ? `Build the ${prev} room first` : "Room materials go in order";
      return prev ? `Install the ${prev} wheel upgrade first` : "Wheel upgrades go in order";
    }
    case "already_owned": {
      const cat = ctx.it && ctx.it.cat;
      return cat === "wheel" ? "Your wheel already has that" : cat === "bed" ? "Your bed is already that good" : cat === "room" ? "Your room is already built of that (or better)" : "You already own that";
    }
    case "reserved": return (ctx.which || whichReserved(ctx.it, ctx.x)) === "burrow" ? "That's the burrow. It stays where it is" : "That spot is the wheel's";
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
// Screen (iso) point -> the flat-room point the placement maths (and the server) speak. Floor + rugs:
// screen -> the tile under the pointer -> its lane column (inverse of colTile), as that column's
// centre. Wall: unfold the wall (strip coordinates), then rows count from the top like the flat wall.
function toFlat(L, zone) {
  if (zone === "wall") {
    const px = clamp(Math.floor(L.x), WALL_X0, WALL_X1 - 1);
    return { x: L.x - colLeft(0), y: L.y - stripTop(px) - wallRowY(0) };
  }
  const [i, j] = screenToTile(L.x, L.y);
  return { x: (tileToCol(i, j) + 0.5) * CELL, y: FLOOR_Y };
}
function cellAt(it, Ls) { // the ghost is centred on the pointer and clamped into its zone
  const L = toFlat(Ls, it.zone);
  const x = clamp(Math.round(L.x / CELL - it.w / 2), 0, ROOM.COLS - it.w);
  if (it.zone !== "wall") return { x, y: ROOM.FLOOR_ROW };
  const [y0, y1] = wallYRange(it);
  return { x, y: clamp(Math.round(L.y / CELL - it.h / 2), y0, y1) };
}
function dragCell(Ls) { // dragging keeps the grab offset: the item moves by whole cells (d.lx/ly: flat press point)
  const d = P.drag, it = P.it, L = toFlat(Ls, it.zone);
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
  // Tuber-Simulator-style auto-facing: until the player flips manually, items
  // along the left wall lane mirror to face into the room, right lane faces left.
  if (P.mode === "place" && !P.userFlip) P.flip = c.x + P.it.w / 2 < ROOM.COLS / 2;
  P.valid = checkSpot(P.it, c.x, c.y, P.mode === "move" ? P.pid : null);
  renderPlacing();
}
function hitTest(L) {
  if (!S.me) return null;
  const order = { floor: 0, rug: 1, wall: 2 }; // topmost layer first; floor billboards front-most first
  const depth = (p, it) => (it.zone === "floor" ? footY(p.x, it.w) : 0);
  const list = S.me.placed.map((p) => [p, S.catalog.get(p.item)]).filter(([, it]) => it && it.zone)
    .sort((a, b) => order[a[1].zone] - order[b[1].zone] || depth(...b) - depth(...a));
  const inside = (f, x, y) => x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h;
  const sy = L.y - stripTop(clamp(Math.floor(L.x), WALL_X0, WALL_X1 - 1)); // the pointer on the unfolded wall
  for (const [p, it] of list) {
    if (it.zone === "rug" ? rugHit(p, it, L) : it.zone === "wall" ? inside(wallRect(it, p.x, p.y), L.x, sy) : inside(isoRect(it, p.x, p.y), L.x, L.y)) return p;
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
  const f = isoRect(it, p.x, p.y), cr = view.getBoundingClientRect(), sr = stage.getBoundingClientRect(), k = cr.width / LW;
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
$("pFlip").onclick = () => { if (P.mode) { P.flip = !P.flip; P.userFlip = true; renderPlacing(); } };
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
    const pi = p && S.catalog.get(p.item);
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
    if (P.mode) { P.flip = !P.flip; P.userFlip = true; renderPlacing(); } else if (selPid) flipPlaced(findPlaced(selPid));
  } else if ((e.key === "Delete" || e.key === "Backspace") && selPid && !P.mode) { e.preventDefault(); removePlaced(findPlaced(selPid)); }
});

// in-canvas overlay: zone guides, reserved columns, ghost, selection. Floor + rugs mark lane tiles;
// wall overlays are painted on the flat wall strip and folded with it.
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
function laneTiles(x, w, deep = 1) { const out = []; for (let c = x; c < x + w; c++) { const [i, j] = colTile(c); for (let k = 0; k < deep; k++) out.push(c <= ISO.CORNER ? [i + k, j] : [i, j + k]); } return out; }
function drawPlacement() {
  const now = performance.now();
  if (P.mode && P.it) {
    const it = P.it;
    if (it.zone === "wall") { // cell-corner dots over the wall (light + dark pixel pair so they show on any wallpaper)
      for (let r = ROOM.WALL_TOP; r <= ROOM.WALL_BOTTOM + 1; r++) for (let c = 0; c <= ROOM.COLS; c++) {
        const x = Math.min(colLeft(c), WALL_X1 - 2), y = stripTop(x) + wallRowY(r);
        g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect(x, y, 1, 1); g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(x + 1, y, 1, 1);
      }
    } else { // every lane tile outlined; the wheel's and the burrow's hatched red
      const res = reservedCols();
      for (let c = 0; c < ROOM.COLS; c++) { const [i, j] = colTile(c); drawTileOverlay(g, i, j, res.has(c) ? OV.reserved() : OV.lane()); }
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
        for (const [i, j] of laneTiles(P.cell.x, it.w, it.zone === "rug" ? RUG_DEPTH : 1)) drawTileOverlay(g, i, j, ok ? OV.ok() : OV.bad());
        g.globalAlpha = 0.8;
        if (it.zone === "rug") { const r = rugProjection({ x: P.cell.x, flip: P.flip }, it); g.drawImage(r.canvas, r.x, r.y); }
        else { const f = isoRect(it, P.cell.x, P.cell.y); drawItem({ flip: P.flip }, it, f.x, f.y, f.w, f.h); g.globalAlpha = 1; ring(f, col); }
        g.globalAlpha = 1;
      }
    }
  }
  if (selPid && !P.mode) {
    const p = findPlaced(selPid), it = p && S.catalog.get(p.item);
    if (it && it.zone === "wall") { const f = wallRect(it, p.x, p.y); foldLayer((s) => ants(f.x - 1, f.y - 1, f.w + 2, f.h + 2, now, s), f.x - 1, f.x + f.w + 1); }
    else if (it) {
      for (const [i, j] of laneTiles(p.x, it.w, it.zone === "rug" ? RUG_DEPTH : 1)) drawTileOverlay(g, i, j, OV.sel());
      if (it.zone === "floor") { const f = isoRect(it, p.x, p.y); ants(f.x - 1, f.y - 1, f.w + 2, f.h + 2, now); }
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
  { id: "room", label: "Room", cats: ["room"] },
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
    cur = roomMaterial(tier); to = it.material || it.name; doneNote = tier === it.tier ? `your room is ${to}` : `${to} · built`;
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
    else if (it.cat === "bed") toast(`${it.name} installed: ${(it.multPct / 100).toFixed(2)}× bed watts while he sleeps`, "ok");
    else if (it.cat === "room") toast(`Your room is now ${it.material || it.name}`, "ok");
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
  for (const [p, it] of items("rug").sort((a, b) => a[0].x - b[0].x)) drawRugFlat(p, it, p.x * CELL, c, fx, fr);
  for (const [p, it] of items("floor").sort((a, b) => a[0].x - b[0].x)) {
    const pw = it.w * CELL, ph = it.h * CELL, x = p.x * CELL;
    c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(x + 1, FLOOR_Y, pw - 2, 2);
    drawItem(p, it, x, FLOOR_Y - ph, pw, ph, c, fx, fr);
  }
  if (!sprite(c, "burrow", fr, FLAT_BURROW.x, FLAT_BURROW.y, {})) c.drawImage(burrowCanvas(), FLAT_BURROW.x, FLAT_BURROW.y);
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

// ---------- raids: header chip, leaderboard, raid modal, result, feed ----------
// The server rolls and re-validates every raid (window, cooldown, eligibility, stake); the client
// only mirrors the maths so each option shows its odds, loot range and EV before you commit.
const RAID_DEFAULTS = { EDGE_PCT: 110, MULT_PCT: [150, 200, 300, 500, 1000], DEFENSE_PCT: [0, 5, 10, 15, 20, 25], TILT_EXP: 0.25, TILT_MIN_PCT: 75, TILT_MAX_PCT: 150,
  P_MIN_PCT: 2, P_MAX_PCT: 90, LOOT_U_MIN_PCT: 75, LOOT_U_MAX_PCT: 125, CRIT_CHANCE_PCT: 5, CRIT_MULT_PCT: 150, STAKE_MIN: 50, STAKE_MAX: 5000,
  STAKE_MAX_BALANCE_PCT: 20, ELIGIBLE_MIN_PCT: 70, REVENGE_WINDOW_MS: 86_400_000, COOLDOWN_MS: 1_800_000 };
const RB = () => ({ ...RAID_DEFAULTS, ...((S.balance && S.balance.RAID) || {}) });
// p = clamp((EDGE / M) x (1 - d) x clamp((def / me) ^ 0.25, 0.75, 1.5), 0.02, 0.90), M as a percentage
function raidP(multPct, defTier, myWatts, defWatts) {
  const R = RB();
  const ratio = defWatts / myWatts;
  const tilt = clamp(Number.isNaN(ratio) ? 1 : Math.pow(ratio, R.TILT_EXP), R.TILT_MIN_PCT / 100, R.TILT_MAX_PCT / 100);
  const d = R.DEFENSE_PCT[defTier | 0] ?? R.DEFENSE_PCT[0];
  return clamp((R.EDGE_PCT / multPct) * (1 - d / 100) * tilt, R.P_MIN_PCT / 100, R.P_MAX_PCT / 100);
}
function raidStakeBounds(watts) {
  const R = RB();
  return { min: R.STAKE_MIN, max: Math.min(Math.floor((Math.max(0, watts) * R.STAKE_MAX_BALANCE_PCT) / 100), R.STAKE_MAX) };
}
function lootRange(multPct, stake, defWatts) {
  const R = RB(), cap = Math.max(0, defWatts), base = (multPct - 100) * stake;
  return [Math.min(Math.floor((base * R.LOOT_U_MIN_PCT) / 10_000), cap), Math.min(Math.floor((base * R.LOOT_U_MAX_PCT) / 10_000), cap)];
}
const multLabel = (m) => `${+(m / 100).toFixed(2)}×`;
const pctText = (p) => { const v = p * 100; return `${v < 10 ? +v.toFixed(1) : Math.round(v)}%`; };
const evText = (ev) => { const v = Math.round(ev * 1000) / 10; return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v)}%`; };
const durText = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const agoText = (at) => {
  const s = Math.max(0, Math.round((Date.now() + S.skew - at) / 1000));
  return s < 45 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86_400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`;
};
function elx(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const myPid = () => (S.me && S.me.publicId) || null;

// raid window + this player's cooldown (snapshot every 5 s, the leaderboard, raid replies)
S.raid = null; S.raidFeed = []; S.burned = 0;
function applyRaidStatus(raid) {
  if (!raid || typeof raid !== "object") { S.raid = null; return; }
  S.raid = { open: !!raid.open, cdUntil: Date.now() + Math.max(0, Number(raid.cooldownMsLeft) || 0) };
}
const cooldownLeft = () => (S.raid ? Math.max(0, S.raid.cdUntil - Date.now()) : 0);
function raidPhase() { // none | open | cool | locked
  if (!S.raid || !S.me) return "none";
  if (!S.raid.open) return "locked";
  return cooldownLeft() > 0 ? "cool" : "open";
}
const lockedWhy = () => (S.idle ? "Squeektoshi is sleeping" : "no fresh chain reading");
let chipSig = "";
function renderRaidChip() {
  const el = $("raidChip"), ph = raidPhase();
  el.hidden = ph === "none";
  if (ph === "none") return;
  const html = ph === "open" ? "⚔ RAIDS OPEN" : ph === "cool" ? `⚔ RAIDS OPEN <span class="cd">next raid ${durText(cooldownLeft())}</span>` : `😴 raids locked — ${lockedWhy()}`;
  const sig = ph + html;
  if (sig === chipSig) return;
  chipSig = sig;
  el.className = `raidchip ${ph}`;
  el.innerHTML = html;
  el.title = ph === "locked" ? "Raids open only while Squeektoshi runs. Open the leaderboard" : ph === "cool" ? "Your raid is cooling down. Open the leaderboard" : "Raid a richer room. Open the leaderboard";
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
const rowMatLine = (r) => `${roomMaterial(r.roomTier | 0)} room${defensePct(r.roomTier) ? ` · −${defensePct(r.roomTier)}% odds` : ""}`;
// recomputed against my live watts (the server's flag uses the same rule; it re-checks on raid)
function rowRaidable(r) {
  const me = S.me;
  if (!me || r.you || r.publicId === myPid()) return false;
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
  if (ph === "open") return ["open", "<b>⚔ RAIDS OPEN</b> Squeektoshi is running. Tap a red room to raid it."];
  if (ph === "cool") return ["open", `<b>⚔ RAIDS OPEN</b> Your next raid in <b>${durText(cooldownLeft())}</b> (one raid per 30 min).`];
  if (ph === "locked") return ["", `<b>😴 RAIDS LOCKED</b> ${S.idle ? "Squeektoshi is sleeping. Raids open again when he runs." : "No fresh chain reading right now. Raids open while he runs."}`];
  return ["", "Loading…"];
}
function renderLb() {
  if (!LB.open) return;
  const d = LB.data, me = S.me;
  const [cls, words] = raidStateWords();
  const st = $("lbState");
  st.className = "lbstate" + (cls ? " " + cls : "");
  const targets = d ? d.rows.filter(rowRaidable).length : 0;
  const extra = me ? `<br>You hold <b>${fmt(me.watts)} W</b>: rooms with ≥ ${fmt(minTarget())} W are fair game${d ? ` (${targets} target${targets === 1 ? "" : "s"})` : ""}.` : "";
  st.innerHTML = words + extra;
  const age = LB.at ? Math.round((Date.now() - LB.at) / 1000) : null;
  $("lbMeta").textContent = !d ? (LB.err ? "can't reach the room server" : "loading…") : `${fmt(d.total)} room${d.total === 1 ? "" : "s"} · ${LB.err ? `couldn't refresh, showing ${age}s old` : age < 3 ? "just updated" : `updated ${age}s ago`}`;
  const sig = d ? `${LB.at}|${me ? me.watts : ""}|${raidPhase()}` : "none";
  if (sig === LB.sig) return;
  LB.sig = sig;
  const box = $("lbRows"), focusPid = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.pid : null;
  box.innerHTML = "";
  if (!d) return;
  if (!d.rows.length) { box.appendChild(elx("li", "lbnote", "No rooms yet.")); return; }
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
    if (r.revenge) nm.appendChild(elx("span", "tag rev", "REVENGE!"));
    who.appendChild(nm);
    who.appendChild(elx("span", "mt", rowMatLine(r)));
    row.appendChild(who);
    const wt = elx("span", "wt", `${fmt(r.watts)} W`);
    if (raidable && me) {
      const ev = raidP(200, r.roomTier, me.watts, r.watts) * 2 - 1;
      const sm = elx("small"); sm.appendChild(elx("span", ev >= 0 ? "pos" : "neg", `EV ${evText(ev)}`)); wt.appendChild(sm);
      wt.appendChild(elx("span", "go", "RAID ⚔"));
    } else wt.appendChild(elx("small", null, you ? (r.rank === 1 ? "the crown: pure prey" : "you") : "< 70% of you"));
    row.title = raidable ? `Raid ${rowName(r)}${r.revenge ? " (revenge)" : ""}` : you ? "Your room" : `Below 70% of your watts (< ${fmt(minTarget())} W): punch up only`;
    row.setAttribute("aria-label", `Rank ${r.rank}, ${rowName(r)}${r.verified ? " (wallet verified)" : ""}${you ? " (you)" : ""}, ${roomMaterial(r.roomTier | 0)} room, ${fmt(r.watts)} watts${raidable ? ", raidable" : ""}${r.revenge ? ", revenge" : ""}`);
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
function stakeNow() { const b = raidStakeBounds(S.me ? S.me.watts : 0); return { ...b, v: clamp(Math.round(RU.stake) || b.min, b.min, Math.max(b.min, b.max)) }; }
function openRaid(row) {
  if (!row || !S.me) return;
  if (!RU.open) RU.back = document.activeElement;
  RU.open = true; RU.row = row; RU.result = null; RU.busy = false;
  if (!RU.stake) { const b = raidStakeBounds(S.me.watts); RU.stake = clamp(Math.floor(b.max / 2), b.min, Math.max(b.min, b.max)); }
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
    b.innerHTML = `<span class="mx"></span><span class="pc"></span><span class="lt"></span><span class="ev"></span>`;
    b.querySelector(".mx").innerHTML = m >= 1000 ? `${multLabel(m)}<small>HEIST</small>` : multLabel(m);
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
  if (ph === "locked") return { lock: true, msg: `<b>😴 RAIDS LOCKED</b> ${S.idle ? "Squeektoshi is sleeping. Raids open again the moment he runs." : "No fresh chain reading right now. Raids open while he runs."}` };
  if (ph === "cool") return { lock: true, msg: `<b>⏳ COOLING DOWN</b> Your next raid in ${durText(cooldownLeft())}. One raid per 30 minutes.` };
  if (sb.max < sb.min) return { lock: true, msg: `<b>TOO POOR TO RAID</b> Stakes start at ${fmt(sb.min)} W and can be at most 20% of your watts: you need ${fmt(Math.ceil((sb.min * 100) / RB().STAKE_MAX_BALANCE_PCT))} W.` };
  if (!rowRaidable(t)) return { lock: true, msg: `<b>OUT OF REACH</b> ${escapeHtml(rowName(t))} holds less than 70% of your watts now (needs ≥ ${fmt(minTarget())} W). Punch up only.` };
  return null;
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
    const who = elx("div"); { const tn = elx("div", "tn", rowName(t)); if (t.verified) tn.appendChild(verifiedBadge()); who.appendChild(tn); } who.appendChild(elx("div", "tm", `#${t.rank} · ${rowMatLine(t)}`));
    tb.appendChild(who);
    const w = elx("div", "tw", `${fmt(t.watts)} W`); w.appendChild(elx("small", null, "their watts")); tb.appendChild(w);
  }
  const rev = !!t.revenge;
  $("raidBox").classList.toggle("revenge", rev);
  $("raidRev").hidden = !rev;
  $("raidTitle").textContent = rev ? "⚔ REVENGE RAID" : "⚔ RAID";
  $("raidSub").textContent = rev ? `pay ${rowName(t)} back` : `one roll · win their watts or burn your stake`;
  if (RU.result) return; // the result view is showing
  const sb = stakeNow(), S0 = sb.v, myW = me.watts;
  // multiplier rows
  let selP = 0;
  for (const b of $("raidMults").children) {
    const m = Number(b.dataset.m), p = raidP(m, t.roomTier, myW, t.watts), ev = p * (m / 100) - 1, [lo, hi] = lootRange(m, S0, t.watts);
    if (m === RU.mult) selP = p;
    b.setAttribute("aria-checked", String(m === RU.mult));
    b.tabIndex = m === RU.mult ? 0 : -1;
    b.querySelector(".pc").innerHTML = `${pctText(p)}<small>WIN</small>`;
    b.querySelector(".lt").innerHTML = `+${fmt(lo)}–${fmt(hi)} W<small>LOOT IF WON</small>`;
    const evEl = b.querySelector(".ev");
    evEl.className = "ev " + (ev >= 0 ? "pos" : "neg");
    evEl.innerHTML = `${evText(ev)}<small>EV</small>`;
    b.setAttribute("aria-label", `${multLabel(m)}${m >= 1000 ? " heist" : ""}: ${pctText(p)} win chance, loot ${fmt(lo)} to ${fmt(hi)} watts, expected value ${evText(ev)}`);
  }
  // stake controls (left alone while being typed in)
  const num = $("stakeNum"), rng2 = $("stakeRange"), maxShown = Math.max(sb.min, sb.max);
  num.min = rng2.min = String(sb.min); num.max = rng2.max = String(maxShown);
  if (document.activeElement !== num) num.value = String(S0);
  rng2.value = String(S0);
  rng2.disabled = num.disabled = sb.max < sb.min;
  $("stakeBounds").textContent = sb.max < sb.min ? "you can't stake yet" : `${fmt(sb.min)}–${fmt(sb.max)} W${sb.max === R.STAKE_MAX ? " (cap)" : " (20% of yours)"}`;
  // summary + EV warning
  const m = RU.mult, ev = selP * (m / 100) - 1, [lo, hi] = lootRange(m, S0, t.watts), critHi = Math.min(Math.floor((hi * R.CRIT_MULT_PCT) / 100), t.watts);
  const sum = $("raidSum");
  sum.className = "rsum" + (ev < 0 ? " negev" : "");
  sum.innerHTML = `<b class="pos">Win ${pctText(selP)}</b>: take <b>${fmt(lo)}–${fmt(hi)} W</b> from ${escapeHtml(rowName(t))} (${R.CRIT_CHANCE_PCT}% crit: up to ${fmt(critHi)} W)<br>`
    + `<b class="neg">Lose ${pctText(1 - selP)}</b>: your <b>${fmt(S0)} W</b> stake is burned. Nobody gets it.<br>`
    + `EV <b class="${ev >= 0 ? "pos" : "neg"}">${evText(ev)}</b> = ${ev >= 0 ? "+" : "−"}${fmt(Math.abs(ev * S0))} W per raid on average`
    + (ev < 0 ? `<span class="warn">⚠ Negative EV: their ${roomMaterial(t.roomTier | 0).toLowerCase()} walls${t.watts < myW ? " and smaller purse" : ""} make this a losing bet on average.</span>` : "");
  // lock banner + button
  const blk = raidBlock(t, sb), lock = $("raidLock");
  lock.hidden = !blk;
  if (blk) lock.innerHTML = blk.msg;
  const go = $("raidGo");
  go.disabled = !!blk || RU.busy;
  go.classList.toggle("busy", RU.busy);
  go.textContent = RU.busy ? "ROLLING…" : rev ? `⚔ REVENGE! (${fmt(S0)} W)` : `⚔ RAID! (${fmt(S0)} W at ${multLabel(m)})`;
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
document.querySelectorAll("#raidForm [data-q]").forEach((b) => (b.onclick = () => { const sb = stakeNow(); setStake(b.dataset.q === "max" ? sb.max : sb.min); }));
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
    case "hamster_asleep": return "Too late: Squeektoshi just fell asleep. Raids are locked until he runs again.";
    case "chain_unknown": return "Raids are locked: the room server hasn't seen a block yet.";
    case "chain_stale": return "Raids are locked: the chain reading went stale. They reopen with a fresh block.";
    case "cooldown": return `Still cooling down: your next raid in ${durText(j.cooldownMsLeft || 0)}.`;
    case "bad_target": return "That room doesn't exist any more.";
    case "not_eligible": return `${t ? rowName(t) : "They"} dropped below 70% of your watts. Punch up only (or wait for revenge).`;
    case "self_target": return "You can't raid your own room.";
    case "bad_mult": return "Pick a multiplier first.";
    case "bad_stake": case "stake_out_of_range": return j.max < j.min ? `You can't stake yet: stakes start at ${fmt(j.min)} W (max 20% of your watts).` : `Stake must be a whole number from ${fmt(j.min)} to ${fmt(j.max)} W.`;
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
  if (e === "cooldown") applyRaidStatus({ open: true, cooldownMsLeft: j.cooldownMsLeft });
  else if (e === "hamster_asleep" || e === "chain_unknown" || e === "chain_stale") { if (S.raid) S.raid.open = false; else applyRaidStatus({ open: false }); }
  else if (e === "stake_out_of_range" || e === "bad_stake") { if (Number.isFinite(j.max) && j.max >= j.min) RU.stake = clamp(sb.v, j.min, j.max); refresh(); }
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
  applyRaidStatus({ open: true, cooldownMsLeft: RB().COOLDOWN_MS });
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
    $("resBig").textContent = res.revenge ? "REVENGE TAKEN!" : "RAID WON!";
    $("resDet").textContent = `You took ${fmt(res.loot)} W from ${rowName(t)} · ${multLabel(m)} at ${pctText(res.p)} odds · next raid in ${durText(RB().COOLDOWN_MS)}`;
    countUp($("resAmt"), res.loot, res.crit ? 1700 : 1200);
    for (let i = 0; i < (res.crit ? 36 : 22); i++) {
      const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 110, p = elx("i", "fxp coin");
      p.style.setProperty("--dx", `${Math.round(Math.cos(a) * d)}px`); p.style.setProperty("--dy", `${Math.round(Math.sin(a) * d * 0.7)}px`);
      p.style.animationDelay = `${Math.round(Math.random() * 250)}ms`;
      box.appendChild(p);
    }
    raidFx(res.crit ? "crit" : "win");
    gainFlash(res.loot);
    toast(`${res.crit ? "CRIT! " : ""}You raided ${rowName(t)}: +${fmt(res.loot)} W`, "ok");
  } else {
    $("resBig").textContent = "RAID FAILED";
    $("resAmt").textContent = `−${fmt(res.stakeLost || res.stake)} W`;
    $("resDet").textContent = `Stake burned to ash at ${pctText(res.p)} odds. ${rowName(t)} keeps everything · next raid in ${durText(RB().COOLDOWN_MS)}`;
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
  toast(w ? `⚔ ${e.atk} raided you${e.crit ? " with a CRIT" : ""}! −${fmt(e.amount)} W. Revenge is open for 24 h.` : `🛡 ${e.atk} tried to raid you and burned ${fmt(e.amount)} W. Revenge is open for 24 h.`, w ? "err" : undefined);
  for (const id of ["feed", "stage"]) { const n = $(id); n.classList.remove("hit"); void n.offsetWidth; n.classList.add("hit"); setTimeout(() => n.classList.remove("hit"), 1600); }
  if (w) { const m = $("meter"); m.classList.remove("poor"); void m.offsetWidth; m.classList.add("poor"); setTimeout(() => m.classList.remove("poor"), 900); }
  raidFx("hit");
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
    parts.push("⚔ ", atkMe ? name("YOU") : name(e.atk), " raided ", defMe ? name("YOU") : name(e.def), " ");
    parts.push(elx("span", "w", `${atkMe ? "+" : "−"}${amt} W`));
    if (e.crit) parts.push(" ", elx("span", "critf", "CRIT!"));
  } else {
    parts.push("💥 ", atkMe ? name("YOU") : name(e.atk), atkMe ? " failed on " : defMe ? " tried to raid " : " failed to raid ", defMe ? name("YOU") : name(e.def), " ");
    parts.push(elx("span", "b", `${amt} W burned`));
  }
  for (const p of parts) tx.append(p);
  li.appendChild(tx);
  if (defMe && !atkMe && Date.now() + S.skew - e.at < RB().REVENGE_WINDOW_MS) {
    const rv = elx("button", "rv", "REVENGE");
    rv.type = "button"; rv.title = `Raid ${e.atk} back (ignores the 70% rule, once)`;
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
  if (r) openRaid(r); else toast("They aren't on the leaderboard right now.", "err");
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
  if (!list.length) { ol.appendChild(elx("li", "empty", "No raids yet. Raids open while Squeektoshi runs: punch up!")); return; }
  for (let i = list.length - 1; i >= 0; i--) ol.appendChild(feedLine(list[i], mine));
  setTimeout(() => { FEED.fresh = new Set(); }, 1300);
}

// debug handle for the browser console / verification
window.__squeekroom = { S, ham, wheel, sparks, meter, liveStatus, tintAt, P, checkSpot, enterPlace, select,
  raid: { LB, RU, FEED, raidP, raidStakeBounds, lootRange, openLb, closeLb, openRaid, closeRaid, loadLb, raidFx, applyFeed },
  get iso() { return { ISO, LW, LH, SPOT, IWHEEL, IBURROW, BED_TILE, colTile, colLeft, footY, tileToCol, screenToTile, wallBase, toFlat, isoRect, bedGeom, laneAt }; },
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

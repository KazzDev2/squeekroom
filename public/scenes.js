// The "how to play" scenes: tiny live pictures drawn from the game's own sprites (sprites*.js,
// loaded first). Shared by the tutorial in game.js and the guide page. Each stage is 192 x 108, shown
// scaled up and pixelated: the plain wallpaper and straw floor of a den, floor line y = 80.
//   SqueekScenes.scenes[i] = { title, text, draw(ctx, seconds, { skin }) }: the tutorial's five steps
//   SqueekScenes.all: those, then the guide-only ones (lucky crates, golden blocks)
(() => {
"use strict";
const TUT_W = 192, TUT_H = 108, TUT_FLOOR = 80;
const PALETTE = ["", "#000000", "#ffffff", "#f5a623", "#c2410c", "#7c3f1d", "#ffd166", "#3b82f6", "#1e3a8a", "#22c55e", "#166534", "#ef4444", "#f472b6", "#9ca3af", "#4b5563", "#a78bfa"];
const OUTLINE = "#1d1a14";
const FONT = {A:[2,5,7,5,5],B:[6,5,6,5,6],C:[3,4,4,4,3],D:[6,5,5,5,6],E:[7,4,6,4,7],F:[7,4,6,4,4],G:[3,4,5,5,3],H:[5,5,7,5,5],I:[7,2,2,2,7],J:[1,1,1,5,2],K:[5,5,6,5,5],L:[4,4,4,4,7],M:[5,7,7,5,5],N:[6,5,5,5,5],O:[2,5,5,5,2],P:[6,5,6,4,4],Q:[2,5,5,6,3],R:[6,5,6,5,5],S:[3,4,2,1,6],T:[7,2,2,2,2],U:[5,5,5,5,7],V:[5,5,5,5,2],W:[5,5,7,7,5],X:[5,5,2,5,5],Y:[5,5,2,2,2],Z:[7,1,2,4,7],"0":[2,5,5,5,2],"1":[2,6,2,2,7],"2":[6,1,2,4,7],"3":[6,1,2,1,6],"4":[5,5,7,1,1],"5":[7,4,6,1,6],"6":[3,4,6,5,2],"7":[7,1,2,2,2],"8":[2,5,2,5,2],"9":[2,5,3,1,6],"!":[2,2,2,0,2],"?":[6,1,2,0,2],".":[0,0,0,0,2],",":[0,0,0,2,4],"-":[0,0,7,0,0],"$":[3,6,2,3,6],"#":[5,7,5,7,5],"<":[1,2,4,2,1],"+":[0,2,7,2,0],"/":[1,1,2,4,4]," ":[0,0,0,0,0]};
function drawText(c, str, x, y, color) {
  c.fillStyle = color;
  let cx = x;
  for (const ch of str) {
    const gl = FONT[ch] || FONT["?"];
    for (let r = 0; r < 5; r++) for (let b = 0; b < 3; b++) if (gl[r] & (4 >> b)) c.fillRect(cx + b, y + r, 1, 1);
    cx += 4;
  }
}
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
const lerp = (a, b, t) => a + (b - a) * t;
function sprite(c, id, frame, x, y, opts) {
  const s = (window.SPRITES || {})[id];
  if (!s || (typeof s !== "function" && typeof window.drawSprite !== "function")) return false;
  try {
    if (typeof s === "function") s(c, frame, x, y, opts || {});
    else window.drawSprite(c, s, frame, x, y, opts || {});
    return true;
  } catch { return false; }
}
function matEdge(t) { const s = (window.SPRITES || {})[`floor_mat_t${t}`]; return ((s && s.edge) || [2, 13, 14]).map((i) => PALETTE[i] || "#888888"); }
let frame10 = 0, skin = "skin_classic"; // set per draw: 10 fps sprite frames, the hamster's skin
const tutSkin = () => skin;

function tutBg(c, night) {
  for (let y = 0; y < TUT_FLOOR - 6; y += 16) for (let x = 0; x < TUT_W; x += 16) sprite(c, "wp_plain", 0, x, y, {});
  c.fillStyle = "rgba(0,0,0,.12)"; c.fillRect(0, 0, TUT_W, 2); // crown trim + baseboard, as in the den
  c.fillStyle = "#7c3f1d"; c.fillRect(0, TUT_FLOOR - 6, TUT_W, 6);
  c.fillStyle = "#a35a2a"; c.fillRect(0, TUT_FLOOR - 6, TUT_W, 1);
  c.fillStyle = "#5a2d14"; c.fillRect(0, TUT_FLOOR - 1, TUT_W, 1);
  for (let y = TUT_FLOOR; y < TUT_H; y += 16) for (let x = 0; x < TUT_W; x += 16) sprite(c, "fl_straw", 0, x, y, {});
  c.fillStyle = "rgba(0,0,0,.18)"; c.fillRect(0, TUT_FLOOR, TUT_W, 1);
  if (night) { c.fillStyle = "rgba(14,20,58,.5)"; c.fillRect(0, 0, TUT_W, TUT_H); }
}
function tutHam(c, kind, frame, x, y, flip = false) { // x, y: his bottom-centre
  const id = kind === "run" ? "hamster_run" : kind === "sleep" ? "hamster_sleep" : "hamster_sit";
  sprite(c, id, frame, Math.round(x - 12), Math.round(y - 24), { flip, skin, remap: (window.SKIN_REMAPS || {})[skin] });
}
function tutWheel(c, x, y, angle, tier) { // 48 x 50 box, foot on y + 50
  c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(x + 5, y + 50, 38, 2);
  if (sprite(c, "wheel", Math.floor(angle * 24) % 4, x, y, { angle, tier }) && tier > 0) sprite(c, `wheel_t${tier}`, frame10, x, y, { angle, tier });
}
function tutBed(c, tier, cx) { // standing on the floor line; returns where a sleeper's bottom-centre goes
  const id = `bed_t${tier}`, s = (window.SPRITES || {})[id];
  const w = (s && s.w) || 28, h = (s && s.h) || 10, sl = (s && s.sleep) || [w >> 1, h - 3];
  const x = Math.round(cx - w / 2), y = TUT_FLOOR - h;
  c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(x + 2, TUT_FLOOR, w - 4, 2);
  sprite(c, id, frame10, x, y, {});
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
const TUT_MULT = ["1X", "1.25X", "1.6X", "2X"];
const TUT_CURSOR = ["1.....", "11....", "121...", "1221..", "12221.", "122221", "12211.", "11.121", "....11"];
function tutCursor(c, x, y) { // a little pointer, tip at (x, y)
  for (let r = 0; r < TUT_CURSOR.length; r++) for (let k = 0; k < 6; k++) {
    const p = TUT_CURSOR[r][k];
    if (p !== ".") { c.fillStyle = p === "1" ? OUTLINE : "#ffffff"; c.fillRect(x + k, y + r, 1, 1); }
  }
}
function tutBurst(c, t, x, y, n, r0, r1, cols) { // a ring of sparks flying out, t in 0..1
  c.globalAlpha = Math.max(0, 1 - t);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2, r = lerp(r0, r1, t);
    c.fillStyle = cols[k % cols.length];
    c.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y + Math.sin(a) * r * 0.75), k % 2 ? 1 : 2, k % 2 ? 1 : 2);
  }
  c.globalAlpha = 1;
}
function tutBanner(c, str, x, y, col) { // a label on a dark strip, so gold reads on the cream wall and straw
  const w = str.length * 4 + 5;
  c.fillStyle = "rgba(29,26,20,.78)"; c.fillRect(Math.round(x - w / 2), y - 2, w, 10);
  tutText(c, str, x, y, col);
}
function tutFlash(c, a) { if (a > 0) { c.fillStyle = `rgba(255,209,102,${a.toFixed(3)})`; c.fillRect(0, 0, TUT_W, TUT_H); } }

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
      const step = t / 1.1, tier = Math.floor(step) % TUT_MULT.length, ph = step % 1, f = Math.floor(t * 14) % 4;
      tutWheel(c, 24, 30, t * (1.2 + tier * 0.35), tier);
      tutHam(c, "run", f, 48, 74 - (f % 2));
      tutBed(c, tier, 142);
      for (const x of [48, 142]) {
        tutText(c, TUT_MULT[tier], x, 14, tier ? "#ffd166" : "#eef0f5");
        if (tier && ph < 0.6) { c.globalAlpha = 1 - ph / 0.6; tutArrowUp(c, x, Math.round(24 - ph * 10), "#22c55e"); c.globalAlpha = 1; }
        for (let k = 0; k < 3; k++) { c.fillStyle = OUTLINE; c.fillRect(x - 7 + k * 5, 6, 4, 4); c.fillStyle = k < tier ? "#22c55e" : "#4b5563"; c.fillRect(x - 6 + k * 5, 7, 2, 2); }
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

// guide-only scenes
const EXTRA = [
  { title: "Lucky crates", text: "While you watch, a block can drop a crate in your den. Tap it to see what's inside.",
    draw(c, t) {
      tutBg(c, false);
      const P = 4, n = Math.floor(t / P), p = t % P, f = Math.floor(t * 12) % 4;
      tutWheel(c, 16, 30, t * 1.4, 0);
      tutHam(c, "run", f, 40, 74 - (f % 2));
      tutText(c, `BLOCK ${5204 + Math.floor(t * 1.5)}`, 6, 6, "#eef0f5", false);
      const cx = 128, rest = TUT_FLOOR - 16;
      if (p < 2.2) {
        let y;
        if (p < 0.6) y = lerp(-18, rest, (p / 0.6) ** 2); // it drops in
        else if (p < 0.8) y = rest - Math.round(Math.sin(((p - 0.6) / 0.2) * Math.PI) * 4); // one bounce
        else y = rest - (Math.floor(p * 3) % 4 === 0 ? 1 : 0); // and a little hop now and then
        if (p > 0.4) { c.fillStyle = "rgba(0,0,0,.2)"; c.fillRect(cx - 7, TUT_FLOOR, 14, 2); }
        if (!sprite(c, "crate", 0, cx - 8, Math.round(y), {})) { c.fillStyle = OUTLINE; c.fillRect(cx - 8, Math.round(y), 16, 16); c.fillStyle = "#c2410c"; c.fillRect(cx - 7, Math.round(y) + 1, 14, 14); }
        if (p >= 0.8 && (p * 1.4) % 1 < 0.5) { const sy = rest - 2 - Math.round(((p * 1.4) % 1) * 6); c.fillStyle = "#fff8d0"; c.fillRect(cx + 7, sy - 1, 1, 3); c.fillRect(cx + 6, sy, 3, 1); }
        if (p >= 1.3) { const k = Math.min(1, (p - 1.3) / 0.6), press = p >= 1.95 ? 1 : 0; tutCursor(c, Math.round(lerp(176, cx + 1, k)), Math.round(lerp(104, rest + 7, k)) + press); }
      } else {
        const q = (p - 2.2) / 1.8;
        const [str, col] = [["+400W", "#ffd166"], ["BOOST", "#ffd166"], ["SHIELD", "#ffd166"], ["RARE", "#f472b6"]][n % 4];
        tutBurst(c, Math.min(1, q * 1.6), cx, rest + 8, 12, 3, 26, [col, "#fff8d0"]);
        c.globalAlpha = Math.min(1, (1 - q) * 2);
        tutBanner(c, str, cx, Math.round(rest - 2 - q * 18), col);
        c.globalAlpha = 1;
        tutFlash(c, q < 0.25 ? 0.3 * (1 - q / 0.25) : 0);
      }
    } },
  { title: "Golden blocks", text: "Now and then a block is golden, and it pays ten times the watts to everyone watching.",
    draw(c, t) {
      tutBg(c, false);
      const P = 5, p = t % P, gold = p >= 2.8, q = gold ? (p - 2.8) / 2.2 : 0, f = Math.floor(t * 12) % 4;
      tutWheel(c, 72, 30, t * (gold ? 2.2 : 1.4), 0);
      tutHam(c, "run", f, 96, 74 - (f % 2));
      tutText(c, `BLOCK ${5204 + Math.floor(t / P) * 3 + (p < 1.4 ? 0 : gold ? 2 : 1)}`, 6, 6, gold ? "#ffd166" : "#eef0f5", false);
      for (const s of [0, 1.4]) { // two plain blocks first
        if (p < s || p >= s + 1.3) continue;
        const k = (p - s) / 1.3;
        c.globalAlpha = Math.min(1, (1 - k) * 2);
        tutText(c, "+10W", 96, Math.round(24 - k * 16), "#eef0f5");
        c.globalAlpha = 1;
      }
      if (gold) {
        for (let k = 0; k < 9; k++) { // a shower of watts
          const x = 14 + ((k * 53) % 166), y = Math.round(-6 + (q * 1.6 - (k % 4) * 0.12) * 100);
          if (y > -6 && y < TUT_FLOOR - 2) tutCoin(c, x, y);
        }
        tutBurst(c, Math.min(1, q * 1.4), 96, 54, 18, 8, 60, ["#ffd166", "#fff8d0", "#f5a623"]);
        c.globalAlpha = Math.min(1, (1 - q) * 2);
        tutBanner(c, "+100W", 96, Math.round(26 - q * 16), "#ffd166");
        c.globalAlpha = 1;
        if (Math.floor(p * 4) % 2) tutBanner(c, "GOLDEN BLOCK", 96, 92, "#ffd166");
        tutFlash(c, q < 0.3 ? 0.45 * (1 - q / 0.3) : 0);
      }
    } },
];
const wrap = (s) => ({
  title: s.title,
  text: s.text,
  draw(c, t, o = {}) {
    frame10 = Math.floor(t * 10);
    skin = o.skin || "skin_classic";
    s.draw(c, t);
  },
});
const scenes = TUT.map(wrap);
window.SqueekScenes = { W: TUT_W, H: TUT_H, scenes, all: [...scenes, ...EXTRA.map(wrap)],
  px: { drawText, text: tutText, banner: tutBanner, coin: tutCoin, fillEllipse, OUTLINE } }; // the pixel helpers, for other pages
})();

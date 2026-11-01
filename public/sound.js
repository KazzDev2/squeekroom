// Squeek Den sound: little synthesized effects (made live with WebAudio) and two CC0 music tracks.
// Browsers only allow sound after a click or key, so nothing plays before that.
//   SqueekSound.sfx(name, opts)   SqueekSound.music("den" | "drop")   SqueekSound.button(el)
// Mode (localStorage sd_sound): "all" (music + effects), "sfx" (effects only), "off".
window.SqueekSound = (() => {
"use strict";
const KEY = "sd_sound", MODES = ["all", "sfx", "off"];
let mode = "all";
try { const m = localStorage.getItem(KEY); if (MODES.includes(m)) mode = m; } catch {}
let ctx = null, master = null, musicBus = null, sfxBus = null, noiseBuf = null, pulse = {};
let song = null, playing = null;
const buttons = new Set(), last = new Map();

// ---------- the audio graph ----------
function init() {
  if (ctx) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = 0.55;
  const comp = ctx.createDynamicsCompressor(); // keeps a jackpot from clipping
  comp.threshold.value = -14; comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);
  musicBus = ctx.createGain(); musicBus.gain.value = 0.0001; musicBus.connect(master);
  sfxBus = ctx.createGain(); sfxBus.gain.value = 0.7; sfxBus.connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  for (const duty of [0.125, 0.25]) { // chiptune pulse waves
    const n = 32, re = new Float32Array(n), im = new Float32Array(n);
    for (let k = 1; k < n; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
    pulse[duty] = ctx.createPeriodicWave(re, im);
  }
  return true;
}
function unlock() {
  if (!init()) return;
  if (ctx.state === "suspended") ctx.resume();
  if (mode === "all" && song && !playing) startMusic();
}
for (const ev of ["pointerdown", "keydown", "touchend"]) addEventListener(ev, unlock, { capture: true, passive: true });
document.addEventListener("visibilitychange", () => { // quiet in a hidden tab
  if (!ctx) return;
  if (document.hidden) { ctx.suspend(); if (el) el.pause(); }
  else if (mode !== "off") { ctx.resume(); if (playing && el) el.play().catch(() => {}); }
});

// ---------- building blocks ----------
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function hz(name) { // "C5", "Bb4", "F#3"
  const m = /^([A-G])(b|#)?(\d)$/.exec(name);
  if (!m) return 0;
  const semi = NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * Math.pow(2, (semi - 69) / 12);
}
function tone(bus, { f, f2 = 0, at = 0, dur = 0.1, type = "square", duty = 0, vol = 0.2, attack = 0.004, release = 0.06 }) {
  const t = at || ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  if (duty) o.setPeriodicWave(pulse[duty]); else o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.setValueAtTime(vol, t + Math.max(attack, dur - release));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(bus);
  o.start(t); o.stop(t + dur + 0.02);
}
function noise(bus, { at = 0, dur = 0.08, vol = 0.15, freq = 3000, type = "bandpass", q = 1 }) {
  const t = at || ctx.currentTime, s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf;
  fl.type = type; fl.frequency.value = freq; fl.Q.value = q;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(fl).connect(g).connect(bus);
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
}
const arp = (notes, gap, o) => notes.forEach((n, i) => tone(sfxBus, { f: hz(n), at: ctx.currentTime + i * gap, ...o }));

// ---------- effects ----------
const SCALE = ["C5", "D5", "E5", "G5", "A5", "C6", "D6", "E6"];
const FX = {
  // Burrow Drop
  peg: (o) => tone(sfxBus, { f: 900 + (o.pitch || 0) * 500, dur: 0.035, duty: 0.25, vol: 0.05 }),
  root: () => tone(sfxBus, { f: 150, f2: 90, dur: 0.09, type: "triangle", vol: 0.22 }),
  acorn: () => tone(sfxBus, { f: 260, f2: 820, dur: 0.16, type: "sine", vol: 0.25 }),
  wheel: () => { tone(sfxBus, { f: 520, f2: 260, dur: 0.14, duty: 0.125, vol: 0.06 }); noise(sfxBus, { dur: 0.1, vol: 0.05, freq: 1800 }); },
  seed: (o) => { const k = Math.min(SCALE.length - 1, (o.chain || 1) - 1); tone(sfxBus, { f: hz(SCALE[k]), dur: 0.09, duty: 0.25, vol: 0.13 }); tone(sfxBus, { f: hz(SCALE[k]) * 2, at: ctx.currentTime + 0.05, dur: 0.08, duty: 0.125, vol: 0.07 }); },
  crateHit: () => { noise(sfxBus, { dur: 0.12, vol: 0.25, freq: 900, q: 0.8 }); tone(sfxBus, { f: 180, f2: 120, dur: 0.1, type: "square", vol: 0.08 }); },
  crateOpen: () => { noise(sfxBus, { dur: 0.25, vol: 0.18, freq: 5000, type: "highpass" }); arp(["E5", "G5", "C6", "E6"], 0.06, { dur: 0.14, duty: 0.25, vol: 0.12 }); },
  drop: () => tone(sfxBus, { f: 700, f2: 220, dur: 0.18, duty: 0.25, vol: 0.1 }),
  land: (o) => {
    if (o.slot === "dead") arp(["E4", "C4"], 0.12, { dur: 0.2, type: "triangle", vol: 0.22 });
    else if (o.slot === "nest") arp(["C5", "E5", "G5"], 0.07, { dur: 0.16, duty: 0.25, vol: 0.12 });
    else arp(["C5", "E5", "G5", "C6", "G5", "C6"], 0.06, { dur: 0.14, duty: 0.25, vol: 0.13 });
  },
  jackpot: () => {
    arp(["C5", "E5", "G5", "C6", "E6", "G6", "C7"], 0.055, { dur: 0.16, duty: 0.25, vol: 0.13 });
    const t = ctx.currentTime + 0.42;
    for (const n of ["C5", "E5", "G5", "C6"]) tone(sfxBus, { f: hz(n), at: t, dur: 1.1, duty: 0.125, vol: 0.07, release: 0.6 });
    for (let k = 0; k < 10; k++) tone(sfxBus, { f: 2000 + Math.random() * 2500, at: t + 0.1 + k * 0.08, dur: 0.05, type: "sine", vol: 0.05 });
  },
  coin: () => { tone(sfxBus, { f: hz("B5"), dur: 0.06, duty: 0.25, vol: 0.1 }); tone(sfxBus, { f: hz("E6"), at: ctx.currentTime + 0.06, dur: 0.18, duty: 0.25, vol: 0.1 }); },
  // the den
  earn: () => tone(sfxBus, { f: hz("G6"), dur: 0.05, type: "sine", vol: 0.06 }),
  buy: () => FX.coin(),
  place: () => { tone(sfxBus, { f: 200, f2: 120, dur: 0.07, type: "triangle", vol: 0.18 }); noise(sfxBus, { dur: 0.05, vol: 0.06, freq: 1200 }); },
  click: () => tone(sfxBus, { f: 1200, dur: 0.025, duty: 0.25, vol: 0.04 }),
  whack: () => { tone(sfxBus, { f: 320, f2: 110, dur: 0.1, type: "square", vol: 0.12 }); noise(sfxBus, { dur: 0.08, vol: 0.12, freq: 700 }); },
  raidWin: (o) => o.crit ? FX.jackpot() : arp(["C5", "E5", "G5", "C6"], 0.07, { dur: 0.15, duty: 0.25, vol: 0.13 }),
  raidLose: () => { tone(sfxBus, { f: hz("G4"), f2: hz("E4"), dur: 0.25, type: "triangle", vol: 0.2 }); tone(sfxBus, { f: hz("Eb4"), f2: hz("C4"), at: ctx.currentTime + 0.26, dur: 0.4, type: "triangle", vol: 0.2 }); },
  raided: () => { noise(sfxBus, { dur: 0.18, vol: 0.2, freq: 500, q: 0.7 }); tone(sfxBus, { f: 220, f2: 110, dur: 0.25, type: "square", vol: 0.07 }); },
  crateDrop: () => arp(["G5", "C6"], 0.09, { dur: 0.14, duty: 0.25, vol: 0.11 }),
  golden: () => { arp(["E6", "G6", "C7", "G6", "C7"], 0.07, { dur: 0.12, type: "sine", vol: 0.12 }); },
};
function sfx(name, o = {}) {
  if (mode === "off" || !ctx || ctx.state !== "running" || !FX[name]) return;
  const gap = o.gap ?? (name === "peg" ? 0.03 : name === "earn" ? 0.25 : 0.015); // no machine-gun repeats
  const now = ctx.currentTime;
  if (now - (last.get(name) || -1) < gap) return;
  last.set(name, now);
  try { FX[name](o); } catch {}
}

// ---------- music ----------
// Two CC0 (public domain) tracks from opengameart.org, streamed by an <audio> element and routed
// through the music bus, so the speaker button and fades work the same.
const TRACKS = {
  den: { src: "music/chill_lofi.mp3", type: "audio/mpeg", vol: 0.25 }, // "Chill lofi inspired" by omfgdude
  drop: { src: "music/pixel_sprinter_loop.ogg", type: 'audio/ogg; codecs="vorbis"', vol: 0.21 }, // "Pixel Sprinter" (loop) by Zane Little Music
};
const canPlay = (type) => { try { return !!new Audio().canPlayType(type); } catch { return false; } };
let el = null, elNode = null;
function startMusic() {
  if (!ctx || mode !== "all" || !song) return;
  const tr = TRACKS[song];
  if (!canPlay(tr.type)) return; // e.g. no Ogg Vorbis on older Safari: effects only
  if (!el) {
    el = new Audio();
    el.loop = true;
    el.preload = "auto";
    elNode = ctx.createMediaElementSource(el);
    elNode.connect(musicBus);
  }
  if (!el.src.endsWith(tr.src)) el.src = tr.src;
  playing = tr;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), ctx.currentTime);
  musicBus.gain.exponentialRampToValueAtTime(tr.vol, ctx.currentTime + 1.5);
  if (!document.hidden) el.play().catch(() => {});
}
function stopMusic() {
  playing = null;
  if (!ctx || !el) return;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
  setTimeout(() => { if (!playing && el) el.pause(); }, 700);
}

// ---------- the switch ----------
const ICON = {
  all: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13.5 3.5a6.5 6.5 0 0 1 0 9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  sfx: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11.5 5.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  off: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const LABEL = { all: "Sound: music and effects", sfx: "Sound: effects only", off: "Sound: off" };
function paint() {
  for (const b of buttons) { b.innerHTML = ICON[mode]; b.title = LABEL[mode]; b.setAttribute("aria-label", LABEL[mode]); b.dataset.mode = mode; }
}
function setMode(m) {
  mode = m;
  try { localStorage.setItem(KEY, m); } catch {}
  if (m === "all") { unlock(); startMusic(); } else stopMusic();
  if (m !== "off") { unlock(); sfx("click"); }
  paint();
}
function button(el) {
  if (!el) return;
  buttons.add(el);
  el.addEventListener("click", () => setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]));
  paint();
}
function music(name) {
  if (!TRACKS[name] || song === name) return;
  song = name;
  if (ctx && mode === "all") startMusic();
}

return { sfx, music, button, setMode, get mode() { return mode; }, get state() { return { ctx: ctx ? ctx.state : null, song, playing: !!playing, el: el ? { src: el.src, paused: el.paused, t: el.currentTime } : null } } };
})();

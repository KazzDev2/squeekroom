// Squeek Den sound: little synthesized effects and two chiptune loops, all made live with WebAudio
// (no audio files). Browsers only allow sound after a click or key, so nothing plays before that.
//   SqueekSound.sfx(name, opts)   SqueekSound.music("den" | "drop")   SqueekSound.button(el)
// Mode (localStorage sd_sound): "all" (music + effects), "sfx" (effects only), "off".
window.SqueekSound = (() => {
"use strict";
const KEY = "sd_sound", MODES = ["all", "sfx", "off"];
let mode = "all";
try { const m = localStorage.getItem(KEY); if (MODES.includes(m)) mode = m; } catch {}
let ctx = null, master = null, musicBus = null, sfxBus = null, noiseBuf = null, pulse = {};
let song = null, playing = null, step = 0, nextAt = 0, timer = 0;
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
  if (document.hidden) ctx.suspend(); else if (mode !== "off") ctx.resume();
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
// Each song: tempo (8th notes per minute), parts as bars of 8 steps: a note, "." rest, "-" hold.
const SONGS = {
  den: { // "Burrow Lullaby": soft, F major, loops every 16 bars
    bpm8: 184, swing: 0.06,
    lead: [
      "A4 . C5 . F5 - E5 C5", "D5 - - . A4 . F4 .", "Bb4 . D5 . F5 - E5 D5", "C5 - - . G4 . E4 .",
      "A4 . C5 . F5 - G5 A5", "E5 - - . C5 . A4 .", "D5 . Bb4 . E5 . C5 .", "F5 - - - . . . .",
      "F5 . D5 . Bb4 . D5 .", "E5 . C5 . G4 . C5 .", "C5 . A4 . E4 . A4 .", "F5 - E5 - D5 - C5 -",
      "D5 . F5 . Bb5 - A5 G5", "G5 - E5 . C5 . E5 .", "D5 . C5 . Bb4 . A4 .", "G4 - - - C5 . E5 .",
    ],
    bass: [
      "F2 . C3 . F2 . C3 .", "D2 . A2 . D2 . A2 .", "Bb1 . F2 . Bb1 . F2 .", "C2 . G2 . C2 . G2 .",
      "F2 . C3 . F2 . C3 .", "A1 . E2 . A1 . E2 .", "Bb1 . F2 . C2 . G2 .", "F2 . C3 . F2 . . .",
      "Bb1 . F2 . Bb1 . F2 .", "C2 . G2 . C2 . G2 .", "A1 . E2 . A1 . E2 .", "D2 . A2 . D2 . A2 .",
      "Bb1 . F2 . Bb1 . F2 .", "C2 . G2 . C2 . G2 .", "Bb1 . F2 . Bb1 . F2 .", "C2 . G2 . C2 . . .",
    ],
    drums: ["k . h . . . h .", "k . h . . . h h"],
    vol: { lead: 0.055, bass: 0.11, kick: 0.16, hat: 0.018 }, leadDuty: 0.25,
  },
  drop: { // "Tunnel Hop": bouncy, C major
    bpm8: 280, swing: 0,
    lead: [
      "C5 . E5 G5 . E5 C5 .", "A4 . C5 E5 . C5 A4 .", "F4 . A4 C5 . F5 E5 D5", "D5 - B4 . G4 . B4 D5",
      "E5 . G5 . C6 - G5 E5", "A5 - E5 . C5 . E5 .", "F5 . A5 . G5 . B5 .", "C6 - - . G5 . E5 .",
    ],
    bass: [
      "C2 C3 C2 C3 C2 C3 C2 C3", "A1 A2 A1 A2 A1 A2 A1 A2", "F1 F2 F1 F2 F1 F2 F1 F2", "G1 G2 G1 G2 G1 G2 G1 G2",
      "C2 C3 C2 C3 C2 C3 C2 C3", "A1 A2 A1 A2 A1 A2 A1 A2", "F1 F2 F1 F2 G1 G2 G1 G2", "C2 C3 C2 C3 G1 G2 B1 B2",
    ],
    drums: ["k . h . s . h .", "k . h k s . h h"],
    vol: { lead: 0.05, bass: 0.085, kick: 0.2, hat: 0.025, snare: 0.06 }, leadDuty: 0.125,
  },
};
const parse = (bars) => bars.join(" ").trim().split(/\s+/);
function compile(s) {
  const lead = parse(s.lead), bass = parse(s.bass), n = lead.length;
  const notes = (seq, len) => seq.map((tok, i) => {
    if (tok === "." || tok === "-") return null;
    let hold = 1;
    while (i + hold < len && seq[(i + hold) % len] === "-") hold++;
    return { f: hz(tok), hold };
  });
  return { ...s, n, lead: notes(lead, n), bass: notes(bass, bass.length), drums: s.drums.map((b) => b.split(" ")) };
}
const COMPILED = {};
function startMusic() {
  if (!ctx || mode !== "all" || !song) return;
  const s = COMPILED[song] || (COMPILED[song] = compile(SONGS[song]));
  playing = s; step = 0; nextAt = ctx.currentTime + 0.08;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), ctx.currentTime);
  musicBus.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 1.2);
  clearInterval(timer);
  timer = setInterval(schedule, 25);
  schedule();
}
function stopMusic() {
  clearInterval(timer); timer = 0; playing = null;
  if (ctx) { musicBus.gain.cancelScheduledValues(ctx.currentTime); musicBus.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15); }
}
function schedule() {
  const s = playing;
  if (!s || !ctx) return;
  const dt = 60 / s.bpm8;
  while (nextAt < ctx.currentTime + 0.3) { // a little ahead, so a busy frame never makes the music stutter
    const i = step % s.n, at = nextAt + (i % 2 ? s.swing * dt : 0), V = s.vol;
    const L = s.lead[i];
    if (L) tone(musicBus, { f: L.f, at, dur: L.hold * dt * 0.92, duty: s.leadDuty, vol: V.lead, attack: 0.01, release: 0.08 });
    const B = s.bass[i % s.bass.length];
    if (B) tone(musicBus, { f: B.f, at, dur: Math.min(B.hold * dt, dt * 1.6) * 0.9, type: "triangle", vol: V.bass, attack: 0.005, release: 0.05 });
    const bar = Math.floor(step / 8), d = s.drums[bar % s.drums.length][i % 8];
    if (d === "k") tone(musicBus, { f: 150, f2: 45, at, dur: 0.12, type: "sine", vol: V.kick });
    else if (d === "h") noise(musicBus, { at, dur: 0.035, vol: V.hat, freq: 8000, type: "highpass" });
    else if (d === "s") noise(musicBus, { at, dur: 0.11, vol: V.snare || 0.05, freq: 1800, q: 0.6 });
    nextAt += dt; step++;
  }
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
  if (!SONGS[name] || song === name) return;
  song = name;
  if (ctx && mode === "all") startMusic();
}

return { sfx, music, button, setMode, get mode() { return mode; }, get state() { return { ctx: ctx ? ctx.state : null, song, playing: !!playing, step } } };
})();

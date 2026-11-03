// The guide's numbers come from /api/config (BALANCE), so the page never goes stale. Each
// <b data-g="key"> keeps a written fallback in the HTML; a key that can't be worked out keeps it.
(() => {
"use strict";
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const mult = (pct) => `${+(pct / 100).toFixed(2)}×`;
const dur = (ms) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
};
const max = (a) => Math.max(...a);
// key -> how to write it from BALANCE; each is tried on its own, so one missing key keeps one default
const KEYS = {
  perBlock: (B) => `${fmt(B.BASE_WATTS_PER_BLOCK)} W`,
  wheelMax: (B) => mult(max(B.WHEEL_MULT_PCT)),
  bedHalf: (B) => (B.BED_AWAKE_PCT === 50 ? "half" : `${B.BED_AWAKE_PCT}% as`),
  bedMax: (B) => mult(max(B.BED_MULT_PCT)),
  live: (B) => `+${B.LIVE_BONUS_PCT - 100}%`,
  speed: (B) => `+${B.SPEED.MAX_PCT - 100}%`,
  welcome: (B) => `${fmt(B.WELCOME_WATTS)} W`,
  defense: (B) => `${max(B.RAID.DEFENSE_PCT)}%`,
  perDay: (B) => String(B.RAID.PER_DAY),
  eligible: (B) => `${B.RAID.ELIGIBLE_MIN_PCT}%`,
  revenge: (B) => dur(B.RAID.REVENGE_WINDOW_MS),
  mults: (B) => `${mult(Math.min(...B.RAID.MULT_PCT))} to ${mult(max(B.RAID.MULT_PCT))}`,
  lootCap: (B) => `${B.RAID.LOOT_MAX_DEF_PCT}%`,
  crit: (B) => `${B.RAID.CRIT_CHANCE_PCT}%`,
  runBonus: (B) => `${B.RAID.RUN_BONUS_PCT}%`,
  bruise: (B) => dur(B.SHIELD.BRUISE_MS),
  crateChance: (B) => `${B.CRATES.CHANCE_PCT}%`,
  cratesDay: (B) => String(B.CRATES.PER_DAY),
  cratesWaiting: (B) => String(B.CRATES.MAX_UNOPENED),
  petSlots: (B) => String(B.PETS.SLOTS),
  crateWatts: (B) => `${fmt(B.CRATES.WATTS_MIN)}–${fmt(B.CRATES.WATTS_MAX)} W`,
  dw: (B) => `${mult(B.BOOSTS.double_wheel.PCT)} wheel Watts for ${dur(B.BOOSTS.double_wheel.MS)}`,
  ds: (B) => `+${B.BOOSTS.deep_sleep.PCT - 100}% bed income for ${dur(B.BOOSTS.deep_sleep.MS)}`,
  lw: (B) => `+${B.BOOSTS.lucky_whisker.ODDS_PTS} points on your next raid`,
  wi: (B) => (B.BOOSTS.wager_insurance.REFUND_PCT === 50 ? "half" : `${B.BOOSTS.wager_insurance.REFUND_PCT}% of`),
  shield: (B) => dur(B.SHIELD.MS),
  dropCost: (B) => `${fmt(B.DROP.COST)} W`,
  payDead: (B) => mult(B.DROP.PAY.dead * 100),
  payNest: (B) => mult(B.DROP.PAY.nest * 100),
  payPantry: (B) => mult(B.DROP.PAY.pantry * 100),
  bountyFeed: (B) => `${B.DROP.STASH_FEED_PCT}%`,
  bountyStart: (B) => `${fmt(B.DROP.COST * B.DROP.STASH_START)} W`,
  goldenOneIn: (B) => fmt(B.GOLDEN.ONE_IN),
  goldenMult: (B) => mult(B.GOLDEN.MULT_PCT),
};
fetch("/api/config", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((cfg) => {
    const B = cfg && cfg.balance;
    if (!B) return;
    for (const el of document.querySelectorAll("b[data-g]")) {
      const f = KEYS[el.dataset.g];
      let v = null;
      try { v = f ? f(B) : null; } catch {}
      if (typeof v === "string" && v && !/undefined|NaN|Infinity/.test(v)) el.textContent = v;
    }
  })
  .catch(() => {}); // offline: the written defaults stay

// The tutorial's live scenes (scenes.js), each drawn only while it's on screen. Reduced motion: one still frame.
const SC = window.SqueekScenes;
if (SC) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const items = [...document.querySelectorAll("canvas[data-scene]")].map((cv) => {
    const s = (SC.all || SC.scenes)[+cv.dataset.scene], c = cv.getContext("2d");
    c.imageSmoothingEnabled = false;
    const cap = document.querySelector(`figcaption[data-title="${cv.dataset.scene}"]`);
    if (cap && s) cap.textContent = s.title;
    return { cv, c, s, on: false };
  }).filter((x) => x.s);
  const draw = (x, t) => { x.c.clearRect(0, 0, SC.W, SC.H); try { x.s.draw(x.c, t); } catch {} };
  if (still) items.forEach((x) => draw(x, 1.2));
  else {
    const t0 = performance.now();
    let raf = 0;
    const frame = (now) => {
      raf = 0;
      const live = items.filter((x) => x.on);
      for (const x of live) draw(x, (now - t0) / 1000);
      if (live.length) raf = requestAnimationFrame(frame);
    };
    const io = new IntersectionObserver((es) => {
      for (const e of es) { const x = items.find((y) => y.cv === e.target); if (x) x.on = e.isIntersecting; }
      if (!raf) raf = requestAnimationFrame(frame);
    });
    items.forEach((x) => { draw(x, 0); io.observe(x.cv); });
  }
}
})();

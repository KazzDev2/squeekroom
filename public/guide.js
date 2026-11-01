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
  minEarned: (B) => `${fmt(B.RAID.MIN_EARNED)} W`,
  eligible: (B) => `${B.RAID.ELIGIBLE_MIN_PCT}%`,
  revenge: (B) => dur(B.RAID.REVENGE_WINDOW_MS),
  mults: (B) => `${mult(Math.min(...B.RAID.MULT_PCT))} to ${mult(max(B.RAID.MULT_PCT))}`,
  lootCap: (B) => `${B.RAID.LOOT_MAX_DEF_PCT}%`,
  crit: (B) => `${B.RAID.CRIT_CHANCE_PCT}%`,
  bruise: (B) => dur(B.SHIELD.BRUISE_MS),
  crateChance: (B) => `${B.CRATES.CHANCE_PCT}%`,
  cratesDay: (B) => String(B.CRATES.PER_DAY),
  cratesWaiting: (B) => String(B.CRATES.MAX_UNOPENED),
  crateWatts: (B) => `${fmt(B.CRATES.WATTS_MIN)}–${fmt(B.CRATES.WATTS_MAX)} W`,
  dw: (B) => `${mult(B.BOOSTS.double_wheel.PCT)} wheel watts for ${dur(B.BOOSTS.double_wheel.MS)}`,
  ds: (B) => `+${B.BOOSTS.deep_sleep.PCT - 100}% bed income for ${dur(B.BOOSTS.deep_sleep.MS)}`,
  lw: (B) => `+${B.BOOSTS.lucky_whisker.ODDS_PTS} points on your next raid`,
  wi: (B) => (B.BOOSTS.wager_insurance.REFUND_PCT === 50 ? "half" : `${B.BOOSTS.wager_insurance.REFUND_PCT}% of`),
  shield: (B) => dur(B.SHIELD.MS),
  goldenOneIn: (B) => fmt(B.GOLDEN.ONE_IN),
  goldenMult: (B) => mult(B.GOLDEN.MULT_PCT),
  certWatts: (B) => fmt(B.CERT_LIFETIME_WATTS),
  certDays: (B) => String(B.CERT_ACTIVE_DAYS),
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
})();

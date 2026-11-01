// Security alerts to a Discord webhook: posts (with @everyone) when the server looks hacked or got
// an unauthorized update. Zero dependencies.
//
// The webhook URL comes ONLY from the ALERT_WEBHOOK env var (the repo is public: never commit it).
// No env var -> every call is a silent no-op, so local runs and tests never post anything.
//
// Triggers (each deduped by key, cooldown persisted in <DATA_DIR>/alerts.json so a crash loop
// can't spam, plus a global hourly cap):
//   - deploy: on boot on Railway, the commit (RAILWAY_GIT_COMMIT_SHA) must be on main of the repo
//     (GitHub compare API: identical/behind). Off main, another repo/branch, or no git source at all
//     (a `railway up` upload) -> @everyone. A normal deploy posts one quiet line (ALERT_DEPLOY_NOTICE=0
//     turns it off). GitHub unreachable -> a quiet "couldn't verify" line, never a ping.
//   - demo mode on in production (free watts via /api/dev/grant) -> @everyone.
//   - state.json changed or deleted by something other than this server -> @everyone.
//   - watts supply grew faster than wheel + bed + welcome grants can pay, or a balance that is not a
//     non-negative finite number -> @everyone. Purchases never create watts; raid crits do, and the
//     server counts them in state.minted, which is subtracted here. The bound is
//     generous on purpose (room for v3's boosts, golden blocks and crates); ALERT_SUPPLY=0 turns it off.
//   - quiet lines only: a burst of 5xx server_error, /api/dev/* probed while not in demo mode.
//
// Env: ALERT_WEBHOOK (https://discord.com/api/webhooks/...), ALERT_DEPLOY_NOTICE=0, ALERT_SUPPLY=0,
//      ALERT_REPO (default KazzDev2/squeekroom), ALERT_BRANCH (default main).

const fs = require("node:fs");
const path = require("node:path");

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const DEFAULTS = {
  COOLDOWN_MS: 6 * 3_600_000, // the same alert key at most once per 6 h
  QUIET_COOLDOWN_MS: 3_600_000,
  EVERYONE_PER_HOUR: 6, // global caps, whatever the keys
  MESSAGES_PER_HOUR: 20,
  TIMEOUT_MS: 8000,
  CONTENT_MAX: 1900, // Discord's limit is 2000
};

// Untrusted text (paths, names, commit messages) never pings anyone or breaks out of code spans.
const safe = (s, n = 120) => String(s == null ? "" : s).replace(/[`\u0000-\u001f\u007f]/g, " ").replace(/@/g, "@​").trim().slice(0, n);
const fmt = (n) => Math.round(n).toLocaleString("en-US");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(obj));
    fs.renameSync(file + ".tmp", file);
  } catch (e) {
    console.error("alert store: write failed:", e.message || e);
  }
}

// ---------- the webhook poster: dedupe, rate limit, never throws ----------
function createAlerter({ webhook = null, fetchFn = globalThis.fetch, storeFile = null, now = Date.now, log = console, limits = {} } = {}) {
  const L = { ...DEFAULTS, ...limits };
  const valid = typeof webhook === "string" && WEBHOOK_RE.test(webhook.trim());
  if (webhook && !valid) log.error("alert: ALERT_WEBHOOK is not a Discord webhook URL; alerts are off");
  const url = valid ? webhook.trim() : null;
  const store = (storeFile && readJson(storeFile)) || {};
  if (!store.sent || typeof store.sent !== "object") store.sent = {};
  const recent = []; // [{ at, everyone }] within the last hour
  const inflight = new Set();

  const persist = () => storeFile && writeJson(storeFile, store);
  // Returns a promise of true when the message was posted.
  function send(key, text, { everyone = true, cooldownMs = everyone ? L.COOLDOWN_MS : L.QUIET_COOLDOWN_MS } = {}) {
    if (!url) return Promise.resolve(false);
    const t = now();
    const last = store.sent[key];
    if (Number.isFinite(last) && t - last < cooldownMs) return Promise.resolve(false);
    while (recent.length && t - recent[0].at >= 3_600_000) recent.shift();
    if (recent.length >= L.MESSAGES_PER_HOUR || (everyone && recent.filter((r) => r.everyone).length >= L.EVERYONE_PER_HOUR)) {
      log.error(`alert: rate limited, dropped ${key}`);
      return Promise.resolve(false);
    }
    recent.push({ at: t, everyone });
    store.sent[key] = t;
    for (const [k, at] of Object.entries(store.sent)) if (t - at > 7 * 86_400_000) delete store.sent[k];
    persist();
    const content = `${everyone ? "@everyone 🚨 " : ""}${text}`.slice(0, L.CONTENT_MAX);
    log.error(`alert: ${content}`);
    const p = (async () => {
      try {
        const r = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "Squeek Den security", content, allowed_mentions: { parse: everyone ? ["everyone"] : [] } }),
          signal: AbortSignal.timeout(L.TIMEOUT_MS),
        });
        if (!r.ok) throw new Error(`webhook status ${r.status}`);
        return true;
      } catch (e) {
        log.error("alert: post failed:", e.message || e);
        if (store.sent[key] === t) delete store.sent[key]; // not delivered: the next trigger may retry
        return false;
      }
    })();
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  }
  return { enabled: !!url, send, store, persist, settle: () => Promise.all([...inflight]) };
}

// ---------- deploy check ----------
const onRailway = (env) => !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// GitHub's verdict on a commit: "on" (main contains it), "off" (it isn't on main), "missing" (the repo
// is reachable but has no such commit) or "unknown" (GitHub unreachable / rate limited).
async function commitOnBranch(sha, { repo, branch, fetchFn, sleep = wait, tries = 3 }) {
  const get = (p) => fetchFn(`https://api.github.com/repos/${repo}${p}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "Squeekroom-alert (+https://github.com/KazzDev2/squeekroom)" },
    signal: AbortSignal.timeout(DEFAULTS.TIMEOUT_MS),
  });
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(5000 * 4 ** (i - 1));
    try {
      const r = await get(`/compare/${encodeURIComponent(branch)}...${sha}`);
      if (r.ok) {
        const c = await r.json();
        if (c.status === "identical" || c.status === "behind") return { verdict: "on", status: c.status };
        if (c.status === "ahead" || c.status === "diverged") return { verdict: "off", status: c.status };
        continue;
      }
      if (r.status === 404) {
        const repoRes = await get("");
        if (repoRes.ok) return { verdict: "missing", status: 404 };
      }
    } catch {}
  }
  return { verdict: "unknown" };
}

async function checkDeploy(env, { alerter, fetchFn = globalThis.fetch, sleep = wait } = {}) {
  if (!onRailway(env)) return { skipped: "not on railway" };
  const repo = env.ALERT_REPO || "KazzDev2/squeekroom";
  const branch = env.ALERT_BRANCH || "main";
  const sha = String(env.RAILWAY_GIT_COMMIT_SHA || "").trim();
  const short = safe(sha.slice(0, 7), 12);
  const who = `by ${safe(env.RAILWAY_GIT_AUTHOR || "unknown")}`;
  const msg = env.RAILWAY_GIT_COMMIT_MESSAGE ? `: ${safe(String(env.RAILWAY_GIT_COMMIT_MESSAGE).split("\n")[0], 100)}` : "";
  const where = `Railway ${safe(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || "?", 40)} deployment ${safe(env.RAILWAY_DEPLOYMENT_ID || "?", 40)}`;
  const bad = (key, why) => alerter.send(key, `**Squeek Den: unauthorized deploy?** ${why} (${where}). Check Railway → Deployments and GitHub now.`).then(() => ({ alert: key }));
  if (!sha) return bad(`deploy:nogit:${env.RAILWAY_DEPLOYMENT_ID || "?"}`, "This deploy has no git source (uploaded with `railway up` or an image, not pushed to GitHub).");
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return bad(`deploy:badsha`, `The commit id \`${safe(sha, 40)}\` is not a git sha.`);
  const owner = env.RAILWAY_GIT_REPO_OWNER, name = env.RAILWAY_GIT_REPO_NAME;
  if (owner && name && `${owner}/${name}`.toLowerCase() !== repo.toLowerCase()) return bad(`deploy:${sha}`, `Commit \`${short}\` ${who} came from \`${safe(owner, 40)}/${safe(name, 60)}\`, not ${repo}.`);
  if (env.RAILWAY_GIT_BRANCH && env.RAILWAY_GIT_BRANCH !== branch) return bad(`deploy:${sha}`, `Commit \`${short}\` ${who} was deployed from branch \`${safe(env.RAILWAY_GIT_BRANCH, 60)}\`, not ${branch}.`);
  const v = await commitOnBranch(sha, { repo, branch, fetchFn, sleep });
  if (v.verdict === "off") return bad(`deploy:${sha}`, `Commit \`${short}\` ${who} is not on ${repo} ${branch} (GitHub: ${v.status}).`);
  if (v.verdict === "missing") return bad(`deploy:${sha}`, `Commit \`${short}\` ${who} does not exist in ${repo}.`);
  if (v.verdict === "unknown") {
    await alerter.send(`deploy-unverified:${sha}`, `Squeek Den deployed \`${short}\` ${who}${msg}, but GitHub could not be reached to confirm it is on ${branch}.`, { everyone: false });
    return { unverified: true };
  }
  if (env.ALERT_DEPLOY_NOTICE !== "0") await alerter.send(`deploy-ok:${env.RAILWAY_DEPLOYMENT_ID || sha}`, `✅ Squeek Den deployed \`${short}\` from ${branch} ${who}${msg}`, { everyone: false, cooldownMs: 30 * 86_400_000 });
  return { ok: true };
}

// ---------- state file guard: did anything but us touch state.json? ----------
function createFileGuard(file, { statFn = (f) => fs.statSync(f) } = {}) {
  let mine = null; // { mtimeMs, size, ino } of our own last write
  const stat = () => {
    try {
      const s = statFn(file);
      return { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino };
    } catch {
      return null;
    }
  };
  return {
    noteWrite() { mine = stat(); },
    // null when untouched (or nothing known yet), else "changed" / "missing"
    check() {
      if (!mine) return null;
      const s = stat();
      if (!s) return "missing";
      return s.mtimeMs !== mine.mtimeMs || s.size !== mine.size || s.ino !== mine.ino ? "changed" : null;
    },
    get known() { return !!mine; },
  };
}

// ---------- watts supply: more growth than the economy can pay? ----------
// Upper bounds of what one den can be credited, at the best tiers with every bonus maxed.
function supplyRates(BALANCE, baseBpm) {
  const max = (a) => Math.max(...a) / 100;
  const live = BALANCE.LIVE_BONUS_PCT / 100;
  return {
    perBlock: BALANCE.BASE_WATTS_PER_BLOCK * max(BALANCE.WHEEL_MULT_PCT) * live * (BALANCE.SPEED.MAX_PCT / 100),
    perMin: BALANCE.BASE_WATTS_PER_BLOCK * baseBpm * (BALANCE.BED_AWAKE_PCT / 100) * max(BALANCE.BED_MULT_PCT) * live,
    bedTickMs: BALANCE.BED_TICK_MAX_MS,
    welcome: BALANCE.WELCOME_WATTS,
  };
}
const SUPPLY = { WHEEL_FACTOR: 25, BED_FACTOR: 4, PER_DEN_SLACK: 1000, SLACK: 10_000 };

function createSupplyMonitor(rates, { saved = null, onSave = () => {} } = {}) {
  let prev = saved && Number.isFinite(saved.total) ? { ...saved, restored: true } : null;
  let last = new Map(); // token -> watts at the previous observation (top gainers in the alert)
  const allowance = (blocks, dens, newDens, ms) =>
    dens * (blocks * rates.perBlock * SUPPLY.WHEEL_FACTOR + (ms / 60_000) * rates.perMin * SUPPLY.BED_FACTOR + SUPPLY.PER_DEN_SLACK) + newDens * rates.welcome + SUPPLY.SLACK;
  // -> { bad: [...] } and/or { jump: { delta, allowed, blocks, dens, gainers } }, or null
  function observe(st, now = Date.now()) {
    const players = st.players || {};
    let total = 0, dens = 0;
    const bad = [];
    const cur = new Map();
    for (const [token, p] of Object.entries(players)) {
      if (!p || typeof p !== "object") continue;
      dens++;
      const w = p.watts;
      if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > Number.MAX_SAFE_INTEGER) {
        if (bad.length < 5) bad.push({ pid: p.publicId, name: p.username || p.nick, watts: String(w) });
        continue;
      }
      total += w;
      cur.set(token, w);
    }
    const height = Number.isFinite(st.height) ? st.height : null;
    const minted = Number.isFinite(st.minted) ? st.minted : 0; // raid crit bonuses: watts the rules create
    const snap = { resetId: st.resetId ?? null, startHeight: st.startHeight ?? null, total, dens, height, at: now, minted };
    const out = {};
    if (bad.length) out.bad = bad;
    const same = prev && prev.resetId === snap.resetId && prev.startHeight === snap.startHeight;
    if (same && height != null && prev.height != null && height >= prev.height) {
      const blocks = height - prev.height;
      const ms = prev.restored ? rates.bedTickMs : Math.max(rates.bedTickMs, now - prev.at);
      const allowed = allowance(blocks, dens, Math.max(0, dens - prev.dens), ms);
      const delta = total - prev.total - (Number.isFinite(prev.minted) ? minted - prev.minted : 0);
      if (delta > allowed) {
        const gainers = [...cur].map(([t, w]) => ({ t, gain: last.has(t) ? w - last.get(t) : w })).sort((a, b) => b.gain - a.gain).slice(0, 3)
          .map(({ t, gain }) => ({ pid: players[t].publicId, name: players[t].username || players[t].nick, gain, isNew: !last.has(t) }));
        out.jump = { delta, allowed, blocks, dens, gainers, restored: !!prev.restored };
      }
    }
    prev = snap;
    last = cur;
    onSave(snap);
    return out.bad || out.jump ? out : null;
  }
  return { observe, allowance };
}

// ---------- burst counter (5xx) ----------
function createBurst({ windowMs = 300_000, threshold = 20 } = {}) {
  const hits = [];
  return (now = Date.now()) => {
    hits.push(now);
    while (hits.length && now - hits[0] >= windowMs) hits.shift();
    return hits.length >= threshold ? hits.length : 0;
  };
}

// ---------- everything wired for server.js ----------
// The hooks are cheap no-ops when ALERT_WEBHOOK is unset.
function createSecurity({ env = process.env, dataFile, BALANCE, baseBpm, demo = false, fetchFn = globalThis.fetch, now = Date.now, log = console, sleep = wait } = {}) {
  const storeFile = path.join(path.dirname(dataFile), "alerts.json");
  const alerter = createAlerter({ webhook: env.ALERT_WEBHOOK || null, fetchFn, storeFile, now, log });
  const guard = createFileGuard(dataFile);
  const supply = env.ALERT_SUPPLY === "0" || demo ? null : createSupplyMonitor(supplyRates(BALANCE, baseBpm), {
    saved: alerter.store.supply,
    onSave: (snap) => { alerter.store.supply = snap; alerter.persist(); },
  });
  const burst = createBurst();
  const on = alerter.enabled;
  const fileAlert = (what) => alerter.send(`statefile:${what}`, `**Squeek Den: state.json was ${what === "missing" ? "deleted" : "changed"} by something other than the server** (${safe(dataFile, 80)}). Someone may have shell or volume access. The server will overwrite it on its next save; check Railway → the volume and recent deployments.`);
  const who = (g) => `${safe(g.name || "anon", 30)} (${safe(g.pid || "?", 16)})`;
  return {
    alerter,
    enabled: on,
    // after load(): deploy check, demo-on-production check, file baseline
    boot() {
      if (!on) return Promise.resolve();
      if (!guard.known) guard.noteWrite();
      const jobs = [checkDeploy(env, { alerter, fetchFn, sleep }).catch((e) => log.error("alert: deploy check failed:", e.message || e))];
      if (demo && onRailway(env)) jobs.push(alerter.send("demo-on", "**Squeek Den: demo mode is ON in production.** POST /api/dev/grant hands out free watts to anyone. Remove SQUEEK_DEMO / --demo on Railway and redeploy."));
      return Promise.all(jobs);
    },
    beforeWrite() {
      if (!on) return;
      const c = guard.check();
      if (c) fileAlert(c);
    },
    wrote() {
      if (on) guard.noteWrite();
    },
    // end of every poll
    tick(st, { saving = false, now: t = now() } = {}) {
      if (!on) return;
      if (!saving) {
        const c = guard.check();
        if (c) {
          fileAlert(c);
          guard.noteWrite(); // one alert per external change
        }
      }
      if (!supply) return;
      const r = supply.observe(st, t);
      if (!r) return;
      if (r.bad) alerter.send("bad-balance", `**Squeek Den: impossible balances** (not a finite, non-negative number): ${r.bad.map((b) => `${who(b)} = ${safe(b.watts, 30)}`).join(", ")}. Likely an exploit or a corrupted state.`);
      if (r.jump) {
        const j = r.jump;
        const top = j.gainers.map((g) => `${who(g)} +${fmt(g.gain)}${g.isNew ? " (new)" : ""}`).join(", ");
        alerter.send("supply-jump", `**Squeek Den: watts supply jumped by ${fmt(j.delta)} W**${j.restored ? " across a restart" : ""}, more than the economy can pay (at most ${fmt(j.allowed)} W for ${j.blocks} block${j.blocks === 1 ? "" : "s"} across ${fmt(j.dens)} dens). Possible exploit${j.restored ? " or edited state file" : ""}. Biggest gainers: ${top || "?"}.`);
      }
    },
    serverError(pathname) {
      if (!on) return;
      const n = burst();
      if (n) alerter.send("5xx-burst", `Squeek Den: ${n} server_error responses in 5 min (last: \`${safe(pathname, 80)}\`). Someone may be probing for a crash, or a deploy broke something.`, { everyone: false });
    },
    devProbe(pathname, ip) {
      if (on && !demo) alerter.send("dev-probe", `Squeek Den: \`${safe(pathname, 60)}\` was requested while demo mode is off (from ${safe(ip, 64)}). Harmless (404), but someone is trying the dev routes.`, { everyone: false });
    },
  };
}

module.exports = { createAlerter, checkDeploy, commitOnBranch, createFileGuard, supplyRates, createSupplyMonitor, createBurst, createSecurity, safe, onRailway, SUPPLY, WEBHOOK_RE };

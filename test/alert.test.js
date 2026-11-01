// Security alert tests (lib/alert.js). Every fetch is injected: nothing ever reaches Discord or GitHub.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const A = require("../lib/alert.js");
const S = require("../server.js");

const HOOK = "https://discord.com/api/webhooks/123456789/abc_DEF-ghi";
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const quiet = { error() {}, log() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "squeek-alert-"));
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });

// A fake fetch: webhook posts are recorded, GitHub calls answered by `github(url)`.
function fakeNet(github = () => ok({ status: "identical" })) {
  const posts = [], gh = [];
  const fetchFn = async (url, opts = {}) => {
    if (url.startsWith("https://discord.com/")) {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 204 };
    }
    gh.push(url);
    return github(url);
  };
  return { posts, gh, fetchFn };
}
const alerter = (net, over = {}) => A.createAlerter({ webhook: HOOK, fetchFn: net.fetchFn, log: quiet, ...over });
const RAILWAY = { RAILWAY_ENVIRONMENT_NAME: "production", RAILWAY_DEPLOYMENT_ID: "dep-1", RAILWAY_GIT_COMMIT_SHA: "60308a1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", RAILWAY_GIT_BRANCH: "main", RAILWAY_GIT_AUTHOR: "KazzDev2", RAILWAY_GIT_REPO_OWNER: "KazzDev2", RAILWAY_GIT_REPO_NAME: "squeekroom" };
const noSleep = async () => {};

// ---------- the poster ----------
test("alert: no webhook (or not a Discord one) is a silent no-op", async () => {
  const net = fakeNet();
  for (const webhook of [null, "", "https://evil.example/api/webhooks/1/x", "http://discord.com/api/webhooks/1/x"]) {
    const a = A.createAlerter({ webhook, fetchFn: net.fetchFn, log: quiet });
    assert.equal(a.enabled, false);
    assert.equal(await a.send("k", "hi"), false);
  }
  assert.equal(net.posts.length, 0);
  assert.ok(A.WEBHOOK_RE.test("https://discord.com/api/webhooks/1000000000000000000/AbC_dEf-123_xYz"));
});

test("alert: @everyone really pings (allowed_mentions), quiet lines never do", async () => {
  const net = fakeNet();
  const a = alerter(net);
  assert.equal(await a.send("hack", "bad thing"), true);
  assert.equal(await a.send("note", "fyi", { everyone: false }), true);
  assert.ok(net.posts[0].content.startsWith("@everyone "));
  assert.deepEqual(net.posts[0].allowed_mentions, { parse: ["everyone"] });
  assert.ok(!net.posts[1].content.includes("@everyone"));
  assert.deepEqual(net.posts[1].allowed_mentions, { parse: [] });
});

test("alert: same key deduped for the cooldown, global hourly cap on @everyone", async () => {
  const net = fakeNet();
  let t = T0;
  const a = alerter(net, { now: () => t });
  assert.equal(await a.send("x", "1"), true);
  assert.equal(await a.send("x", "2"), false, "deduped");
  t += 6 * 3_600_000;
  assert.equal(await a.send("x", "3"), true, "cooldown over");
  for (let i = 0; i < 10; i++) await a.send(`k${i}`, "spam");
  assert.equal(net.posts.slice(1).length, 6, "at most 6 pings an hour (\"3\" + 5 of the 10)");
  t += 3_600_000;
  assert.equal(await a.send("later", "ok"), true);
});

test("alert: cooldowns survive a restart (store file), a failed post may retry", async () => {
  const dir = tmpDir(), storeFile = path.join(dir, "alerts.json");
  const net = fakeNet();
  await alerter(net, { storeFile, now: () => T0 }).send("deploy:x", "1");
  assert.equal(await alerter(net, { storeFile, now: () => T0 + 60_000 }).send("deploy:x", "2"), false, "crash loop: no second ping");
  let down = true;
  const flaky = A.createAlerter({ webhook: HOOK, log: quiet, now: () => T0, fetchFn: async () => (down ? status(500) : { ok: true, status: 204 }) });
  assert.equal(await flaky.send("y", "1"), false);
  down = false;
  assert.equal(await flaky.send("y", "2"), true);
});

test("alert: untrusted text can't ping or break out of code spans", () => {
  assert.equal(A.safe("@everyone `x`\n"), "@​everyone  x");
  assert.equal(A.safe("a".repeat(500), 10).length, 10);
});

// ---------- deploy check ----------
test("deploy: a commit on main posts one quiet line (or nothing with ALERT_DEPLOY_NOTICE=0)", async () => {
  for (const st of ["identical", "behind"]) {
    const net = fakeNet(() => ok({ status: st }));
    assert.deepEqual(await A.checkDeploy(RAILWAY, { alerter: alerter(net), fetchFn: net.fetchFn, sleep: noSleep }), { ok: true });
    assert.match(net.gh[0], /\/repos\/KazzDev2\/squeekroom\/compare\/main\.\.\.60308a1a/);
    assert.equal(net.posts.length, 1);
    assert.ok(!net.posts[0].content.includes("@everyone"));
  }
  const net = fakeNet();
  await A.checkDeploy({ ...RAILWAY, ALERT_DEPLOY_NOTICE: "0" }, { alerter: alerter(net), fetchFn: net.fetchFn });
  assert.equal(net.posts.length, 0);
});

test("deploy: off main, other branch/repo, unknown commit or no git source -> @everyone", async () => {
  const cases = [
    [RAILWAY, () => ok({ status: "ahead" })],
    [RAILWAY, () => ok({ status: "diverged" })],
    [{ ...RAILWAY, RAILWAY_GIT_BRANCH: "evil" }, null],
    [{ ...RAILWAY, RAILWAY_GIT_REPO_OWNER: "mallory" }, null],
    [{ ...RAILWAY, RAILWAY_GIT_COMMIT_SHA: "" }, null],
    [{ ...RAILWAY, RAILWAY_GIT_COMMIT_SHA: "not-a-sha" }, null],
    [RAILWAY, (url) => (url.includes("/compare/") ? status(404) : ok({ full_name: "KazzDev2/squeekroom" }))],
  ];
  for (const [env, github] of cases) {
    const net = fakeNet(github || (() => assert.fail("no GitHub call needed")));
    const r = await A.checkDeploy(env, { alerter: alerter(net), fetchFn: net.fetchFn, sleep: noSleep });
    assert.ok(r.alert, JSON.stringify(env));
    assert.equal(net.posts.length, 1);
    assert.ok(net.posts[0].content.startsWith("@everyone"));
    assert.match(net.posts[0].content, /unauthorized deploy/);
  }
});

test("deploy: GitHub unreachable or rate limited -> retried, then a quiet line, never a ping", async () => {
  for (const github of [() => status(403), () => { throw new Error("offline"); }, (url) => status(404)]) {
    const net = fakeNet(github);
    const r = await A.checkDeploy(RAILWAY, { alerter: alerter(net), fetchFn: net.fetchFn, sleep: noSleep });
    assert.deepEqual(r, { unverified: true });
    assert.ok(net.gh.length >= 3, "retried");
    assert.equal(net.posts.length, 1);
    assert.ok(!net.posts[0].content.includes("@everyone"));
  }
});

test("deploy: off Railway (local runs, tests) nothing is checked", async () => {
  const net = fakeNet();
  assert.deepEqual(await A.checkDeploy({}, { alerter: alerter(net), fetchFn: net.fetchFn }), { skipped: "not on railway" });
  assert.equal(net.gh.length + net.posts.length, 0);
});

// ---------- state file guard ----------
test("file guard: our own writes are fine, an outside edit or delete is caught", () => {
  const dir = tmpDir(), file = path.join(dir, "state.json");
  const g = A.createFileGuard(file);
  assert.equal(g.check(), null, "nothing known yet");
  fs.writeFileSync(file, "{}");
  g.noteWrite();
  assert.equal(g.check(), null);
  fs.writeFileSync(file + ".tmp", '{"players":{}}');
  fs.renameSync(file + ".tmp", file);
  g.noteWrite();
  assert.equal(g.check(), null, "tmp + rename by the server");
  fs.writeFileSync(file, '{"players":{"x":1}}');
  assert.equal(g.check(), "changed");
  g.noteWrite();
  fs.unlinkSync(file);
  assert.equal(g.check(), "missing");
});

// ---------- watts supply ----------
const den = (watts, extra = {}) => Object.assign(S.newPlayer(1000, T0), { watts }, extra);
const world = (players, height = 1000) => ({ resetId: "r", startHeight: 900, height, players });
const RATES = A.supplyRates(S.BALANCE, S.BALANCE.SPEED.BASE_BPM);

test("supply: rates are real upper bounds (one block at tier 5, every bonus maxed)", () => {
  const B = S.BALANCE;
  const best = S.wattsFor(1, B.WHEEL_MULT_PCT.length - 1, B.LIVE_BONUS_PCT, B.SPEED.MAX_PCT);
  assert.ok(RATES.perBlock >= best, `${RATES.perBlock} >= ${best}`);
  assert.ok(RATES.perMin >= S.bedWattsPerMin({ bedTier: B.BED_MULT_PCT.length - 1 }) * (B.LIVE_BONUS_PCT / 100));
});

test("supply: real income, raids, purchases and new dens never alert", () => {
  const m = A.createSupplyMonitor(RATES);
  const players = { a: den(50_000), b: den(80_000) };
  const st = world(players);
  assert.equal(m.observe(st, T0), null, "baseline");
  // a whole night of blocks at once (catch-up after an RPC outage), at the best tier
  for (const p of Object.values(players)) p.watts += S.wattsFor(1000, 5, 120, 150);
  st.height += 1000;
  assert.equal(m.observe(st, T0 + 10_000), null);
  players.a.watts -= 20_000; players.b.watts += 20_000; // raid loot moves watts
  players.c = den(S.BALANCE.WELCOME_WATTS); // a new den with its welcome grant
  assert.equal(m.observe(st, T0 + 20_000), null);
  players.a.watts += 800; // a v3 crate
  assert.equal(m.observe(st, T0 + 30_000), null);
});

test("supply: minted watts -> jump with the biggest gainers; broken balances -> bad", () => {
  const m = A.createSupplyMonitor(RATES);
  const players = { a: den(5_000, { username: "alice" }), b: den(5_000) };
  const st = world(players);
  m.observe(st, T0);
  players.a.watts += 10_000_000;
  st.height += 1;
  const r = m.observe(st, T0 + 10_000);
  assert.ok(r.jump);
  assert.equal(r.jump.delta, 10_000_000);
  assert.equal(r.jump.gainers[0].name, "alice");
  assert.equal(r.jump.gainers[0].gain, 10_000_000);
  players.b.watts = NaN;
  assert.equal(m.observe(st, T0 + 20_000).bad.length, 1);
  players.b.watts = -5;
  assert.equal(m.observe(st, T0 + 30_000).bad.length, 1);
});

test("supply: raid crit bonuses (state.minted) are not a jump; watts beyond them still are", () => {
  const m = A.createSupplyMonitor(RATES);
  const players = { a: den(5_000_000), b: den(5_000_000) };
  const st = world(players);
  m.observe(st, T0);
  players.a.watts += 600_000; // a big crit: the game paid the bonus
  st.minted = (st.minted || 0) + 600_000;
  assert.equal(m.observe(st, T0 + 10_000), null);
  players.b.watts += 600_000; // the same again, not counted
  st.minted += 100;
  const r = m.observe(st, T0 + 20_000);
  assert.ok(r && r.jump);
  assert.equal(r.jump.delta, 599_900);
});

test("supply: survives a restart (saved snapshot), a state reset rebaselines", () => {
  let saved = null;
  const players = { a: den(5_000) };
  const st = world(players);
  A.createSupplyMonitor(RATES, { onSave: (s) => (saved = s) }).observe(st, T0);
  players.a.watts = 50_000_000; // edited while the server was down
  const r = A.createSupplyMonitor(RATES, { saved }).observe(st, T0 + 3_600_000);
  assert.ok(r.jump && r.jump.restored);
  assert.equal(A.createSupplyMonitor(RATES, { saved }).observe({ ...st, resetId: "new" }, T0 + 3_600_000), null);
});

// ---------- the server hooks ----------
test("security: no ALERT_WEBHOOK -> every hook is a no-op (no files, no fetch)", async () => {
  const dir = tmpDir();
  const sec = A.createSecurity({ env: { ...RAILWAY }, dataFile: path.join(dir, "state.json"), BALANCE: S.BALANCE, baseBpm: 4, fetchFn: () => assert.fail("fetch"), log: quiet });
  assert.equal(sec.enabled, false);
  await sec.boot();
  sec.beforeWrite(); sec.wrote(); sec.tick(world({ a: den(NaN) })); sec.serverError("/x"); sec.devProbe("/api/dev/grant", "1.2.3.4");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("security: wired end to end (deploy, demo on prod, outside edit, minted watts, dev probe, 5xx burst)", async () => {
  const dir = tmpDir(), dataFile = path.join(dir, "state.json");
  const net = fakeNet(() => ok({ status: "behind" }));
  let t = T0;
  const mk = (demo) => A.createSecurity({ env: { ...RAILWAY, ALERT_WEBHOOK: HOOK }, dataFile, BALANCE: S.BALANCE, baseBpm: 4, demo, fetchFn: net.fetchFn, now: () => t, log: quiet, sleep: noSleep });
  fs.writeFileSync(dataFile, "{}");
  const sec = mk(false);
  await sec.boot();
  assert.equal(net.posts.length, 1);
  assert.match(net.posts[0].content, /deployed `60308a1` from main/);

  const players = { a: den(5_000) };
  const st = world(players);
  sec.tick(st, { now: t });
  sec.beforeWrite(); fs.writeFileSync(dataFile, '{"x":1}'); sec.wrote(); // our own save
  t += 10_000;
  sec.tick(st, { now: t });
  assert.equal(net.posts.length, 1, "nothing suspicious yet");

  fs.writeFileSync(dataFile, '{"x":2,"hacked":true}');
  t += 10_000;
  sec.tick(st, { now: t });
  await sec.alerter.settle();
  assert.match(net.posts.at(-1).content, /^@everyone .*state\.json was changed/);
  sec.tick(st, { now: t }); // the same change is reported once
  assert.equal(net.posts.length, 2);

  players.a.watts += 99_000_000;
  t += 10_000;
  sec.tick(st, { now: t });
  sec.devProbe("/api/dev/grant", "1.2.3.4");
  for (let i = 0; i < 20; i++) sec.serverError("/api/raid");
  await sec.alerter.settle();
  const texts = net.posts.map((p) => p.content);
  assert.ok(texts.some((c) => /^@everyone .*watts supply jumped by 99,000,000 W/.test(c)));
  assert.ok(texts.some((c) => /^Squeek Den: `\/api\/dev\/grant` was requested/.test(c)));
  assert.ok(texts.some((c) => /^Squeek Den: 20 server_error/.test(c)));
  assert.ok(fs.existsSync(path.join(dir, "alerts.json")));

  const net2 = fakeNet(() => ok({ status: "identical" }));
  const demo = A.createSecurity({ env: { ...RAILWAY, ALERT_WEBHOOK: HOOK, ALERT_DEPLOY_NOTICE: "0" }, dataFile: path.join(tmpDir(), "state.json"), BALANCE: S.BALANCE, baseBpm: 4, demo: true, fetchFn: net2.fetchFn, log: quiet });
  await demo.boot();
  assert.equal(net2.posts.length, 1);
  assert.match(net2.posts[0].content, /^@everyone .*demo mode is ON in production/);
});

// Squeekroom wallet sign-in (optional). Burner warning first, then a wallet picker fed by EIP-6963
// announcements (window.ethereum as a fallback), then ONE gasless personal_sign over a server-issued
// message, then an optional username. No transactions, no WalletConnect relay, no chain calls.
// Builds only on window.__squeekroom.bridge (game.js) and is fully inert when /api/config has no
// `wallet` block: the header button stays hidden.
(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const B = () => (window.__squeekroom && window.__squeekroom.bridge) || null;
function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "");
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

const W = {
  cfg: null, open: false, view: null, gen: 0, back: null,
  wallets: new Map(), // uuid -> { uuid, name, icon, rdns, provider }
  fallback: null, searching: false, listening: false, pickTimer: 0,
  notice: "", error: "", entry: null, btnSig: "",
};

// ---------- header button ----------
function me() { const b = B(), m = b && b.S ? b.S.me : null; return m && !m.preview ? m : null; } // no wallet before the den exists
function linked(m = me()) { return !!(m && m.verified && m.wallet); }
function renderBtn() {
  const btn = $("walletBtn");
  if (!btn) return;
  const m = me();
  const show = !!W.cfg && !!m;
  const sig = !show ? "hidden" : linked(m) ? `L|${m.username || ""}|${m.wallet}` : "U";
  if (sig === W.btnSig) return;
  W.btnSig = sig;
  btn.hidden = !show;
  if (!show) return;
  btn.innerHTML = "";
  if (linked(m)) {
    btn.className = "walletbtn linked";
    btn.appendChild(h("span", "wn" + (m.username ? "" : " addr"), m.username || short(m.wallet)));
    const v = h("span", "vbadge", "✓"); v.setAttribute("aria-hidden", "true"); btn.appendChild(v);
    btn.title = `Wallet linked: ${m.wallet}. Open your wallet panel`;
    btn.setAttribute("aria-label", `${m.username || short(m.wallet)}, wallet verified. Open your wallet panel`);
  } else {
    btn.className = "walletbtn";
    btn.textContent = "Connect Wallet";
    btn.title = "Optional: link a burner wallet with one free signature to get a ✓ next to your username";
    btn.removeAttribute("aria-label");
  }
}

// ---------- modal shell ----------
function show(view, title, sub, { warn = false } = {}) {
  W.view = view;
  $("wTitle").textContent = title;
  $("wSub").textContent = sub || "";
  $("walletBox").classList.toggle("warn", warn);
  const body = $("wBody");
  body.innerHTML = "";
  return body;
}
function openModal() {
  if (!W.open) W.back = document.activeElement;
  W.open = true;
  $("walletModal").hidden = false;
  document.body.classList.add("modal-open");
}
function closeModal() {
  if (!W.open) return;
  W.open = false;
  W.gen++; // late wallet / server answers of an abandoned flow are ignored
  W.view = null;
  clearTimeout(W.pickTimer);
  $("walletModal").hidden = true;
  const cert = $("certModal"), raid = $("raidModal");
  if ((!cert || cert.hidden) && (!raid || raid.hidden)) document.body.classList.remove("modal-open");
  const back = W.back; W.back = null;
  if (back && back.focus && document.contains(back)) back.focus({ preventScroll: true });
}
function focusFirst(sel) { const el = $("walletBox").querySelector(sel); if (el) el.focus({ preventScroll: true }); return !!el; }
function key(e) {
  if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
  if (e.key !== "Tab") return;
  const f = [...$("walletBox").querySelectorAll("button,input,a[href]")].filter((x) => !x.disabled && x.offsetParent !== null && x.tabIndex >= 0);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
}
function pxbtn(label, alt, onclick) { const b = h("button", "pxbtn" + (alt ? " alt" : ""), label); b.type = "button"; b.onclick = onclick; return b; }

// ---------- step 1: burner warning (always before any wallet is touched) ----------
function start() {
  const b = B();
  if (!W.cfg || !b || !me()) return;
  openModal();
  if (linked()) { showPanel(); return; }
  if (W.cfg.burnerWarning === false) { showPicker(); return; }
  const body = show("warn", "⚠ BEFORE YOU CONNECT", "optional · you can play without a wallet", { warn: true });
  const box = h("div", "wwarn");
  box.appendChild(h("b", null, "⚠ Experimental game"));
  box.append("Use a ");
  box.appendChild(h("em", null, "burner"));
  box.append(" wallet with nothing in it. You'll sign one free message. It costs no gas and moves nothing. ");
  box.appendChild(h("em", null, "This game never asks for a transaction, so don't sign one."));
  body.appendChild(box);
  body.appendChild(h("p", "wnote", "Linking puts a ✓ next to your username on the leaderboard. Your watts and den don't change."));
  const acts = h("div", "wacts");
  acts.appendChild(pxbtn("Cancel", true, closeModal));
  acts.appendChild(pxbtn("It's a burner, continue", false, showPicker));
  body.appendChild(acts);
  focusFirst(".pxbtn.alt"); // the safe choice has focus
}

// ---------- step 2: wallet picker (EIP-6963) ----------
const safeIcon = (s) => (typeof s === "string" && /^data:image\/(svg\+xml|png|jpe?g|gif|webp)[;,]/i.test(s) && s.length < 200_000 ? s : null);
function onAnnounce(ev) {
  const d = ev && ev.detail;
  if (!d || !d.info || !d.provider || typeof d.provider.request !== "function") return;
  const uuid = String(d.info.uuid || d.info.rdns || d.info.name || "");
  if (!uuid) return;
  W.wallets.set(uuid, { uuid, name: String(d.info.name || "Wallet").slice(0, 40), icon: safeIcon(d.info.icon), rdns: String(d.info.rdns || "").slice(0, 80), provider: d.provider });
  if (W.open && W.view === "pick") renderPicker();
}
function discover() {
  if (!W.listening) { window.addEventListener("eip6963:announceProvider", onAnnounce); W.listening = true; }
  W.searching = true;
  W.fallback = null;
  clearTimeout(W.pickTimer);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  W.pickTimer = setTimeout(() => {
    W.searching = false;
    const eth = window.ethereum;
    if (!W.wallets.size && eth && typeof eth.request === "function") W.fallback = { uuid: "window.ethereum", name: "Browser Wallet", icon: null, rdns: "window.ethereum", provider: eth };
    if (W.open && W.view === "pick") renderPicker();
  }, 300);
}
function showPicker() {
  W.error = ""; W.notice = "";
  discover();
  renderPicker();
}
function renderPicker() {
  const body = show("pick", "CONNECT A WALLET", "pick the burner you want to link");
  if (W.notice) body.appendChild(h("p", "wnote notice", W.notice));
  if (W.error) body.appendChild(h("p", "werr", W.error));
  const list = [...W.wallets.values()];
  if (!list.length && W.fallback) list.push(W.fallback);
  if (list.length) {
    body.appendChild(h("div", "wsec", "Installed"));
    const ul = h("ul", "wlist");
    for (const w of list) {
      const li = h("li"), b = h("button", "wopt");
      b.type = "button";
      if (w.icon) { const img = h("img"); img.src = w.icon; img.alt = ""; b.appendChild(img); }
      else b.appendChild(h("span", "wico", "◆"));
      const nm = h("span", "wnm", w.name);
      if (w.rdns && w.rdns !== "window.ethereum") nm.appendChild(h("small", null, w.rdns));
      else if (w === W.fallback) nm.appendChild(h("small", null, "window.ethereum"));
      b.appendChild(nm);
      b.appendChild(h("span", "wgo", "CONNECT ▸"));
      b.onclick = () => connect(w);
      li.appendChild(b);
      ul.appendChild(li);
    }
    body.appendChild(ul);
    if (W.searching) body.appendChild(h("p", "wnote", "Looking for more wallets…"));
  } else if (W.searching) {
    const wt = h("div", "wwait"); wt.appendChild(h("span", "wspin")); wt.appendChild(h("div", "wt", "Looking for wallet extensions…")); body.appendChild(wt);
  } else {
    const em = h("div", "wempty");
    em.appendChild(h("b", null, "No wallet extension found"));
    em.append("Install ");
    const links = [["MetaMask", "https://metamask.io/download/"], ["Rabby", "https://rabby.io/"], ["OKX Wallet", "https://www.okx.com/web3"]];
    links.forEach(([n, u], i) => { const a = h("a", null, n); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; em.appendChild(a); em.append(i === 0 ? ", " : i === 1 ? " or " : ""); });
    em.append(" and reload, or just play without one. The game works fine without a wallet.");
    body.appendChild(em);
  }
  body.appendChild(h("p", "wnote", "You only sign a free message. Phone wallets (QR) aren't supported yet."));
  const acts = h("div", "wacts");
  if (!list.length && !W.searching) acts.appendChild(pxbtn("Look again", true, showPicker));
  acts.appendChild(pxbtn(list.length ? "Cancel" : "Keep playing", true, closeModal));
  body.appendChild(acts);
  if (!$("walletBox").contains(document.activeElement) || document.activeElement === document.body) focusFirst(list.length ? ".wopt" : ".pxbtn");
}
function backToPicker({ error = "", notice = "" } = {}) {
  if (!W.open) return;
  W.error = error; W.notice = notice;
  renderPicker();
  if (!focusFirst(".wopt")) focusFirst(".pxbtn");
}

// ---------- step 3: connect -> nonce -> personal_sign -> verify ----------
function showWait(stepLabel, text, message) {
  const body = show("wait", W.entry ? W.entry.name.toUpperCase() : "WALLET", stepLabel);
  const wt = h("div", "wwait"); wt.appendChild(h("span", "wspin"));
  wt.appendChild(h("div", "wt", text));
  body.appendChild(wt);
  if (message) {
    body.appendChild(h("div", "wsec", "The exact message you'll sign"));
    body.appendChild(h("pre", "wmsg", message));
  }
  const acts = h("div", "wacts");
  acts.appendChild(pxbtn("Cancel", true, () => { W.gen++; backToPicker(); }));
  body.appendChild(acts);
  focusFirst(".pxbtn");
}
const errCode = (e) => (e && (e.code ?? (e.error && e.error.code))) ?? null;
const isReject = (e) => { const c = errCode(e); return c === 4001 || c === "ACTION_REJECTED" || (!!e && /user (rejected|denied|cancel)/i.test(String(e.message || ""))); };
const isPending = (e) => errCode(e) === -32002;
function utf8Hex(s) { return "0x" + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join(""); }
async function personalSign(provider, message, address) {
  const ask = async (data) => {
    const sig = await provider.request({ method: "personal_sign", params: [data, address] });
    if (typeof sig !== "string" || !SIG_RE.test(sig)) throw Object.assign(new Error("The wallet returned something that isn't a signature"), { code: "bad_shape" });
    return sig;
  };
  try { return await ask(message); }
  catch (e) {
    if (isReject(e) || isPending(e)) throw e;
    return await ask(utf8Hex(message)); // some wallets only take hex-encoded UTF-8
  }
}
function walletFail(e, stage) {
  if (isReject(e)) {
    B().toast(stage === "connect" ? "You cancelled in your wallet. Connect whenever you like." : "Signature cancelled in your wallet. Nothing was linked.");
    return backToPicker();
  }
  if (isPending(e)) return backToPicker({ notice: "Your wallet has a request waiting. Finish or cancel it in the extension, then try again." });
  const msg = String((e && e.message) || "").slice(0, 160);
  return backToPicker({ error: `${stage === "connect" ? "Couldn't connect" : "Couldn't get a signature"}${msg ? `: ${msg}` : "."} Try again, or pick another wallet.` });
}
function serverWords(j, address) {
  const e = (j && j.error) || "network";
  switch (e) {
    case "network": return "Can't reach the server. Check your connection and try again.";
    case "wallet_taken": return "That wallet is linked to another den. Use a different burner.";
    case "wallet_mismatch": return `The signature came from a different account than the one your wallet connected${address ? ` (${short(address)})` : ""}. Switch to that account and try again.`;
    case "bad_signature": return "Your wallet returned a signature the server couldn't read. Try again, or pick another wallet.";
    case "bad_address": return "Your wallet shared an address the server couldn't read. Try another account or wallet.";
    case "nonce_expired": case "no_nonce": return "The sign-in message expired. Try again: you'll get a fresh one.";
    case "unknown_player": case "bad_token": return "Your den hasn't loaded yet. Try again in a moment.";
    default: { const b = B(); return b && b.errorWords ? b.errorWords(j) : `Something went wrong (${e})`; }
  }
}
function serverFail(r, address) {
  const j = r.j || {};
  if ((j.error || "network") === "network") B().toast("You're offline: can't reach the server.", "err");
  return backToPicker({ error: serverWords(j, address) });
}
async function connect(entry) {
  const gen = ++W.gen, alive = () => W.open && gen === W.gen;
  W.entry = entry;
  const b = B();
  showWait("step 1 of 2 · connect", `Open ${entry.name} and approve the connection.`);
  let accounts;
  try { accounts = await entry.provider.request({ method: "eth_requestAccounts" }); }
  catch (e) { if (alive()) walletFail(e, "connect"); return; }
  if (!alive()) return;
  const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
  if (!address || !ADDRESS_RE.test(address)) return backToPicker({ error: `${entry.name} didn't share an account. Unlock it, then try again.` });
  for (let attempt = 0; attempt < 2; attempt++) {
    const n = await b.post("/api/wallet/nonce", {});
    if (!alive()) return;
    if (!n.ok || typeof n.j.message !== "string") return serverFail(n, address);
    showWait("step 2 of 2 · sign (free)", `Sign the message in ${entry.name} with ${short(address)}. It's free.`, n.j.message);
    let signature;
    try { signature = await personalSign(entry.provider, n.j.message, address); }
    catch (e) { if (alive()) walletFail(e, "sign"); return; }
    if (!alive()) return;
    showWait("checking", "Checking the signature…");
    const v = await b.post("/api/wallet/verify", { address, signature });
    if (!alive()) return;
    if (v.ok && v.j.me) {
      b.applyMe(v.j.me, false, { at: Date.now() + (b.S.skew || 0) });
      b.toast(`Wallet linked ✓ ${short(v.j.wallet || address)}`, "ok");
      b.refreshLb();
      return v.j.me.username ? showPanel() : showNameStep();
    }
    const e = v.j && v.j.error;
    if ((e === "nonce_expired" || e === "no_nonce") && attempt === 0) { b.toast("That message expired. Sign this new one."); continue; }
    return serverFail(v, address);
  }
}

// ---------- step 4: username (skippable; changeable later in the panel) ----------
function nameRules() {
  let re = /^[A-Za-z0-9_]{3,16}$/, min = 3, max = 16;
  try { if (W.cfg && W.cfg.usernameRe) re = new RegExp(W.cfg.usernameRe); } catch {}
  const m = /\{(\d+),(\d+)\}/.exec(re.source);
  if (m) { min = +m[1]; max = +m[2]; }
  return { re, min, max };
}
function nameProblem(v, cur) {
  const { re, min, max } = nameRules();
  if (!v) return { msg: `${min}–${max} letters, numbers or _`, quiet: true };
  if (/[^A-Za-z0-9_]/.test(v)) return { msg: "Only letters, numbers and _ (no spaces or symbols)" };
  if (v.length < min) return { msg: `Too short: ${v.length}/${min} characters minimum` };
  if (v.length > max) return { msg: `Too long: ${max} characters max` };
  if (!re.test(v)) return { msg: `${min}–${max} letters, numbers or _` };
  if (cur && v === cur) return { msg: "That's already your username", quiet: true };
  return null;
}
// builds the input + live hint + save; onSaved(me) after the server accepts
function nameForm(body, { cur, saveLabel, onSaved, extraBtn }) {
  const { max } = nameRules();
  const f = h("div", "wfield");
  const lab = h("label"); lab.htmlFor = "wName"; lab.append("Username");
  if (cur) { const c = h("span", "cur", `now: ${cur} `); c.appendChild(h("span", "vbadge", "✓")); lab.appendChild(c); }
  f.appendChild(lab);
  const row = h("div", "wrow"), inp = h("input", "winput");
  inp.id = "wName"; inp.maxLength = max + 4; inp.autocomplete = "off"; inp.spellcheck = false; inp.placeholder = cur || "e.g. wheel_runner";
  inp.setAttribute("autocapitalize", "off");
  inp.value = cur || "";
  row.appendChild(inp);
  f.appendChild(row);
  const hint = h("div", "whint"); hint.setAttribute("aria-live", "polite"); hint.id = "wNameHint";
  inp.setAttribute("aria-describedby", "wNameHint");
  f.appendChild(hint);
  body.appendChild(f);
  const acts = h("div", "wacts");
  if (extraBtn) acts.appendChild(extraBtn);
  const save = pxbtn(saveLabel, false, () => submit());
  acts.appendChild(save);
  body.appendChild(acts);
  let busy = false, serverMsg = "";
  const validate = () => {
    const p = nameProblem(inp.value, cur);
    inp.classList.toggle("bad", !!serverMsg || (!!p && !p.quiet && !!inp.value));
    inp.classList.toggle("good", !p && !serverMsg);
    hint.className = "whint" + (serverMsg ? " bad" : p ? (p.quiet ? "" : " bad") : " good");
    hint.textContent = serverMsg || (p ? p.msg : "Looks good. We'll check it's free when you save.");
    save.disabled = busy || !!p;
    return !p;
  };
  inp.addEventListener("input", () => { serverMsg = ""; validate(); });
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  async function submit() {
    if (busy || !validate()) return;
    const b = B(), want = inp.value, gen = W.gen;
    busy = true; save.disabled = true; save.textContent = "Saving…";
    const r = await b.post("/api/wallet/username", { username: want });
    busy = false; save.textContent = saveLabel;
    if (r.ok && r.j.me) {
      b.applyMe(r.j.me, false, { at: Date.now() + (b.S.skew || 0) });
      b.toast(`Username set: ${r.j.me.username || want} ✓`, "ok");
      b.refreshLb();
      if (W.open && gen === W.gen) onSaved(r.j.me);
      return;
    }
    const e = (r.j && r.j.error) || "network";
    if (e === "network") b.toast("You're offline: can't reach the server.", "err");
    serverMsg = e === "username_taken" ? `“${want}” is already taken. Try another.`
      : e === "bad_username" ? "Not allowed: 3–16 letters, numbers or _."
      : e === "wallet_required" ? "Link a wallet first: your den isn't linked any more."
      : e === "network" ? "Can't reach the server. Try again in a moment."
      : serverWords(r.j);
    if (W.open && gen === W.gen) { validate(); save.disabled = false; inp.focus(); }
  }
  validate();
  inp.focus({ preventScroll: true });
  if (cur) inp.select();
  return inp;
}
function showNameStep() {
  const m = me();
  const body = show("name", "✓ WALLET LINKED", m && m.wallet ? short(m.wallet) : "");
  body.appendChild(h("p", "wnote", "Pick a username. It shows on the leaderboard with a ✓. You can change it later."));
  nameForm(body, { cur: null, saveLabel: "Save username", onSaved: () => closeModal(), extraBtn: pxbtn("Skip", true, closeModal) });
}

// ---------- the linked panel: wallet, username, done ----------
function showPanel() {
  const m = me();
  if (!linked(m)) { start(); return; }
  const body = show("panel", "YOUR WALLET", "linked with one free signature");
  body.appendChild(h("div", "wsec", "Linked wallet"));
  const ad = h("div", "waddr"); ad.appendChild(h("code", null, m.wallet));
  const cp = h("button", "q", "COPY"); cp.type = "button";
  cp.onclick = async () => { try { await navigator.clipboard.writeText(m.wallet); B().toast("Address copied"); } catch { B().toast("Couldn't copy here: select the address instead", "err"); } };
  ad.appendChild(cp);
  body.appendChild(ad);
  nameForm(body, { cur: m.username || null, saveLabel: m.username ? "Change username" : "Save username", onSaved: () => showPanel(), extraBtn: pxbtn("Done", true, closeModal) });
  body.appendChild(h("p", "wnote", "Burner wallets only. The game never asks for a transaction."));
}

// ---------- wiring ----------
function onConfig(cfg) { W.cfg = cfg || null; W.btnSig = ""; renderBtn(); if (!W.cfg && W.open) closeModal(); }
function onMe() { renderBtn(); }
$("walletBtn").onclick = () => { if (W.open) closeModal(); else start(); };
$("wClose").onclick = closeModal;
$("walletModal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeModal(); });

window.SqueekWallet = { onConfig, onMe, isOpen: () => W.open, key, open: start, close: closeModal, get state() { return W; } };
// game.js may already have its config / room (wallet.js loads after it)
{ const b = B(); if (b && b.S) { if (b.S.configured) onConfig(b.S.walletCfg); else renderBtn(); } }
})();

// Real-browser check of sign-in: starts a dev IdP, the tasks origin and Navigator itself, drives a
// headless Edge/Chrome over the DevTools protocol with a virtual WebAuthn authenticator, and checks
// the host-drawn chrome and dialog, passkey registration and login, sign-out, and cancellation.
//
//   node test/auth-browser-check.mjs [--shot out.png]
//
// Requires Edge or Chrome (set BROWSER to override) and the tasks component to be built.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer } from "../../server/server.mjs";
import { startIdp } from "../../server/dev-idp.mjs";
import { startNavigator } from "../navigator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;

const exe = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean).find((p) => existsSync(p));
if (!exe) { console.error("no Edge/Chrome found; set BROWSER"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failed++; };
const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));

// ---- The stack under test ----------------------------------------------------------------------
const idp = await startIdp();
const app = await loadApp({ appDir: resolve(here, "..", "..", "examples", "tasks"), oidc: [{ issuer: idp.issuer, clientId: idp.clientId }], dev: true, log: () => {} });
const origin = createServer(app);
const originPort = await listen(origin);
const dataDir = mkdtempSync(join(tmpdir(), "nav-authbrowser-"));
const nav = await startNavigator({ url: `http://127.0.0.1:${originPort}/`, dev: true, port: 0, dataDir, cacheDir: join(tmpdir(), "lattice-navigator-test-cache"), log: () => {} });

const debugPort = 9800 + Math.floor(Math.random() * 150);
const proc = spawn(exe, [
  "--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`,
  "--host-resolver-rules=MAP *.localhost 127.0.0.1",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "nav-authbrowser-profile-"))}`, "--window-size=900,950", "about:blank",
], { stdio: "ignore" });

try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch { await sleep(200); }
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push(`${m.params.entry.text} ${m.params.entry.url ?? ""}`);
  };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr, { gesture = false } = {}) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: gesture });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.result.value;
  };
  const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(100); } return false; };
  const click = (selectorExpr) => js(`(${selectorExpr})?.click()`, { gesture: true });
  const appButton = (text) => `[...document.querySelectorAll('#app button')].find((b) => b.textContent === ${JSON.stringify(text)})`;
  const dialogButton = (text) => `[...document.querySelectorAll('dialog#auth button')].find((b) => b.textContent === ${JSON.stringify(text)})`;
  const chromeText = () => js("document.getElementById('chrome').textContent");
  const dialogText = () => js("document.querySelector('dialog#auth').open ? document.querySelector('dialog#auth').textContent : ''");

  await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
  // WebAuthn only runs in a focused document; a headless page has no window focus of its own.
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp("WebAuthn.enable");
  const { result: { authenticatorId } } = await cdp("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await cdp("Page.navigate", { url: `${nav.uiOrigin}/` });
  check(await until("!!document.querySelector('h1')"), "page loads from the app's own domain");
  check(await js("location.origin") === nav.uiOrigin && new URL(nav.uiOrigin).hostname === "tasks.localhost", `origin is ${nav.uiOrigin}`);

  // Host chrome: whose page this is, and the session state.
  check(/tasks\.localhost/.test(await chromeText()) && /Not signed in/.test(await chromeText()), "host chrome shows the domain and 'Not signed in'");
  check(await js("document.getElementById('chrome').closest('#app') === null"), "the chrome is outside the app's tree");

  // OIDC: the dialog is composed by the host; cancelling leaves the app signed out.
  await click(appButton(`Sign in with 127.0.0.1:${idp.port}`));
  check(await until("document.querySelector('dialog#auth').open"), "OIDC: host dialog opens");
  const oidcText = await dialogText();
  check(/Sign in with 127\.0\.0\.1/.test(oidcText) && /Lattice Tasks \(tasks\.localhost\)/.test(oidcText), "OIDC dialog names the app, its domain and the provider", oidcText);
  check(await js("document.querySelector('dialog#auth').closest('#app') === null"), "the dialog is outside the app's tree");
  if (shot) {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(shot.replace(/\.png$/, "-dialog.png"), Buffer.from(r.result.data, "base64"));
  }
  await click(dialogButton("Cancel"));
  check(await until("!document.querySelector('dialog#auth').open"), "OIDC: Cancel closes the dialog");
  check(await until("document.getElementById('notice') && !document.getElementById('notice').hidden && /cancelled/.test(document.getElementById('notice').textContent)"), "the app reports 'Sign-in was cancelled.'");

  // OIDC for real: Continue opens the provider in a new window; sign in there as Alice.
  await click(appButton(`Sign in with 127.0.0.1:${idp.port}`));
  await until("document.querySelector('dialog#auth').open");
  await click(dialogButton("Continue"));
  check(await until("/Waiting for you to finish/.test(document.querySelector('dialog#auth').textContent)"), "OIDC: the dialog waits while the provider window is open");
  let popup;
  for (let i = 0; i < 60 && !popup; i++) {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    popup = list.find((t) => t.type === "page" && t.url.startsWith(idp.issuer + "/authorize"));
    if (!popup) await sleep(100);
  }
  check(!!popup, "OIDC: the provider's authorization page opened in a new window");
  if (popup) {
    const pws = new WebSocket(popup.webSocketDebuggerUrl);
    await new Promise((r) => (pws.onopen = r));
    let pid = 0;
    const pp = new Map();
    pws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pp.has(m.id)) { pp.get(m.id)(m); pp.delete(m.id); } };
    const pjs = (expr) => new Promise((r) => { const i = ++pid; pp.set(i, r); pws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, userGesture: true } })); }).then((m) => m.result?.result?.value);
    check(await pjs("window.opener === null"), "OIDC: the provider's page has no reference back to the app (noopener)");
    check(/Dev identity provider/.test(await pjs("document.body.textContent")), "OIDC: this is the provider's page, not the app's");
    await pjs("document.querySelector('button[value=alice]').click()");
    let done = false;
    for (let i = 0; i < 60 && !done; i++) {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const t = list.find((x) => x.type === "page" && x.url.includes("/_navigator/auth/callback"));
      if (t) done = true; else await sleep(100);
    }
    check(done, "OIDC: the provider redirected back to Navigator's callback");
    check(/Sign-in complete/.test(await pjs("document.body.textContent")), "OIDC: the callback page tells the user they can return");
    pws.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${popup.id}`); // the user closes the provider's tab
    await cdp("Page.bringToFront");
  }
  check(await until("/Signed in as Alice Example/.test(document.getElementById('chrome').textContent)", 10000), "OIDC: host chrome shows Alice signed in");
  check(await until("document.getElementById('app').textContent.includes('Signed in as Alice Example')"), "OIDC: the app shows the account its server reported");
  check(await until("!document.querySelector('dialog#auth').open"), "OIDC: the dialog closes when sign-in completes");
  await click(`[...document.querySelectorAll('#chrome button')].find((b) => b.textContent === 'Sign out')`);
  check(await until("/Not signed in/.test(document.getElementById('chrome').textContent)"), "OIDC: sign-out returns to anonymous");

  // Passkey: create an account.
  await js(`(() => { const i = document.querySelector('input[name=account_name]'); i.focus(); i.value = 'Erin'; })()`);
  await click(appButton("Create passkey"));
  check(await until("document.querySelector('dialog#auth').open"), "passkey: host dialog opens");
  const createText = await dialogText();
  check(/Create a passkey/.test(createText) && /tasks\.localhost/.test(createText), "passkey dialog says what will happen and for which domain", createText);
  await click(dialogButton("Continue"));
  check(await until("/Signed in as Erin/.test(document.getElementById('chrome').textContent)"), "passkey registration signs the user in (host chrome)");
  check(await until("document.getElementById('app').textContent.includes('Signed in as Erin')"), "the app shows the account its server reported");
  check(await until("!document.querySelector('dialog#auth').open"), "the dialog closes when the ceremony ends");

  const creds = (await cdp("WebAuthn.getCredentials", { authenticatorId })).result.credentials;
  check(creds.length === 1 && creds[0].rpId === "tasks.localhost" && creds[0].isResidentCredential, "one resident credential, bound to tasks.localhost", JSON.stringify(creds.map((c) => c.rpId)));

  // Data belongs to the account.
  await js(`(() => { const i = document.querySelector('input[name=title]'); i.value = 'Erin task'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check(await until("[...document.querySelectorAll('label.check')].some((l) => l.textContent === 'Erin task')"), "a task is added as Erin");

  // Sign out from the host chrome; the app updates itself.
  await click(`[...document.querySelectorAll('#chrome button')].find((b) => b.textContent === 'Sign out')`);
  check(await until("/Not signed in/.test(document.getElementById('chrome').textContent)"), "chrome sign-out ends the session");
  check(await until("document.getElementById('app').textContent.includes('You are not signed in')"), "the app was told and updated itself");
  check(await js("document.querySelectorAll('label.check').length") === 0, "signed out: the account's tasks are gone from view");

  // Sign in again with the passkey.
  await click(appButton("Sign in with a passkey"));
  check(await until("document.querySelector('dialog#auth').open && /Sign in with a passkey/.test(document.querySelector('dialog#auth').textContent)"), "passkey sign-in dialog opens");
  await click(dialogButton("Continue"));
  check(await until("/Signed in as Erin/.test(document.getElementById('chrome').textContent)"), "passkey sign-in works");
  check(await until("[...document.querySelectorAll('label.check')].some((l) => l.textContent === 'Erin task')"), "the account's task is back");
  const after = (await cdp("WebAuthn.getCredentials", { authenticatorId })).result.credentials[0];
  check(after.signCount >= 1, "the authenticator's signature counter advanced", `signCount=${after.signCount}`);

  // Cancelling a passkey ceremony in the dialog.
  await click(`[...document.querySelectorAll('#chrome button')].find((b) => b.textContent === 'Sign out')`);
  await until("/Not signed in/.test(document.getElementById('chrome').textContent)");
  await click(appButton("Sign in with a passkey"));
  await until("document.querySelector('dialog#auth').open");
  await click(dialogButton("Cancel"));
  check(await until("!document.querySelector('dialog#auth').open"), "passkey: Cancel closes the dialog");
  check(!/Signed in as/.test(await chromeText()), "cancelling leaves the user signed out");

  if (shot) {
    await js(`(() => { const i = document.querySelector('input[name=title]'); i.value = ''; })()`);
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(shot, Buffer.from(r.result.data, "base64"));
    console.log(`screenshots: ${shot} (and -dialog)`);
  }
  // Cancelling a sign-in is answered with a 422 (the app's message); the browser logs that as a network error.
  const unexpected = problems.filter((p) => !/status of 422/.test(p));
  check(unexpected.length === 0, "no console errors or CSP violations", unexpected.join(" | "));
  ws.close();
} finally {
  proc.kill();
  await nav.close();
  await new Promise((ok) => { origin.close(ok); origin.closeAllConnections?.(); });
  await idp.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failure(s)` : "\nall auth browser checks passed");
process.exit(failed ? 1 : 0);

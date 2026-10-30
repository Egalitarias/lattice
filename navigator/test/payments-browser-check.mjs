// Real-browser check of payments: starts the Stripe-compatible processor, the tasks origin and Navigator,
// drives a headless Edge/Chrome through creating an account, the host's payment dialog, the processor's own
// page in a new window, the return, and the app unlocking Pro.
//
//   node test/payments-browser-check.mjs [--shot out.png]
//
// Requires Edge or Chrome (set BROWSER to override) and the tasks component to be built.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, loadNavigator } from "../../server/server.mjs";
import { startIdp } from "../../server/dev-idp.mjs";
import { startPsp } from "../../server/dev-psp.mjs";
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

// `--browser-mode` runs the same scenarios against the browser Navigator that the app's own origin serves
// (no Navigator process at all) instead of the Node Navigator.
const mode = process.argv.includes("--browser-mode") ? "browser" : "node";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failed++; };
const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));

// ---- The stack under test ----------------------------------------------------------------------
const idp = await startIdp();
const psp = await startPsp();
const app = await loadApp({
  appDir: resolve(here, "..", "..", "examples", "tasks"),
  oidc: [{ issuer: idp.issuer, clientId: idp.clientId }],
  dev: true,
  stripe: { secretKey: psp.secretKey, webhookSecret: psp.webhookSecret, api: { protocol: "http", host: "127.0.0.1", port: psp.port } },
  log: () => {},
});
const origin = createServer({ ...app, navigator: mode === "browser" ? loadNavigator() : null });
const originPort = await listen(origin);
psp.configure({ webhookUrl: `http://127.0.0.1:${originPort}/pay/webhook` });
const dataDir = mkdtempSync(join(tmpdir(), "nav-paybrowser-"));
const nav = mode === "node" ? await startNavigator({ url: `http://127.0.0.1:${originPort}/`, dev: true, port: 0, dataDir, cacheDir: join(tmpdir(), "lattice-navigator-test-cache"), log: () => {} }) : null;
const uiOrigin = mode === "node" ? nav.uiOrigin : `http://tasks.localhost:${originPort}`;

const debugPort = 9950 + Math.floor(Math.random() * 40);
const proc = spawn(exe, [
  "--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`,
  "--host-resolver-rules=MAP *.localhost 127.0.0.1",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "nav-paybrowser-profile-"))}`, "--window-size=900,950", "about:blank",
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
  const signOut = async () => {
    await click(`[...document.querySelectorAll('#chrome button')].find((b) => b.textContent === 'Sign out')`);
    await until("/Not signed in/.test(document.getElementById('chrome').textContent)");
  };
  const createAccount = async (name) => {
    await js(`(() => { const i = document.querySelector('input[name=account_name]'); i.focus(); i.value = ${JSON.stringify(name)}; })()`);
    await click(appButton("Create passkey"));
    await until("document.querySelector('dialog#auth').open");
    await click(dialogButton("Continue"));
    return until(`new RegExp('Signed in as ${name}').test(document.getElementById('chrome').textContent)`);
  };

  await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp("WebAuthn.enable");
  await cdp("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await cdp("Page.navigate", { url: `${uiOrigin}/` });
  check(await until("!!document.querySelector('h1')"), "page loads");
  check(await js("![...document.querySelectorAll('#app button')].some((b) => /Upgrade/.test(b.textContent))"), "signed out: the app offers no Upgrade button");

  check(await createAccount("Pat"), "an account is created with a passkey");
  check(await until(`!![...document.querySelectorAll('#app button')].find((b) => b.textContent === ${JSON.stringify("Upgrade to Pro ($4.00)")})`), "signed in: the app offers Upgrade to Pro ($4.00)");

  // The host's payment dialog, drawn from what the server said.
  await click(appButton("Upgrade to Pro ($4.00)"));
  check(await until("document.querySelector('dialog#auth').open"), "payment: the host dialog opens");
  const sheet = await dialogText();
  // The currency symbol depends on the browser's locale ("$4.00", "US$4.00" or "USD 4.00"); the amount and merchant do not.
  const usd = String.raw`(?:US\$|\$|USD\s?)4\.00`;
  check(new RegExp(`Pay ${usd} to Lattice Tasks`).test(sheet), "the sheet names the amount and the merchant", sheet);
  check(new RegExp(`127\\.0\\.0\\.1:${psp.port}`).test(sheet) && /tasks\.localhost/.test(sheet), "it names who will take the payment and says the app never sees the details");
  check(new RegExp(`Lattice Tasks Pro: ${usd}`).test(sheet) && new RegExp(`Total: ${usd}`).test(sheet), "it lists the line and the total", sheet);
  check(await js("document.querySelector('dialog#auth').closest('#app') === null"), "the dialog is outside the app's tree");
  if (shot) {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(shot.replace(/\.png$/, "-dialog.png"), Buffer.from(r.result.data, "base64"));
  }

  // Cancel in the host dialog: nothing happens at the processor.
  await click(dialogButton("Cancel"));
  check(await until("!document.querySelector('dialog#auth').open"), "Cancel closes the dialog");
  check(await until("document.getElementById('notice') && !document.getElementById('notice').hidden && /Payment was cancelled/.test(document.getElementById('notice').textContent)"), "the app reports 'Payment was cancelled.'");
  check(psp.sessions.size === 1 && [...psp.sessions.values()].every((s) => s.payment_status === "unpaid"), "the processor holds an unpaid session and nothing was charged");

  // Pay for real: Continue opens the processor in a new window.
  await click(appButton("Upgrade to Pro ($4.00)"));
  await until("document.querySelector('dialog#auth').open");
  await click(dialogButton("Continue"));
  check(await until("/Waiting for you to finish paying/.test(document.querySelector('dialog#auth').textContent)"), "the dialog waits while the processor's window is open");
  let popup;
  for (let i = 0; i < 60 && !popup; i++) {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    popup = list.find((t) => t.type === "page" && t.url.startsWith(psp.url + "/c/pay/"));
    if (!popup) await sleep(100);
  }
  check(!!popup, "the processor's page opened in a new window");
  if (popup) {
    const pws = new WebSocket(popup.webSocketDebuggerUrl);
    await new Promise((r) => (pws.onopen = r));
    let pid = 0;
    const pp = new Map();
    pws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pp.has(m.id)) { pp.get(m.id)(m); pp.delete(m.id); } };
    const pjs = (expr) => new Promise((r) => { const i = ++pid; pp.set(i, r); pws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, userGesture: true } })); }).then((m) => m.result?.result?.value);
    check(await pjs("window.opener === null"), "the processor's page has no reference back to the app (noopener)");
    const page = await pjs("document.body.textContent");
    check(/Total: 4\.00 USD/.test(page), "the processor's own page shows the true amount", page.slice(0, 120));
    await pjs("document.querySelector('button[value=pay]').click()");
    let returned = false;
    for (let i = 0; i < 60 && !returned; i++) {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      returned = !!list.find((x) => x.type === "page" && x.url.includes("/_navigator/payment/return"));
      if (!returned) await sleep(100);
    }
    check(returned, "the processor sent the user back to Navigator's return address");
    check(/Thank you/.test(await pjs("document.body.textContent")), "the return page tells the user to go back to the app");
    pws.close();
    await fetch(`http://127.0.0.1:${debugPort}/json/close/${popup.id}`);
    await cdp("Page.bringToFront");
  }

  check(await until("!document.querySelector('dialog#auth').open", 10000), "the dialog closes when the user comes back");
  check(psp.delivered.length === 1 && psp.delivered[0].status === 200, "the processor's signed webhook reached the server");
  check(await until("/Signed in as Pat \\(Pro\\)/.test(document.getElementById('app').textContent)", 10000), "the app confirms with its server and shows Pro");
  check(await js("![...document.querySelectorAll('#app button')].some((b) => /Upgrade/.test(b.textContent))"), "the Upgrade button is gone once the account has Pro");
  check(await js("document.getElementById('chrome').textContent.includes('Pat')"), "the host chrome still shows who is signed in");

  // Pro belongs to the account.
  await signOut();
  check(await createAccount("Quinn"), "a second account is created");
  check(await js("!/\\(Pro\\)/.test(document.getElementById('app').textContent)") , "the second account does not have Pro");
  check(await until(`!![...document.querySelectorAll('#app button')].find((b) => b.textContent === ${JSON.stringify("Upgrade to Pro ($4.00)")})`), "and is offered the upgrade");

  if (shot) {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(shot, Buffer.from(r.result.data, "base64"));
    console.log(`screenshots: ${shot} (and -dialog)`);
  }
  const unexpected = problems.filter((p) => !/status of 422/.test(p));
  check(unexpected.length === 0, "no console errors or CSP violations", unexpected.join(" | "));
  ws.close();
} finally {
  proc.kill();
  await nav?.close();
  await new Promise((ok) => { origin.close(ok); origin.closeAllConnections?.(); });
  await idp.close();
  await psp.close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failure(s)` : "\nall payment browser checks passed");
process.exit(failed ? 1 : 0);

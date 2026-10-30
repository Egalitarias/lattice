// Real-browser check of the host-drawn card sheet: the form the host draws, autofill hints, inline errors that keep it open,
// a successful payment, and nothing left behind. Run against the Node Navigator or, with --browser-mode, the browser one.
//
//   node test/cardsheet-browser-check.mjs [--browser-mode] [--shot out.png]
//
// Requires Edge or Chrome (set BROWSER to override) and the tasks component to be built.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, loadNavigator } from "../../server/server.mjs";
import { startIdp } from "../../server/dev-idp.mjs";
import { startPsp } from "../../server/dev-psp.mjs";
import { startNavigator } from "../navigator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
const exe = [process.env.BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
if (!exe) { console.error("no Edge/Chrome found; set BROWSER"); process.exit(2); }

const mode = process.argv.includes("--browser-mode") ? "browser" : "node";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failed++; };
const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));

const idp = await startIdp();
const psp = await startPsp();
const app = await loadApp({
  appDir: resolve(here, "..", "..", "examples", "tasks"),
  oidc: [{ issuer: idp.issuer, clientId: idp.clientId }],
  dev: true,
  stripe: { secretKey: psp.secretKey, publishableKey: psp.publishableKey, webhookSecret: psp.webhookSecret, api: { protocol: "http", host: "127.0.0.1", port: psp.port } },
  log: () => {},
});
const origin = createServer({ ...app, navigator: mode === "browser" ? loadNavigator() : null });
const originPort = await listen(origin);
psp.configure({ webhookUrl: `http://127.0.0.1:${originPort}/pay/webhook` });
const nav = mode === "node" ? await startNavigator({ url: `http://127.0.0.1:${originPort}/`, dev: true, port: 0, dataDir: mkdtempSync(join(tmpdir(), "nav-cardbrowser-")), cacheDir: join(tmpdir(), "lattice-navigator-test-cache"), log: () => {} }) : null;
const uiOrigin = mode === "node" ? nav.uiOrigin : `http://tasks.localhost:${originPort}`;

const debugPort = 9990 + Math.floor(Math.random() * 9);
const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`, "--host-resolver-rules=MAP *.localhost 127.0.0.1", `--user-data-dir=${mkdtempSync(join(tmpdir(), "nav-cardbrowser-profile-"))}`, "--window-size=900,950", "about:blank"], { stdio: "ignore" });

try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch { await sleep(200); } }
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
  const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await js(expr)) return true; } catch { /* navigating */ } await sleep(100); } return false; };
  const click = (sel) => js(`(${sel})?.click()`, { gesture: true });
  const appButton = (text) => `[...document.querySelectorAll('#app button')].find((b) => b.textContent === ${JSON.stringify(text)})`;
  const dialogButton = (re) => `[...document.querySelectorAll('dialog#auth button')].find((b) => ${re}.test(b.textContent))`;
  const fill = (number, month, year, cvc) => js(`(() => { const set = (id, v) => { const i = document.getElementById(id); i.value = v; }; set('card-number', ${JSON.stringify(number)}); set('card-month', ${JSON.stringify(month)}); set('card-year', ${JSON.stringify(year)}); set('card-cvc', ${JSON.stringify(cvc)}); })()`);
  const status = () => js("document.getElementById('auth-status')?.textContent ?? ''");

  await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp("WebAuthn.enable");
  await cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await cdp("Page.navigate", { url: `${uiOrigin}/` });
  check(await until("!!document.querySelector('h1')"), "page loads");

  await js(`(() => { const i = document.querySelector('input[name=account_name]'); i.focus(); i.value = 'Pat'; })()`);
  await click(appButton("Create passkey"));
  await until("document.querySelector('dialog#auth').open");
  await click(dialogButton(/^Continue$/));
  check(await until("/Signed in as Pat/.test(document.getElementById('chrome').textContent)"), "signed in with a passkey");

  await click(appButton("Upgrade to Pro ($4.00)"));
  check(await until("!!document.getElementById('card-number')"), "the host draws a card form");
  const info = await js(`(() => { const d = document.querySelector('dialog#auth'); const f = (id) => document.getElementById(id); return JSON.stringify({
    inApp: d.closest('#app') !== null, text: d.textContent,
    auto: ['card-number', 'card-month', 'card-year', 'card-cvc'].map((i) => f(i).autocomplete), labels: ['card-number', 'card-month', 'card-year', 'card-cvc'].map((i) => document.querySelector('label[for=' + i + ']')?.textContent),
    cvcType: f('card-cvc').type, focus: document.activeElement.id }); })()`);
  const i = JSON.parse(info);
  check(!i.inApp, "the form is outside the app's tree");
  check(JSON.stringify(i.auto) === JSON.stringify(["cc-number", "cc-exp-month", "cc-exp-year", "cc-csc"]), "fields carry the standard autofill hints", i.auto.join(","));
  check(i.labels.every((l) => l && l.length > 2), "every field has a visible label", i.labels.join(" | "));
  check(i.cvcType === "password" && i.focus === "card-number", "the security code is masked and focus starts on the card number");
  check(/drawn by Lattice Navigator/.test(i.text) && /tasks\.localhost never sees it/.test(i.text) && new RegExp(`127\\.0\\.0\\.1:${psp.port}`).test(i.text), "it says who draws it, who gets the card, and that the app does not", i.text.slice(0, 200));
  if (shot) writeFileSync(shot, Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).result.data, "base64"));

  const yy = String((new Date().getUTCFullYear() + 2) % 100);
  const submit = () => click(dialogButton(/^Pay /));
  await fill("4242 4242 4242 4241", "12", yy, "123");
  await submit();
  check(await until("/card number does not look right/.test(document.getElementById('auth-status').textContent)"), "a mistyped number is explained inline, without leaving the sheet", await status());
  check(await js("document.getElementById('card-number').value !== ''"), "and what the user typed is kept so they can fix it");

  await fill("4000 0000 0000 0002", "12", yy, "123");
  await submit();
  check(await until("/declined/i.test(document.getElementById('auth-status').textContent)"), "a declined card is reported inline", await status());
  check(await js("document.getElementById('card-cvc').value === ''"), "and the security code is cleared");

  await fill("4000 0025 0000 3155", "12", yy, "123");
  await submit();
  check(await until(`!!${dialogButton("/^Continue to your bank$/")}`), "a card that needs verification asks the user to go to their bank");
  check(await js("document.getElementById('card-number') === null && !document.body.innerHTML.includes('3155')"), "and the card form, with what was typed, is gone");
  await click(dialogButton("/^Continue to your bank$/"));
  let bank;
  for (let n = 0; n < 50 && !bank; n++) { bank = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page" && /\/authenticate\/pi_/.test(t.url)); if (!bank) await sleep(100); }
  check(!!bank, "the bank's page opens in its own window, from the click");
  const bankWs = new WebSocket(bank.webSocketDebuggerUrl);
  await new Promise((r) => (bankWs.onopen = r));
  // A wrong answer from the bank, in that window, sends the user back to the form.
  bankWs.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.querySelector('button[value=fail]').click()", userGesture: true } }));
  check(await until("!!document.getElementById('card-number') && /did not verify/.test(document.getElementById('auth-status').textContent)"), "a failed verification returns to the form, with an explanation", await status());
  bankWs.close();
  check(await until("document.querySelector('dialog#auth').open"), "the sheet is still open for another card");

  await fill("4242 4242 4242 4242", "12", yy, "123");
  await submit();
  check(await until("!document.querySelector('dialog#auth').open"), "a good card closes the sheet");
  check(await until("/\\(Pro\\)/.test(document.getElementById('app').textContent)"), "the app shows Pro, after the server confirmed it from the processor's webhook");
  check(await js("document.getElementById('card-number') === null && !document.body.innerHTML.includes('4242')"), "no card details are left in the page");
  check([...psp.intents.values()].every((x) => x.status === "succeeded") && [...app.impl.payments.orders.values()][0].status === "paid", "the processor and the server agree the order is paid");
  // The two 422s are the refusals this script provoked on purpose (a mistyped and a declined card).
  const unexpected = problems.filter((p) => !/status of (422|402)/.test(p));
  check(unexpected.length === 0, "no other console errors or CSP violations", unexpected.join(" | ").slice(0, 300));
} finally {
  proc.kill();
  await nav?.close();
  origin.closeAllConnections?.();
  origin.close();
  await idp.close();
  await psp.close();
}
console.log(failed ? `\n${failed} failure(s)` : "\nall card sheet browser checks passed");
process.exit(failed ? 1 : 0);

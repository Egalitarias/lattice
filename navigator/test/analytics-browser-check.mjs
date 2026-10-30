// Real-browser check of the Privacy control: starts the tasks origin (with its first-party collector) and
// Navigator, drives a headless Edge/Chrome through changing the analytics level in the host chrome, and
// checks what the panel shows against what the collector actually received.
//
//   node test/analytics-browser-check.mjs [--shot out.png]
//
// Requires Edge or Chrome (set BROWSER to override) and the tasks component to be built.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, loadNavigator } from "../../server/server.mjs";
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

const app = await loadApp({ appDir: resolve(here, "..", "..", "examples", "tasks"), dev: true, log: () => {} });
const origin = createServer({ ...app, navigator: mode === "browser" ? loadNavigator() : null });
const originPort = await new Promise((ok) => origin.listen(0, "127.0.0.1", () => ok(origin.address().port)));
const dataDir = mkdtempSync(join(tmpdir(), "nav-anbrowser-"));
const nav = mode === "node" ? await startNavigator({ url: `http://127.0.0.1:${originPort}/`, dev: true, port: 0, dataDir, cacheDir: join(tmpdir(), "lattice-navigator-test-cache"), log: () => {} }) : null;
const uiOrigin = mode === "node" ? nav.uiOrigin : `http://tasks.localhost:${originPort}`;
const collected = () => app.impl.collector.events;
// What the check needs from Navigator's internals: directly in Node mode, through the loopback-only debug hook in the page otherwise.
let js; // assigned once the browser is connected
const an = {
  flush: () => (mode === "node" ? nav.analytics.flush() : js("latticeDebug.controller.analytics.flush()")),
  level: () => (mode === "node" ? nav.analytics.level : js("latticeDebug.controller.analytics.level")),
  clientId: () => (mode === "node" ? nav.analytics.clientId() : js("latticeDebug.controller.analytics.clientId()")),
};

const debugPort = 9990 + Math.floor(Math.random() * 9);
const proc = spawn(exe, [
  "--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`,
  "--host-resolver-rules=MAP *.localhost 127.0.0.1",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "nav-anbrowser-profile-"))}`, "--window-size=900,950", "about:blank",
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
  js = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.result.value;
  };
  const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(100); } return false; };
  const panel = "document.querySelector('#chrome details.privacy')";
  const addTask = async (title) => {
    await js(`(() => { const i = document.querySelector('input[name=title]'); i.focus(); i.value = ${JSON.stringify(title)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await until(`[...document.querySelectorAll('label.check')].some((l) => l.textContent === ${JSON.stringify(title)})`);
  };
  const setLevel = async (level) => {
    await js(`(() => { const s = document.getElementById('privacy-level'); s.value = ${JSON.stringify(level)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    return until(`${panel}.querySelector('summary').textContent.includes(${JSON.stringify({ off: "Off", errors: "Errors only", anonymous: "Anonymous", full: "Full" }[level])})`);
  };
  const reopen = async () => {
    // Counters and recent events refresh when the panel is opened.
    await js(`(() => { const d = ${panel}; d.open = false; })()`);
    await sleep(100);
    await js(`(() => { const d = ${panel}; d.open = true; })()`);
    await sleep(400);
  };

  await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
  await cdp("Page.navigate", { url: `${uiOrigin}/` });
  check(await until("!!document.querySelector('h1')"), "page loads");

  // The control is part of the host's chrome, outside the app, with the safe default.
  check(await until(`!!${panel}`), "the Privacy control is in the host chrome");
  check(await js(`${panel}.closest('#app') === null`), "it is outside the app's tree");
  check(await js(`${panel}.querySelector('summary').textContent`) === "Analytics: Errors only", "the default level is errors only");
  await js(`${panel}.open = true`);
  const text = await js(`${panel}.textContent`);
  check(/Lattice Tasks \(first party\)/.test(text) && /product, performance, errors/.test(text), "it names every processor and what each receives", text);
  check(/No events have been sent/.test(text), "it says nothing has been sent yet");
  check(await js("document.getElementById('privacy-level').labels.length") === 1, "the selector has an accessible label");

  // At the default level using the app sends nothing product-level.
  await addTask("default level task");
  await an.flush();
  check(collected().length === 0, "at the default level the collector received nothing", JSON.stringify(collected().map((e) => e.name)));

  // Raise the level in the chrome.
  check(await setLevel("anonymous"), "choosing Anonymous in the chrome changes the level");
  check((await an.level()) === "anonymous", "and Navigator itself agrees");
  await addTask("anonymous level task");
  await an.flush();
  check(collected().some((e) => e.name === "task_added" && e.level === "anonymous" && e.client === null), "the collector received task_added, with no client id");
  check(!/default level task|anonymous level task/.test(JSON.stringify(collected())), "and no task titles", JSON.stringify(collected()));
  await reopen();
  const shown = await js(`${panel}.textContent`);
  check(/task_added \{"tasks":2\}/.test(shown), "the panel lists the event that was actually sent", shown);
  check(/Sent [1-9]/.test(shown) && /held back [1-9]/.test(shown), "the counters show sent and held-back events", shown);
  if (shot) {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(shot, Buffer.from(r.result.data, "base64"));
    console.log(`screenshot: ${shot}`);
  }

  // Full adds an id the user can reset.
  check(await setLevel("full"), "choosing Full works");
  await js(`${panel}.open = true`);
  await sleep(200);
  check(await js(`[...${panel}.querySelectorAll('button')].some((b) => b.textContent === 'Reset my analytics ID')`), "Full shows a button to reset the analytics ID");
  const id1 = await an.clientId();
  await addTask("full level task");
  await an.flush();
  check(collected().filter((e) => e.client === id1).length > 0, "events now carry the client id");
  await js(`[...${panel}.querySelectorAll('button')].find((b) => b.textContent === 'Reset my analytics ID').click()`);
  await sleep(400);
  check((await an.clientId()) !== id1, "resetting changes the id");

  // Off stops everything.
  check(await setLevel("off"), "choosing Off works");
  const before = collected().length;
  await addTask("off level task");
  await an.flush();
  check(collected().length === before, "nothing more is sent once it is off");
  check(await js(`![...${panel}.querySelectorAll('button')].some((b) => b.textContent === 'Reset my analytics ID')`), "the reset button is only shown at Full");

  const unexpected = problems.filter((p) => !/status of 422/.test(p));
  check(unexpected.length === 0, "no console errors or CSP violations", unexpected.join(" | "));
  ws.close();
} finally {
  proc.kill();
  await nav?.close();
  await new Promise((ok) => { origin.close(ok); origin.closeAllConnections?.(); });
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failure(s)` : "\nall analytics browser checks passed");
process.exit(failed ? 1 : 0);

// Drives a real (headless) Chromium-family browser against a running Lattice Navigator over the DevTools
// protocol: loads the page, interacts with it like a user, and checks the DOM and accessibility.
//
//   node test/browser-check.mjs http://127.0.0.1:7070/ [--title "Lattice Todo"] [--shot out.png]
//
// Requires Edge or Chrome. Set BROWSER to override the executable.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
const expectedTitle = process.argv.includes("--title") ? process.argv[process.argv.indexOf("--title") + 1] : "Lattice Todo";
const shot = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null;
if (!url) { console.error("usage: node browser-check.mjs <nav url> [--shot file.png]"); process.exit(2); }

const candidates = [
  process.env.BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) { console.error("no Edge/Chrome found; set BROWSER"); process.exit(2); }

const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(exe, [
  "--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "nav-browser-"))}`, "--window-size=900,900", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failed++; };

try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); }
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") consoleErrors.push(m.params.entry.text + " " + (m.params.entry.url ?? ""));
  };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.result.value;
  };
  await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");

  await cdp("Page.navigate", { url });
  for (let i = 0; i < 50; i++) { await sleep(200); if (await evalJs("!!document.querySelector('h1')")) break; }

  check(await evalJs("document.title") === expectedTitle, "document title comes from the scene");
  check(await evalJs("!!document.querySelector('header h1')"), "banner region -> <header> with <h1>");
  check(await evalJs("!!document.querySelector('main[aria-label]')"), "main landmark has an accessible name");
  check(await evalJs("!!document.querySelector('form[aria-label] label[for] + input')"), "input has an associated <label>");
  check(await evalJs("document.querySelector('#app').children.length === 1"), "single root element");

  // Type into the input and press Enter (form submit), as a user would.
  const before = await evalJs("document.querySelectorAll('ul li, ul > *').length");
  await evalJs(`(() => { const i = document.querySelector('input[name=title]'); i.focus(); i.value = 'Browser test todo'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
  await sleep(600);
  check(await evalJs("[...document.querySelectorAll('label.check')].some(l => l.textContent === 'Browser test todo')"), "submitting the form adds a todo");
  check(await evalJs("document.querySelector('input[name=title]').value === ''"), "input is cleared by the app's update");
  check(await evalJs("document.activeElement === document.querySelector('input[name=title]')"), "update.focus returns focus to the input");
  check(await evalJs("document.querySelector('[aria-live=polite]')?.textContent.match(/item|task/)"), "summary is a polite live region");

  // Typed text must survive an unrelated update (toggling a checkbox).
  await evalJs(`document.querySelector('input[name=title]').value = 'half typed'`);
  const was = await evalJs(`document.querySelector('label.check input').checked`);
  await evalJs(`document.querySelector('label.check input').click()`);
  await sleep(600);
  check(await evalJs("document.querySelector('input[name=title]').value === 'half typed'"), "typed text survives an unrelated update");
  check(await evalJs("document.querySelector('label.check input').checked") === !was, "checkbox reflects app state");

  // Client-side navigation with history.
  await evalJs(`document.querySelector('footer a').click()`);
  await sleep(600);
  check(await evalJs("location.pathname") === "/about" && await evalJs("document.title") === "About", "link navigates via Lattice Navigator, URL and title update");
  await evalJs("history.back()");
  await sleep(700);
  check(await evalJs("location.pathname") === "/" && await evalJs("!!document.querySelector('form')"), "back button returns to the list");

  // App-provided strings are never parsed as markup.
  await evalJs(`(() => { const i = document.querySelector('input[name=title]'); i.value = '<img src=x onerror=window.__xss=1>'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
  await sleep(600);
  check(await evalJs("window.__xss === undefined && !document.querySelector('#app img')"), "markup in app data is inert text");

  // Validation error from the app is surfaced as an alert.
  await evalJs(`(() => { const i = document.querySelector('input[name=title]'); i.value = '   '; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
  await sleep(600);
  check(await evalJs("document.querySelector('#notice[role=alert]:not([hidden])')?.textContent") === "Enter something to do first.", "app error message shown in an alert");

  // The deliberate empty-title submission above is answered with 422; the browser logs that as a network error.
  const unexpected = consoleErrors.filter((e) => !/status of 422/.test(e));
  check(unexpected.length === 0, "no console errors or CSP violations", unexpected.join(" | "));

  if (shot) {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(shot, Buffer.from(r.result.data, "base64"));
    console.log(`screenshot: ${shot}`);
  }
  ws.close();
} finally {
  proc.kill();
}
console.log(failed ? `\n${failed} failure(s)` : "\nall browser checks passed");
process.exit(failed ? 1 : 0);

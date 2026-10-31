// A pixel surface in a real browser: the plasma example runs in the browser Navigator (component transpiled and run in a
// Worker), paints into its surface, and the window shows what it painted and keeps asking for the next frame.
//
//   node test/surface-browser-check.mjs            browser Navigator (build first: npm run build:browser)
//   node test/surface-browser-check.mjs --node     Node Navigator, with this browser as its window
//
// examples/surface must be built.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, loadNavigator } from "../../server/server.mjs";
import { startNavigator } from "../navigator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const exe = [process.env.BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
if (!exe) { console.error("no Edge/Chrome found; set BROWSER"); process.exit(2); }
const nodeMode = process.argv.includes("--node");
const navigatorDist = nodeMode ? null : loadNavigator();
if (!nodeMode && !navigatorDist) { console.error("the browser Navigator is not built: run `npm run build:browser`"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failed++; };

const app = await loadApp({ appDir: resolve(here, "..", "..", "examples", "surface"), dev: true, log: () => {} });
const origin = createServer({ ...app, navigator: navigatorDist });
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
let nav = null;
let url = `http://surface.localhost:${origin.address().port}/`;
if (nodeMode) {
  nav = await startNavigator({ url: `http://127.0.0.1:${origin.address().port}/`, dev: true, port: 0, dataDir: mkdtempSync(join(tmpdir(), "surface-nav-")), log: () => {} });
  url = `http://127.0.0.1:${nav.port}/`;
}

const port = 9700 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), "surface-"));
const proc = spawn(exe, ["--headless=new", "--no-first-run", `--remote-debugging-port=${port}`, "--host-resolver-rules=MAP *.localhost 127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let k = 0; k < 60 && !targets; k++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } }
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
const cdp = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.result.value;
};
const until = async (expr, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await js(expr)) return true; } catch { /* navigating */ } await sleep(100); } return false; };
await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
await cdp("Page.navigate", { url });

// A cheap fingerprint of what is on the canvas right now: the sum of a sample of its bytes, and whether any are set.
const picture = `(() => { const c = document.querySelector('canvas'); if (!c) return null; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let sum = 0, opaque = true; for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7; if (d[i + 3] !== 255) opaque = false; } return { w: c.width, h: c.height, sum, opaque }; })()`;

try {
  check(await until("!!document.querySelector('canvas')"), "the app loads in the browser Navigator and shows a canvas");
  if (!nodeMode) check(await js("self.crossOriginIsolated"), "the page is cross-origin isolated");
  check(await until(`(${picture})?.w === 160`), "the canvas is the size of the app's surface (160 x 100)", JSON.stringify(await js(picture)));
  const first = await js(picture);
  check(first?.h === 100 && first.sum > 0 && first.opaque, "it shows pixels the app painted, fully opaque", JSON.stringify(first));
  check(await js("document.querySelector('canvas').getAttribute('aria-label') === 'Plasma' && !!document.querySelector('canvas').getAttribute('aria-describedby')"), "the canvas has its label and description");

  // The animation: the window asks for frames, the app paints them, and the picture keeps changing.
  const seen = new Set([first.sum]);
  for (let i = 0; i < 20; i++) { await sleep(100); const p = await js(picture); if (p) seen.add(p.sum); }
  check(seen.size >= 5, "the picture animates (the window keeps asking and the app keeps painting)", `${seen.size} different pictures in two seconds`);

  // A click goes to the app in surface pixels and changes the picture beyond the animation itself.
  const c = await js("(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left + r.width / 4, y: r.top + r.height / 4 }; })()");
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: "left", clickCount: 1 });
  check(await js("document.activeElement === document.querySelector('canvas')"), "clicking focuses the canvas");

  const fps = await js(`new Promise((resolve) => { const c = document.querySelector('canvas'); let n = 0; const t0 = performance.now(); const o = new MutationObserver(() => {}); const ctx = c.getContext('2d'); let last = ctx.getImageData(0, 0, 8, 8).data.join(); const tick = () => { const now = ctx.getImageData(0, 0, 8, 8).data.join(); if (now !== last) { n++; last = now; } if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else resolve(n / 2); }; requestAnimationFrame(tick); })`);
  check(fps >= 5 && fps <= 35, "about thirty frames a second at most reach the screen", `${fps} per second`);

  check(problems.length === 0, "no errors in the console", problems.join(" | "));
} catch (e) {
  check(false, "the check ran", e.stack);
} finally {
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  await nav?.close();
  origin.close();
  origin.closeAllConnections?.();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall surface checks passed");
process.exit(failed ? 1 : 0);

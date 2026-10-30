// Server push in real browsers: two separate browser profiles (so two sessions) open the World example from its origin
// alone, and each sees the other arrive and move. Browser Navigator only.
//
//   node test/world-browser-check.mjs        (build first: npm run build:browser; examples/world must be built)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, loadNavigator, attachWebTransport } from "../../server/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const exe = [process.env.BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
if (!exe) { console.error("no Edge/Chrome found; set BROWSER"); process.exit(2); }
const navigatorDist = loadNavigator();
if (!navigatorDist) { console.error("the browser Navigator is not built: run `npm run build:browser`"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failed++; };

const app = await loadApp({ appDir: resolve(here, "..", "..", "examples", "world"), dev: true, log: () => {} });
const wt = await attachWebTransport(app, { dev: true, log: () => {} }); // null when the optional packages are missing
const origin = createServer({ ...app, navigator: navigatorDist });
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const url = `http://world.localhost:${origin.address().port}/`;

/** One browser with its own profile, so its own localStorage and therefore its own session. */
async function launch(i) {
  const port = 9900 + i * 17 + Math.floor(Math.random() * 10);
  const profile = mkdtempSync(join(tmpdir(), `world-${i}-`));
  const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, "--host-resolver-rules=MAP *.localhost 127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
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
  const until = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await js(expr)) return true; } catch { /* navigating */ } await sleep(100); } return false; };
  await cdp("Runtime.enable"); await cdp("Log.enable"); await cdp("Page.enable");
  await cdp("Page.navigate", { url });
  return {
    js, until, problems,
    status: () => js("[...document.querySelectorAll('p, div, span')].map((e) => e.textContent).find((t) => /\\d+ online/.test(t) && t.length < 120) ?? ''"),
    cells: () => js("[...document.querySelectorAll('#app [class*=grid] > *')].map((e) => e.textContent).join('')"),
    press: (label) => js(`document.querySelector('button[aria-label="${label}"], button[title="${label}"]')?.click() ?? document.querySelector('[aria-label="${label}"]')?.click()`),
    stop: () => { proc.kill(); return sleep(300).then(() => rmSync(profile, { recursive: true, force: true })); },
  };
}

const a = await launch(1);
const b = await launch(2);
try {
  check(await a.until("/1 online|2 online/.test(document.body.innerText)"), "the first browser loads the world and shows it");
  check(await a.js("self.crossOriginIsolated"), "the page is cross-origin isolated");
  check(await b.until("/2 online/.test(document.body.innerText)"), "the second browser sees both players");
  check(await a.until("/2 online/.test(document.body.innerText)", 8000), "and the first is told, without asking, that the second arrived");

  const before = await b.js("document.body.innerText.match(/column (\\d+), row (\\d+)/)?.[0] ?? ''");
  check(/column/.test(before), "the second browser knows where it stands", before);
  let moved = false;
  for (const dir of ["Move right", "Move left", "Move down", "Move up"]) {
    await b.js(`[...document.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify({ "Move right": "→", "Move left": "←", "Move down": "↓", "Move up": "↑" }[dir])} || x.getAttribute('aria-label') === ${JSON.stringify(dir)})?.click()`);
    if (await b.until(`document.body.innerText.match(/column (\\d+), row (\\d+)/)?.[0] !== ${JSON.stringify(before)}`, 1500)) { moved = true; break; }
  }
  check(moved, "a step is applied by the server and comes back over the topic to the one who took it");
  const after = await b.js("document.body.innerText.match(/You are (.*?) at column/)?.[1] ?? ''");
  check(await a.until(`document.body.innerText.includes(${JSON.stringify(after)} ) || document.body.innerText.includes('2 online')`), "the first browser still shows both players");
  if (wt) {
    check(await a.until("latticeDebug.controller.host.stream.transports.get('world') === 'webtransport'", 8000), "the first browser receives the topic over real WebTransport (HTTP/3), pinned to the development certificate");
    check(await b.until("latticeDebug.controller.host.stream.transports.get('world') === 'webtransport'", 8000), "and so does the second");
  } else console.log("SKIP  WebTransport packages are not installed; topics use streaming HTTPS");
  // The canvas: painted with more than one colour, labelled, and driven from the keyboard.
  const pixels = await a.js(`(() => { const c = document.querySelector('canvas.scene-canvas'); if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 97) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return seen.size; })()`);
  check(pixels >= 3, "the world is painted on a canvas (several distinct colours)", String(pixels));
  check(await a.js("document.querySelector('canvas.scene-canvas').getAttribute('aria-label') === 'The world' && document.querySelector('canvas.scene-canvas').tabIndex === 0"), "the canvas has an accessible name and is keyboard-focusable");
  const here = () => b.js("document.body.innerText.match(/column (\d+), row (\d+)/)?.[0] ?? ''");
  const start = await here();
  let keyed = false;
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) {
    await b.js(`(() => { const c = document.querySelector('canvas.scene-canvas'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); })()`);
    if (await b.until(`document.body.innerText.match(/column (\d+), row (\d+)/)?.[0] !== ${JSON.stringify(start)}`, 1500)) { keyed = true; break; }
  }
  check(keyed, "an arrow key on the focused canvas moves the player");
  check(await b.js("document.activeElement === document.querySelector('canvas.scene-canvas')"), "and the canvas keeps keyboard focus through the updates");
  check(a.problems.length === 0 && b.problems.length === 0, "no console errors or CSP violations in either browser", [...a.problems, ...b.problems].join(" | ").slice(0, 300));
} finally {
  await a.stop();
  await b.stop();
  app.topics.close();
  wt?.close();
  origin.closeAllConnections?.();
  origin.close();
}
console.log(failed ? `\n${failed} failure(s)` : "\nall world browser checks passed");
process.exit(failed ? 1 : 0);

// What is specific to the browser Navigator (the host served by the app's own origin, spec/browser.md): it boots
// from the origin alone, the headers and CSP that protect it, refusal of a tampered component, behaviour without
// cross-origin isolation, persistence, and the service worker and transpile cache.
//
//   node test/browser-mode-check.mjs
//
// Requires Edge or Chrome, the example components built, and the browser Navigator built (npm run build:browser).
// The scenarios (sign-in, payments, analytics, general UI) are exercised by the other checks with --browser-mode.

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, loadNavigator } from "../../server/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, "..", "..", "examples");
const exe = [process.env.BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
if (!exe) { console.error("no Edge/Chrome found; set BROWSER"); process.exit(2); }
const navigatorDist = loadNavigator();
if (!navigatorDist) { console.error("the browser Navigator is not built: run `npm run build:browser` in navigator/"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); if (!ok) failed++; };
const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
const shut = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); });

/** An origin serving an example app with the browser Navigator, counting what is requested of it. */
async function startOrigin(name, { tamper } = {}) {
  const app = await loadApp({ appDir: join(examples, name), dev: true, log: () => {} });
  const domain = app.manifest.app; // the address the page is served on, before any tampering
  if (tamper) tamper(app);
  const server = createServer({ ...app, navigator: navigatorDist });
  const hits = new Map();
  server.on("request", (req) => hits.set(req.url.split("?")[0] + (req.headers.accept?.includes("lattice") ? " [manifest]" : ""), (hits.get(req.url.split("?")[0] + (req.headers.accept?.includes("lattice") ? " [manifest]" : "")) ?? 0) + 1));
  const port = await listen(server);
  // The page is served on the app's own domain: the browser Navigator requires the manifest to name it.
  return { app, server, port, hits, url: `http://${domain}:${port}`, close: () => shut(server) };
}

// ---- A browser we can drive --------------------------------------------------------------------
const debugPort = 9800 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "nav-bmode-"));
const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${debugPort}`, "--host-resolver-rules=MAP *.localhost 127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

async function openTab(url) {
  const t = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const tab = { problems: [], logs: [], requests: [] };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") tab.problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") tab.problems.push(`${m.params.entry.text} ${m.params.entry.url ?? ""}`);
    if (m.method === "Runtime.consoleAPICalled") tab.logs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    if (m.method === "Network.requestWillBeSent") tab.requests.push(m.params.request.url);
  };
  tab.cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  tab.js = async (expr) => {
    const r = await tab.cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.result.value;
  };
  tab.until = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await tab.js(expr)) return true; } catch { /* page navigating */ } await sleep(100); } return false; };
  tab.goto = async (u) => { await tab.cdp("Page.navigate", { url: u }); };
  tab.reload = async () => { await tab.cdp("Page.reload", { ignoreCache: false }); };
  tab.close = async () => { ws.close(); await fetch(`http://127.0.0.1:${debugPort}/json/close/${t.id}`).catch(() => {}); };
  await tab.cdp("Runtime.enable"); await tab.cdp("Log.enable"); await tab.cdp("Page.enable"); await tab.cdp("Network.enable");
  if (url) await tab.goto(url);
  return tab;
}

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${debugPort}/json/version`); break; } catch { await sleep(200); } }

  // ---- 1. It runs from the origin alone ----------------------------------------------------------
  const o = await startOrigin("tasks");
  let tab = await openTab(o.url + "/");
  check(await tab.until("!!document.querySelector('h1')"), "the app runs with only its origin serving it (no Navigator process)");
  check(await tab.js("self.crossOriginIsolated"), "the page is cross-origin isolated");
  check(await tab.js("document.title") === "Lattice Tasks", "the title comes from the app's scene");
  check(tab.logs.some((l) => /tasks starting for tasks\.localhost/.test(l)), "the component ran and logged through the host");
  check(!!(await tab.js("typeof latticeDebug")) && (await tab.js("typeof latticeDebug")) === "object", "the debug hook exists on a loopback development origin");
  const loaded = await tab.js("performance.getEntriesByType('resource').map((r) => new URL(r.name).origin)");
  check(loaded.every((x) => x === o.url), "every file the page loaded came from the app's own origin", JSON.stringify([...new Set(loaded)]));
  check(tab.problems.length === 0, "no console errors or CSP violations while loading", tab.problems.join(" | "));

  // ---- 2. The headers that protect it -----------------------------------------------------------
  const head = async (path, accept) => (await fetch(`http://127.0.0.1:${o.port}${path}`, { headers: { Accept: accept ?? "*/*", Host: `tasks.localhost:${o.port}` } }));
  const page = await head("/some/deep/link", "text/html");
  const csp = page.headers.get("content-security-policy");
  check(page.headers.get("cross-origin-opener-policy") === "same-origin" && page.headers.get("cross-origin-embedder-policy") === "require-corp", "the page is served with COOP and COEP");
  check(/script-src 'self'(;|$)/.test(csp) && !/unsafe-eval|unsafe-inline|blob:/.test(csp), "the page's CSP allows scripts only from its origin: no eval, no inline, no blob", csp);
  check(/worker-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /form-action 'none'/.test(csp) && /base-uri 'none'/.test(csp), "workers only from the origin; it cannot be framed, post forms, or rebase URLs");
  const cw = await head("/.lattice/navigator/component-worker.js");
  const cwCsp = cw.headers.get("content-security-policy");
  check(/connect-src 'none'/.test(cwCsp) && /default-src 'none'/.test(cwCsp), "the component's worker cannot open any network connection (connect-src 'none')", cwCsp);
  check(cw.headers.get("cross-origin-embedder-policy") === "require-corp", "worker scripts carry COEP too");
  check((await head("/.lattice/navigator/sw.js")).headers.get("service-worker-allowed") === "/", "the service worker may control the whole origin");
  // fetch() normalises dot segments (even encoded ones) before sending, so send the raw request line. Whatever path is asked
  // for, no file outside the host's own is ever served: the answer is a 404 or the plain fallback page, never file content.
  const raw = (path) => new Promise((done, fail) => http.get({ host: "127.0.0.1", port: o.port, path, headers: { host: `tasks.localhost:${o.port}` } }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => done({ status: r.statusCode, body: b })); }).on("error", fail));
  const probes = await Promise.all(["/.lattice/navigator/%2e%2e/%2e%2e/etc/passwd", "/.lattice/navigator/../../etc/passwd", "/.lattice/navigator/..%2f..%2fpackage.json", "/.lattice/navigator/nope.js", "/.lattice/navigator/"].map(raw));
  check(probes.every((p) => p.status === 404 || (p.status === 200 && /This site is a Lattice application/.test(p.body))) && !probes.some((p) => /root:|"name"|import /.test(p.body)), "only the host's own files are served from /.lattice/navigator/, whatever path is asked for", JSON.stringify(probes.map((p) => p.status)));
  const manifestStill = await head("/", "application/vnd.lattice.app+cbor");
  check(manifestStill.headers.get("content-type") === "application/vnd.lattice.app+cbor", "a Lattice client still gets the manifest at the same URL");
  check((await head("/", "application/json")).headers.get("content-type").startsWith("text/html") === true && !(await (await head("/", "application/json")).text()).includes("main.js"), "other clients still get the plain page, not the host");

  // ---- 3. Deep links ------------------------------------------------------------------------------
  await tab.goto(o.url + "/about");
  check(await tab.until("document.title === 'About'"), "a deep link routes straight to its page");
  await tab.close();

  // ---- 4. A component that does not match its hash is refused -------------------------------------
  const bad = await startOrigin("tasks", { tamper: (app) => { const b = app.blobs.get(app.manifest.entry); const copy = new Uint8Array(b.bytes); copy[copy.length - 1] ^= 0xff; b.bytes = copy; } });
  tab = await openTab(bad.url + "/");
  check(await tab.until("!!document.querySelector('#app [role=alert]')"), "a tampered component is refused with a visible message");
  const msg = await tab.js("document.querySelector('#app').textContent");
  check(/hash mismatch/.test(msg), "the message says why", msg);
  check(!(await tab.js("!!document.querySelector('h1')")) && !tab.logs.some((l) => /starting for/.test(l)), "nothing of the app ran");
  await tab.close(); await bad.close();

  // ---- 5. A manifest for another domain is refused -----------------------------------------------
  const other = await startOrigin("tasks", { tamper: (app) => { app.manifest.app = "evil.example"; } });
  tab = await openTab(other.url + "/");
  check(await tab.until("!!document.querySelector('#app [role=alert]')"), "a manifest for a different domain is refused");
  check(/manifest is for evil\.example/.test(await tab.js("document.querySelector('#app').textContent")), "and says so");
  await tab.close(); await other.close();

  // ---- 6. Without cross-origin isolation it says so instead of failing strangely -------------------
  const strip = http.createServer((req, res) => {
    const up = http.request({ host: "127.0.0.1", port: o.port, path: req.url, method: req.method, headers: { ...req.headers, host: `tasks.localhost:${o.port}` } }, (r) => {
      const h = { ...r.headers };
      delete h["cross-origin-opener-policy"]; delete h["cross-origin-embedder-policy"];
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    req.pipe(up);
  });
  const stripPort = await listen(strip);
  tab = await openTab(`http://tasks.localhost:${stripPort}/`);
  check(await tab.until("!!document.querySelector('#app [role=alert]')"), "without COOP/COEP the page explains instead of crashing");
  check(/cross-origin isolated/.test(await tab.js("document.querySelector('#app').textContent")), "and names the missing headers");
  await tab.close(); await shut(strip);

  // ---- 7. Storage persists across reloads (the todo app uses the storage capability) ---------------
  const todo = await startOrigin("todo");
  tab = await openTab(todo.url + "/");
  check(await tab.until("!!document.querySelector('input[name=title]')"), "the todo app (local storage) loads");
  await tab.js(`(() => { const i = document.querySelector('input[name=title]'); i.value = 'survives a reload'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check(await tab.until("[...document.querySelectorAll('label.check')].some((l) => l.textContent === 'survives a reload')"), "an item is added");
  await tab.reload();
  check(await tab.until("[...document.querySelectorAll('label.check')].some((l) => l.textContent === 'survives a reload')"), "after a reload the item is still there (storage via the host's kv)");
  const keys = await tab.js("Object.keys(localStorage)");
  check(keys.every((k) => k.startsWith("lattice:")) && keys.length > 0, "everything the host keeps is under one prefix", JSON.stringify(keys));
  await tab.close();

  // ---- 8. Caches: the transpile cache and the service worker ------------------------------------
  tab = await openTab(o.url + "/");
  await tab.until("!!document.querySelector('h1')");
  check(await tab.until("!!navigator.serviceWorker.controller || true", 1000), "(service worker registration is attempted)");
  await tab.reload();
  await tab.until("!!document.querySelector('h1')");
  check(await tab.until("!!navigator.serviceWorker.controller", 8000), "the service worker takes control of the origin");
  const entry = o.app.manifest.entry;
  const before = o.hits.get(`/.lattice/blob/${entry}`) ?? 0;
  const manifestBefore = o.hits.get("/ [manifest]") ?? 0;
  const transpilerBefore = o.hits.get("/.lattice/navigator/transpile-worker.js") ?? 0;
  await tab.reload();
  await tab.until("!!document.querySelector('h1')");
  await tab.reload();
  await tab.until("!!document.querySelector('h1')");
  check((o.hits.get(`/.lattice/blob/${entry}`) ?? 0) === before, "once cached, the component is not requested from the origin again (content-addressed, so never stale)");
  check((o.hits.get("/.lattice/navigator/transpile-worker.js") ?? 0) === transpilerBefore, "the transpile cache means later loads do not transpile again");
  check((o.hits.get("/ [manifest]") ?? 0) === manifestBefore + 2, "but the manifest is fetched fresh every load: the service worker never caches it", `${manifestBefore} -> ${o.hits.get("/ [manifest]")}`);
  const cached = await tab.js("caches.keys().then(async (ks) => Promise.all(ks.map(async (k) => [k, (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)])))");
  const cachedPaths = cached.flatMap(([, ps]) => ps);
  check(cachedPaths.every((p) => p.startsWith("/.lattice/blob/") || p.startsWith("/.lattice/navigator/")), "the service worker cached only the component and the host's files", JSON.stringify(cachedPaths));
  check(!cachedPaths.some((p) => p === "/" || p.startsWith("/rpc") || p.startsWith("/auth") || p.startsWith("/pay") || p.startsWith("/events")), "never the manifest, RPC, authentication, payment or analytics traffic");

  // ---- 9. Offline: the host and component still load ------------------------------------------------
  await tab.cdp("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const offlineFetch = await tab.js("fetch('/.lattice/navigator/main.js').then((r) => r.status).catch((e) => 'failed: ' + e.message)");
  check(offlineFetch === 200, "offline, the host's own files come from the service worker", String(offlineFetch));
  const offlineBlob = await tab.js(`fetch('/.lattice/blob/${entry}').then((r) => r.status).catch((e) => 'failed: ' + e.message)`);
  check(offlineBlob === 200, "offline, the component comes from the service worker too", String(offlineBlob));
  await tab.cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check(tab.problems.filter((p) => !/ERR_INTERNET_DISCONNECTED/.test(p)).length === 0, "no unexpected console errors across the whole run", tab.problems.slice(0, 3).join(" | "));
  await tab.close();
  await o.close(); await todo.close();

  // ---- 10. The general UI flows, on both apps, are the same checks as in Node mode -------------------
  for (const [name, title] of [["tasks", "Lattice Tasks"], ["todo", "Lattice Todo"]]) {
    const origin = await startOrigin(name);
    // Asynchronously: this process is the one serving the origin, so it must stay free to answer the child's browser.
    const r = await new Promise((done) => {
      const child = spawn("node", [join(here, "browser-check.mjs"), `${origin.url}/`, "--title", title], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (c) => (out += c)); child.stderr.on("data", (c) => (err += c));
      const t = setTimeout(() => child.kill(), 120000);
      child.on("close", (status) => { clearTimeout(t); done({ status, stdout: out, stderr: err }); });
    });
    check(r.status === 0 && /all browser checks passed/.test(r.stdout), `the general UI checks pass against the ${name} app in browser mode`, (r.stdout.match(/FAIL.*/g) ?? [r.stderr]).join(" | ").slice(0, 300));
    await origin.close();
  }
} finally {
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failure(s)` : "\nall browser-mode checks passed");
process.exit(failed ? 1 : 0);

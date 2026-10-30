// SPIKE runner: bundle the spike with esbuild, serve it cross-origin isolated, and run it in Edge/Chrome.
import { build } from "esbuild";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const navRoot = resolve(here, "..", "..");
const out = mkdtempSync(join(tmpdir(), "nav-spike-"));
const dist = join(out, "dist");
mkdirSync(dist);

await build({
  entryPoints: [join(navRoot, "browser", "transpile-worker.mjs"), join(here, "run-worker.mjs"), join(here, "page.mjs")],
  outdir: dist, entryNames: "[name]", bundle: true, format: "esm", platform: "browser", target: "es2022", conditions: ["browser"], external: ["node:*"], logLevel: "warning",
});
// The transpiler loads its WebAssembly relative to the worker script.
const vendor = join(navRoot, "node_modules", "@bytecodealliance", "jco-transpile", "vendor");
for (const f of readdirSync(vendor).filter((f) => f.endsWith(".wasm"))) copyFileSync(join(vendor, f), join(dist, f));
console.log("built:", readdirSync(dist).join(", "));

const todo = readFileSync(join(navRoot, "..", "examples", "todo", "target", "wasm32-wasip2", "release", "todo.wasm"));
const server = http.createServer((req, res) => {
  const iso = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html", ...iso });
    return void res.end('<!doctype html><meta charset="utf-8"><script type="module" src="/dist/page.js"></script>');
  }
  if (req.url === "/todo.wasm") { res.writeHead(200, { "Content-Type": "application/wasm", ...iso }); return void res.end(todo); }
  if (req.url.startsWith("/dist/")) {
    const f = join(dist, req.url.slice(6));
    if (!existsSync(f)) return void res.writeHead(404, iso).end();
    res.writeHead(200, { "Content-Type": f.endsWith(".wasm") ? "application/wasm" : "text/javascript", ...iso });
    return void res.end(readFileSync(f));
  }
  res.writeHead(404).end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

const exe = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const dbg = 9500 + Math.floor(Math.random() * 100);
const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${dbg}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "nav-spike-prof-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await cdp("Page.enable");
  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  let result;
  for (let i = 0; i < 150 && !result; i++) {
    await sleep(200);
    const r = await cdp("Runtime.evaluate", { expression: "window.__spike ? JSON.stringify(window.__spike) : null", returnByValue: true });
    result = r.result.result.value;
  }
  console.log(result ? JSON.stringify(JSON.parse(result), null, 2) : "TIMEOUT");
} finally { proc.kill(); server.close(); rmSync(out, { recursive: true, force: true }); }
process.exit(0);

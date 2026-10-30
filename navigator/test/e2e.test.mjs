// End-to-end tests: a real origin server, a real Lattice Navigator, the real todo WASM component.
// Requires the component to be built: (cd examples/todo && cargo build --release --target wasm32-wasip2)

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, MANIFEST_TYPE } from "../../server/server.mjs";
import { startNavigator } from "../navigator.mjs";
import { fetchApp, LoadError } from "../runtime.mjs";
import { encode } from "../../shared/cbor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..", "..", "examples", "todo");

const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
const close = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); });
const quiet = () => {};
// Transpiled components are content-addressed, so every test can share one cache.
const SHARED_CACHE = join(tmpdir(), "lattice-navigator-test-cache");


async function withNavigator(fn, { dataDir } = {}) {
  const app = await loadApp({ appDir });
  const origin = createServer(app);
  const originPort = await listen(origin);
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "nav-e2e-"));
  const nav = await startNavigator({ cacheDir: SHARED_CACHE, url: `http://127.0.0.1:${originPort}/`, dev: true, port: 0, dataDir: dir, log: quiet });
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${nav.port}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Navigator": "1", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const state = () => call("GET", "/_navigator/state").then((r) => r.body);
  try {
    return await fn({ nav, app, call, state, originPort, dir });
  } finally {
    await nav.close();
    await close(origin);
    if (!dataDir) rmSync(dir, { recursive: true, force: true });
  }
}

const find = (n, pred) => (pred(n) ? n : n.children.map((c) => find(c, pred)).find(Boolean));
const all = (n, pred, out = []) => (pred(n) && out.push(n), n.children.forEach((c) => all(c, pred, out)), out);

test("origin negotiates: CBOR manifest for Lattice clients, HTML for everyone else", async () => {
  const server = createServer(await loadApp({ appDir }));
  const port = await listen(server);
  try {
    const lat = await fetch(`http://127.0.0.1:${port}/orders/1`, { headers: { Accept: MANIFEST_TYPE } });
    assert.equal(lat.headers.get("content-type"), MANIFEST_TYPE);
    assert.match(lat.headers.get("vary"), /Accept/i);
    const html = await fetch(`http://127.0.0.1:${port}/`, { headers: { Accept: "text/html" } });
    assert.match(html.headers.get("content-type"), /text\/html/);
    assert.match(await html.text(), /Lattice application/);
  } finally { await close(server); }
});

test("loads the component, renders the scene, and enforces accessibility structure", async () => {
  await withNavigator(async ({ state }) => {
    const s = await state();
    assert.equal(s.title, "Lattice Todo");
    assert.equal(find(s.tree, (n) => n.type === "heading").props.text, "Lattice Todo");
    // every interactive node has a name
    for (const n of all(s.tree, (n) => ["button", "input", "checkbox", "link", "form"].includes(n.type))) {
      assert.ok(n.props.label, `${n.type}#${n.id} has an accessible name`);
    }
  });
});

test("actions flow through the component; state changes come back as validated updates", async () => {
  await withNavigator(async ({ state, call }) => {
    const add = find((await state()).tree, (n) => n.type === "button" && n.props.text === "Add");
    const input = find((await state()).tree, (n) => n.type === "input");
    const revBefore = input.rev;

    assert.equal((await call("POST", "/_navigator/act", { source: add.id, event: "press", values: { title: "Buy milk" } })).status, 200);
    let s = await state();
    assert.equal(find(s.tree, (n) => n.type === "text" && n.props.text.includes("item")).props.text, "1 item, 0 done");
    assert.ok(find(s.tree, (n) => n.type === "input").rev > revBefore, "re-set input gets a new revision (so the UI clears it)");

    const box = find(s.tree, (n) => n.type === "checkbox");
    await call("POST", "/_navigator/act", { source: box.id, event: "change", values: { [box.props.name]: true } });
    s = await state();
    assert.equal(find(s.tree, (n) => n.type === "checkbox").props.checked, true);
    assert.equal(find(s.tree, (n) => n.type === "text" && n.props.text.includes("item")).props.text, "1 item, 1 done");

    const del = find(s.tree, (n) => n.type === "button" && n.props.text === "Delete");
    await call("POST", "/_navigator/act", { source: del.id, event: "press", values: {} });
    assert.equal(all((await state()).tree, (n) => n.type === "checkbox").length, 0);
  });
});

test("app errors become user-facing messages with the right status", async () => {
  await withNavigator(async ({ state, call }) => {
    const add = find((await state()).tree, (n) => n.type === "button" && n.props.text === "Add");
    const r = await call("POST", "/_navigator/act", { source: add.id, event: "press", values: { title: "   " } });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "Enter something to do first.");
    assert.equal((await call("POST", "/_navigator/route", { path: "/missing" })).status, 404);
  });
});

test("routing: matches manifest routes and swaps the scene", async () => {
  await withNavigator(async ({ state, call }) => {
    assert.equal((await call("POST", "/_navigator/route", { path: "/about" })).status, 200);
    const s = await state();
    assert.equal(s.path, "/about");
    assert.equal(s.title, "About");
  });
});

test("the browser cannot invent actions, fields, or cross-site requests", async () => {
  await withNavigator(async ({ state, call, nav }) => {
    const add = find((await state()).tree, (n) => n.type === "button" && n.props.text === "Add");
    const title = find((await state()).tree, (n) => n.type === "heading");
    const ok = { source: add.id, event: "press", values: {} };

    assert.equal((await call("POST", "/_navigator/act", { source: title.id, event: "press", values: {} })).status, 400, "node without that action");
    assert.equal((await call("POST", "/_navigator/act", { source: add.id, event: "press", values: { admin: true } })).status, 400, "field outside the form");
    assert.equal((await call("POST", "/_navigator/act", { source: 99999, event: "press", values: {} })).status, 400, "unknown node");
    assert.equal((await call("POST", "/_navigator/act", { ...ok, event: "explode" })).status, 400, "unknown event");
    assert.equal((await call("POST", "/_navigator/act", { ...ok, values: { title: { nested: 1 } } })).status, 400, "non-scalar value");
    assert.equal((await call("POST", "/_navigator/act", ok, { "X-Navigator": "" })).status, 403, "missing CSRF header");
    assert.equal((await call("POST", "/_navigator/act", ok, { Origin: "https://evil.example" })).status, 403, "cross-origin");
    // fetch() ignores a custom Host header, so use a raw request to simulate DNS rebinding.
    const rebound = await new Promise((done, fail) => {
      const r = http.request({ host: "127.0.0.1", port: nav.port, method: "POST", path: "/_navigator/act",
        headers: { Host: "evil.example", "Content-Type": "application/json", "X-Navigator": "1" } }, (res) => { res.resume(); done(res.statusCode); });
      r.on("error", fail);
      r.end(JSON.stringify(ok));
    });
    assert.equal(rebound, 421, "DNS rebinding host");
    const big = await fetch(`http://127.0.0.1:${nav.port}/_navigator/act`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Navigator": "1" }, body: "x".repeat(70 * 1024),
    });
    assert.equal(big.status, 413, "oversized body");
  });
});

test("the UI shell is served with a restrictive CSP", async () => {
  await withNavigator(async ({ nav }) => {
    const res = await fetch(`http://127.0.0.1:${nav.port}/anything`, { headers: { Accept: "text/html" } });
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  });
});

test("storage persists across Lattice Navigator restarts, scoped to the app's origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-persist-"));
  try {
    await withNavigator(async ({ state, call }) => {
      const add = find((await state()).tree, (n) => n.type === "button" && n.props.text === "Add");
      await call("POST", "/_navigator/act", { source: add.id, event: "press", values: { title: "Survive a restart" } });
    }, { dataDir: dir });
    await withNavigator(async ({ state }) => {
      const labels = all((await state()).tree, (n) => n.type === "checkbox").map((n) => n.props.label);
      assert.deepEqual(labels, ["Survive a restart"]);
    }, { dataDir: dir });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Verification of what the origin serves ---------------------------------------------------

function fakeOrigin({ manifest, blob, type = MANIFEST_TYPE }) {
  const body = Buffer.from(encode(manifest));
  return http.createServer((req, res) => {
    if (req.url.startsWith("/.lattice/blob/")) return void res.writeHead(200).end(blob);
    res.writeHead(200, { "Content-Type": type }).end(body);
  });
}

test("refuses a component whose bytes do not match the manifest hash", async () => {
  const real = await loadApp({ appDir });
  const server = fakeOrigin({ manifest: real.manifest, blob: Buffer.from("not the component you were promised") });
  const port = await listen(server);
  try {
    await assert.rejects(fetchApp(`http://127.0.0.1:${port}/`, { dev: true, cacheDir: tmpdir() }), (e) => e instanceof LoadError && /hash mismatch/.test(e.message));
  } finally { await close(server); }
});

test("refuses a server that is not a Lattice origin", async () => {
  const server = http.createServer((_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>hi</h1>"));
  const port = await listen(server);
  try {
    await assert.rejects(fetchApp(`http://127.0.0.1:${port}/`, { dev: true, cacheDir: tmpdir() }), (e) => e instanceof LoadError && /not a Lattice app/.test(e.message));
  } finally { await close(server); }
});

test("refuses an invalid manifest", async () => {
  const real = await loadApp({ appDir });
  const server = fakeOrigin({ manifest: { ...real.manifest, capabilities: { requires: ["root.access"] } }, blob: Buffer.alloc(0) });
  const port = await listen(server);
  try {
    await assert.rejects(fetchApp(`http://127.0.0.1:${port}/`, { dev: true, cacheDir: tmpdir() }), (e) => e instanceof LoadError && /schema/.test(e.message));
  } finally { await close(server); }
});

test("requires https and a matching domain outside --dev", async () => {
  await assert.rejects(fetchApp("http://example.com/", { cacheDir: tmpdir() }), (e) => e instanceof LoadError && /requires https/.test(e.message));
  const real = await loadApp({ appDir });
  const server = fakeOrigin({ manifest: real.manifest, blob: Buffer.alloc(0) });
  const port = await listen(server);
  try {
    // loopback http is only allowed with --dev, and a domain mismatch is only forgiven with --dev
    await assert.rejects(fetchApp(`http://127.0.0.1:${port}/`, { cacheDir: tmpdir() }), (e) => e instanceof LoadError && /requires https/.test(e.message));
  } finally { await close(server); }
});

test("a component that needs a capability the manifest does not grant fails to link", async () => {
  const real = await loadApp({ appDir });
  const manifest = { ...real.manifest, capabilities: { requires: ["net.origin"] } }; // todo imports storage, not granted
  const server = fakeOrigin({ manifest, blob: real.blobs.get(real.manifest.entry).bytes });
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), "nav-link-"));
  try {
    await assert.rejects(startNavigator({ cacheDir: SHARED_CACHE, url: `http://127.0.0.1:${port}/`, dev: true, port: 0, dataDir: dir, log: quiet }), (e) => e instanceof LoadError && /could not be linked/.test(e.message));
  } finally { await close(server); rmSync(dir, { recursive: true, force: true }); }
});

// Typed RPC tests. Requires both components built:
//   (cd examples/todo && cargo build --release --target wasm32-wasip2)
//   (cd examples/tasks && cargo build --release --target wasm32-wasip2)

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, hashOf } from "../../server/server.mjs";
import { createRpc, ApiError, RPC_TYPE, RPC_ERROR_TYPE } from "../../server/rpc.mjs";
import { startNavigator } from "../navigator.mjs";
import { fetchApp, prepareComponent } from "../runtime.mjs";
import { RpcClient, SessionStore } from "../rpc.mjs";
import { AppHost, HostCrash } from "../apphost.mjs";
import { encode, decode } from "../../shared/cbor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, "..", "..", "examples");
const tasksDir = join(examples, "tasks");
const apiBytes = readFileSync(join(tasksDir, "api.json"));
const description = JSON.parse(apiBytes);
const apiHash = hashOf(apiBytes);

const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
const close = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); });
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (n, pred) => (pred(n) ? n : n.children.map((c) => find(c, pred)).find(Boolean));
const all = (n, pred, out = []) => (pred(n) && out.push(n), n.children.forEach((c) => all(c, pred, out)), out);

/** A hostile or broken origin: `behave(req, res, body)` decides every reply. Records requests. */
async function scripted(behave) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({ url: req.url, headers: req.headers, body });
    behave(req, res, body, seen.length);
  });
  const port = await listen(server);
  return { port, seen, endpoint: `http://127.0.0.1:${port}/rpc`, close: () => close(server) };
}

const reply = (res, status, type, value) => {
  const body = Buffer.from(encode(value));
  res.writeHead(status, { "Content-Type": type, "Content-Length": body.length });
  res.end(body);
};

const client = (endpoint, opts = {}) => new RpcClient({ endpoint, description, apiHash, session: null, ...opts });
const req = (v) => encode(v);

// ---- End to end: the tasks app -----------------------------------------------------------------

async function withTasks(fn, { dataDir, requires } = {}) {
  const app = await loadApp({ appDir: tasksDir });
  if (requires) app.manifest.capabilities = { requires };
  const origin = createServer(app);
  const originPort = await listen(origin);
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "nav-rpc-"));
  const nav = await startNavigator({ url: `http://127.0.0.1:${originPort}/`, dev: true, port: 0, dataDir: dir, log: quiet });
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${nav.port}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Navigator": "1" }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const state = () => fetch(`http://127.0.0.1:${nav.port}/_navigator/state`).then((r) => r.json());
  const press = async (text, values = {}) => {
    const s = await state();
    const b = find(s.tree, (n) => n.type === "button" && n.props.text === text);
    return call("/_navigator/act", { source: b.id, event: "press", values });
  };
  try {
    return await fn({ nav, call, state, press, dir });
  } finally {
    await nav.close();
    await close(origin);
    if (!dataDir) rmSync(dir, { recursive: true, force: true });
  }
}

test("tasks: add, toggle and delete go through typed RPC to the server", async () => {
  await withTasks(async ({ state, call, press }) => {
    assert.equal(all((await state()).tree, (n) => n.type === "checkbox").length, 0);

    assert.equal((await press("Add", { title: "Write the RPC spec" })).status, 200);
    let s = await state();
    const box = find(s.tree, (n) => n.type === "checkbox");
    assert.equal(box.props.label, "Write the RPC spec");

    await call("/_navigator/act", { source: box.id, event: "change", values: { [box.props.name]: true } });
    s = await state();
    assert.equal(find(s.tree, (n) => n.type === "checkbox").props.checked, true);
    assert.equal(find(s.tree, (n) => n.type === "text" && /task/.test(n.props.text)).props.text, "1 task, 1 done");

    assert.equal((await press("Delete")).status, 200);
    assert.equal(all((await state()).tree, (n) => n.type === "checkbox").length, 0);
  });
});

test("tasks: state lives on the server, keyed by the host's session token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-sess-"));
  const app = await loadApp({ appDir: tasksDir });
  const origin = createServer(app);
  const port = await listen(origin);
  const url = `http://127.0.0.1:${port}/`;
  const labels = async (nav) => all((await fetch(`http://127.0.0.1:${nav.port}/_navigator/state`).then((r) => r.json())).tree, (n) => n.type === "checkbox").map((n) => n.props.label);
  const add = async (nav, title) => {
    const s = await fetch(`http://127.0.0.1:${nav.port}/_navigator/state`).then((r) => r.json());
    const b = find(s.tree, (n) => n.type === "button" && n.props.text === "Add");
    await fetch(`http://127.0.0.1:${nav.port}/_navigator/act`, { method: "POST", headers: { "Content-Type": "application/json", "X-Navigator": "1" }, body: JSON.stringify({ source: b.id, event: "press", values: { title } }) });
  };
  try {
    let a = await startNavigator({ url, dev: true, port: 0, dataDir: dir, log: quiet });
    await add(a, "Mine");
    await a.close();

    // Same profile (same session token): the server still has it.
    a = await startNavigator({ url, dev: true, port: 0, dataDir: dir, log: quiet });
    assert.deepEqual(await labels(a), ["Mine"]);
    await a.close();

    // A different profile is a different session and sees nothing.
    const other = mkdtempSync(join(tmpdir(), "nav-sess2-"));
    const b = await startNavigator({ url, dev: true, port: 0, dataDir: other, log: quiet });
    assert.deepEqual(await labels(b), []);
    await b.close();
    rmSync(other, { recursive: true, force: true });
  } finally {
    await close(origin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tasks: a server-declared application error reaches the user as a message", async () => {
  await withTasks(async ({ press }) => {
    for (let i = 0; i < 50; i++) assert.equal((await press("Add", { title: `t${i}` })).status, 200);
    const r = await press("Add", { title: "one too many" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "You can have at most 50 tasks.");
  });
});

test("session capability gates the session header: without it the server says unauthorized", async () => {
  await withTasks(async ({ state }) => {
    const s = await state();
    assert.equal(s.kind, "error");
    assert.equal(s.message, "Please sign in to continue.");
  }, { requires: ["net.origin"] });
});

test("an app without net.origin cannot be linked to rpc", async () => {
  const app = await loadApp({ appDir: tasksDir });
  app.manifest.capabilities = { requires: ["session"] };
  const origin = createServer(app);
  const port = await listen(origin);
  const dir = mkdtempSync(join(tmpdir(), "nav-nolink-"));
  try {
    await assert.rejects(startNavigator({ url: `http://127.0.0.1:${port}/`, dev: true, port: 0, dataDir: dir, log: quiet }), /could not be linked/);
  } finally { await close(origin); rmSync(dir, { recursive: true, force: true }); }
});

test("the host stays responsive while a component is blocked on a slow RPC", async () => {
  // A tasks origin whose add_task takes a while.
  const handlers = {
    list_tasks: async () => ({ tasks: [] }),
    add_task: async ({ title }) => { await sleep(1500); return { task: { id: 1, title, done: false } }; },
    set_done: async () => { throw new ApiError("task_not_found", "no"); },
    delete_task: async () => { throw new ApiError("task_not_found", "no"); },
  };
  const app = await loadApp({ appDir: tasksDir });
  const rpc = createRpc({ apiDescription: description, apiHash, handlers, log: quiet });
  const origin = createServer({ ...app, rpc });
  const port = await listen(origin);
  const dir = mkdtempSync(join(tmpdir(), "nav-slow-"));
  const nav = await startNavigator({ url: `http://127.0.0.1:${port}/`, dev: true, port: 0, dataDir: dir, log: quiet });
  try {
    const s = await fetch(`http://127.0.0.1:${nav.port}/_navigator/state`).then((r) => r.json());
    const add = find(s.tree, (n) => n.type === "button" && n.props.text === "Add");
    const slow = fetch(`http://127.0.0.1:${nav.port}/_navigator/act`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Navigator": "1" },
      body: JSON.stringify({ source: add.id, event: "press", values: { title: "slow" } }),
    });
    await sleep(200); // the component is now blocked inside rpc.call
    const t0 = Date.now();
    const quick = await fetch(`http://127.0.0.1:${nav.port}/_navigator/state`);
    const elapsed = Date.now() - t0;
    assert.equal(quick.status, 200);
    assert.ok(elapsed < 500, `state endpoint answered in ${elapsed} ms while the app was blocked`);
    assert.equal((await slow).status, 200);
  } finally { await nav.close(); await close(origin); rmSync(dir, { recursive: true, force: true }); }
});

// ---- Host-side contract enforcement -------------------------------------------------------------

test("host: a request that violates the API description is never sent", async () => {
  const o = await scripted((_, res) => reply(res, 200, RPC_TYPE, { task: { id: 1, title: "x", done: false } }));
  try {
    const c = client(o.endpoint);
    for (const [method, body] of [
      ["add_task", { title: "ok", extra: 1 }],
      ["add_task", { title: 42 }],
      ["add_task", {}],
      ["add_task", { title: "x".repeat(201) }],
      ["set_done", { id: -1, done: true }],
      ["nope", {}],
    ]) {
      const r = await c.call(method, req(body));
      assert.equal(r.ok, false, `${method} ${JSON.stringify(body)}`);
      assert.equal(r.error.tag, "host");
      assert.equal(r.error.val.tag, "invalid-argument");
    }
    const garbage = await c.call("add_task", new Uint8Array([0xff, 0xff]));
    assert.equal(garbage.error.val.tag, "invalid-argument");
    assert.equal(o.seen.length, 0, "nothing reached the server");
  } finally { await o.close(); }
});

test("host: a valid call carries the API hash, a request id, and the session only when granted", async () => {
  const o = await scripted((_, res) => reply(res, 200, RPC_TYPE, { tasks: [] }));
  const dir = mkdtempSync(join(tmpdir(), "nav-hdr-"));
  try {
    await client(o.endpoint).call("list_tasks", req({}));
    await client(o.endpoint, { session: new SessionStore(dir, "x.example") }).call("list_tasks", req({}));
    const [without, withSession] = o.seen;
    assert.equal(without.url, "/rpc/list_tasks");
    assert.equal(without.headers["content-type"], RPC_TYPE);
    assert.equal(without.headers["lattice-api"], apiHash);
    assert.match(without.headers["lattice-request-id"], /^[0-9a-f-]{36}$/);
    assert.equal(without.headers["lattice-session"], undefined);
    assert.match(withSession.headers["lattice-session"], /^[A-Za-z0-9_-]{43}$/);
  } finally { await o.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("host: a response that violates the API description is withheld from the app", async () => {
  const bad = [
    { task: { id: 1, title: "x" } },                       // missing required field
    { task: { id: 1, title: "x", done: "yes" } },          // wrong type
    { task: { id: 1, title: "x", done: false }, leak: 1 }, // extra property
  ];
  let i = 0;
  const o = await scripted((_, res) => reply(res, 200, RPC_TYPE, bad[i++ % bad.length]));
  try {
    for (let n = 0; n < bad.length; n++) {
      const r = await client(o.endpoint).call("add_task", req({ title: "x" }));
      assert.equal(r.ok, false);
      assert.equal(r.error.tag, "transport");
      assert.match(r.error.val, /violates the API description/);
    }
  } finally { await o.close(); }
});

test("host: protocol violations from the server are transport errors, not app data", async () => {
  const cases = {
    "wrong content type on success": (res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<h1>hi</h1>"); },
    "success body is not CBOR": (res) => { res.writeHead(200, { "Content-Type": RPC_TYPE }); res.end("not cbor"); },
    "error without an rpc error body": (res) => { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("boom"); },
    "error with an undeclared code": (res) => reply(res, 422, RPC_ERROR_TYPE, { code: "made_up", message: "hm" }),
    "error missing a message": (res) => reply(res, 422, RPC_ERROR_TYPE, { code: "task_not_found" }),
    "a 3xx redirect": (res) => { res.writeHead(302, { Location: "http://evil.example/" }); res.end(); },
  };
  for (const [name, behave] of Object.entries(cases)) {
    const o = await scripted((_, res) => behave(res));
    try {
      const r = await client(o.endpoint).call("set_done", req({ id: 1, done: true }));
      assert.equal(r.ok, false, name);
      assert.equal(r.error.tag, "transport", name);
    } finally { await o.close(); }
  }
});

test("host: standard and declared error codes reach the app as application errors", async () => {
  for (const [code, status, method, body] of [
    ["unauthorized", 401, "list_tasks", {}],
    ["rate_limited", 429, "list_tasks", {}],
    ["task_not_found", 422, "set_done", { id: 9, done: true }], // declared for set_done
  ]) {
    const o = await scripted((_, res) => reply(res, status, RPC_ERROR_TYPE, { code, message: `m-${code}`, details: { retry_after: 3 } }));
    try {
      const r = await client(o.endpoint).call(method, req(body));
      assert.equal(r.ok, false);
      assert.equal(r.error.tag, "application");
      assert.equal(r.error.val.code, code);
      assert.equal(r.error.val.message, `m-${code}`);
      assert.deepEqual(decode(r.error.val.details), { retry_after: 3 });
    } finally { await o.close(); }
  }
});

test("host: an error code declared for a different method is not accepted", async () => {
  const o = await scripted((_, res) => reply(res, 422, RPC_ERROR_TYPE, { code: "too_many_tasks", message: "x" })); // add_task's, not set_done's
  try {
    const r = await client(o.endpoint).call("set_done", req({ id: 1, done: true }));
    assert.equal(r.error.tag, "transport");
  } finally { await o.close(); }
});

test("host: oversize responses are refused", async () => {
  const o = await scripted((_, res) => { res.writeHead(200, { "Content-Type": RPC_TYPE }); res.end(Buffer.alloc(2 * 1024 * 1024)); });
  try {
    const r = await client(o.endpoint).call("list_tasks", req({}));
    assert.equal(r.error.tag, "transport");
    assert.match(r.error.val, /too large/);
  } finally { await o.close(); }
});

test("host: a server that never answers times out", async () => {
  const o = await scripted(() => {}); // never replies
  try {
    const t0 = Date.now();
    const r = await client(o.endpoint, { timeoutMs: 300 }).call("add_task", req({ title: "x" }));
    assert.equal(r.error.tag, "transport");
    assert.match(r.error.val, /timed out/);
    assert.ok(Date.now() - t0 < 2000);
  } finally { await o.close(); }
});

test("host: reads are retried once after a network failure, writes never", async () => {
  // A server that drops the connection.
  const drops = async () => scripted((req, res) => req.socket.destroy());
  let o = await drops();
  try {
    assert.equal((await client(o.endpoint).call("list_tasks", req({}))).error.tag, "transport");
    assert.equal(o.seen.length, 2, "read (effect: read) retried once");
  } finally { await o.close(); }
  o = await drops();
  try {
    assert.equal((await client(o.endpoint).call("add_task", req({ title: "x" }))).error.tag, "transport");
    assert.equal(o.seen.length, 1, "write (effect: write) not retried");
  } finally { await o.close(); }
});

test("host: refuses an API description whose bytes do not match the manifest hash", async () => {
  const app = await loadApp({ appDir: tasksDir });
  const wasm = app.blobs.get(app.manifest.entry).bytes;
  const manifestBytes = Buffer.from(encode(app.manifest));
  const server = http.createServer((r, res) => {
    if (r.url === `/.lattice/blob/${app.manifest.entry}`) return void res.writeHead(200).end(wasm);
    if (r.url.startsWith("/.lattice/blob/")) return void res.writeHead(200).end(JSON.stringify({ ...description, title: "tampered" }));
    res.writeHead(200, { "Content-Type": "application/vnd.lattice.app+cbor" }).end(manifestBytes);
  });
  const port = await listen(server);
  try {
    await assert.rejects(fetchApp(`http://127.0.0.1:${port}/`, { dev: true }), /hash mismatch/);
  } finally { await close(server); }
});

test("host: refuses an API on another origin", async () => {
  const app = await loadApp({ appDir: tasksDir });
  app.manifest.api = { ...app.manifest.api, url: "https://elsewhere.example/rpc" };
  const server = createServer(app);
  const port = await listen(server);
  try {
    await assert.rejects(fetchApp(`http://127.0.0.1:${port}/`, { dev: true }), /cross-origin APIs are not supported/);
  } finally { await close(server); }
});

// ---- Server-side contract enforcement -----------------------------------------------------------

async function rawCall(port, method, { body, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc/${method}`, {
    method: "POST",
    headers: { "Content-Type": RPC_TYPE, "Lattice-Api": apiHash, "Lattice-Session": "s1", ...headers },
    body,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type");
  return { status: res.status, type, value: buf.length ? decode(buf) : null };
}

test("server: validates requests and enforces the contract", async () => {
  const origin = createServer(await loadApp({ appDir: tasksDir }));
  const port = await listen(origin);
  try {
    let r = await rawCall(port, "add_task", { body: encode({ title: "hello" }) });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.value.task).sort(), ["done", "id", "title"]);

    r = await rawCall(port, "add_task", { body: encode({ title: 7 }) });
    assert.equal(r.status, 400);
    assert.equal(r.value.code, "invalid_request");
    assert.equal(r.type, RPC_ERROR_TYPE);

    r = await rawCall(port, "add_task", { body: new Uint8Array([0xff]) });
    assert.equal(r.value.code, "invalid_request");

    r = await rawCall(port, "list_tasks", { body: encode({}), headers: { "Lattice-Api": "sha256-" + "A".repeat(43) } });
    assert.equal(r.status, 412);
    assert.equal(r.value.code, "api_mismatch");

    r = await rawCall(port, "list_tasks", { body: encode({}), headers: { "Lattice-Session": "" } });
    assert.equal(r.status, 401);
    assert.equal(r.value.code, "unauthorized");

    r = await rawCall(port, "no_such_method", { body: encode({}) });
    assert.equal(r.status, 404);

    r = await rawCall(port, "list_tasks", { body: encode({}), headers: { "Content-Type": "application/json" } });
    assert.equal(r.status, 400);

    const get = await fetch(`http://127.0.0.1:${port}/rpc/list_tasks`);
    assert.equal(get.status, 405);

    r = await rawCall(port, "add_task", { body: Buffer.alloc(2 * 1024 * 1024) });
    assert.equal(r.status, 400, "oversize body");
  } finally { await close(origin); }
});

test("server: a handler that breaks the contract produces a generic 500, not a leak", async () => {
  const logs = [];
  const handlers = {
    list_tasks: async () => ({ tasks: [{ id: 1, title: "x", done: false, secret: "do not leak" }] }), // extra field
    add_task: async () => { throw new ApiError("made_up_code", "undeclared"); },
    set_done: async () => { throw new Error("db password is hunter2"); },
    delete_task: async () => ({}),
  };
  const rpc = createRpc({ apiDescription: description, apiHash, handlers, log: (m) => logs.push(m) });
  const app = await loadApp({ appDir: tasksDir });
  const origin = createServer({ ...app, rpc });
  const port = await listen(origin);
  try {
    for (const [method, body] of [["list_tasks", {}], ["add_task", { title: "x" }], ["set_done", { id: 1, done: true }]]) {
      const r = await rawCall(port, method, { body: encode(body) });
      assert.equal(r.status, 500, method);
      assert.equal(r.value.code, "internal");
      assert.equal(r.value.message, "internal error");
      assert.doesNotMatch(JSON.stringify(r.value), /secret|hunter2|made_up/);
    }
    assert.ok(logs.some((l) => /violates the API description/.test(l)));
    assert.ok(logs.some((l) => /undeclared error code/.test(l)));
  } finally { await close(origin); }
});

test("server: refuses to start with a handler/description mismatch", () => {
  assert.throws(() => createRpc({ apiDescription: description, apiHash, handlers: { list_tasks: async () => ({}) } }), /has no handler/);
  assert.throws(() => createRpc({ apiDescription: description, apiHash, handlers: { list_tasks() {}, add_task() {}, set_done() {}, delete_task() {}, extra() {} } }), /not in the API description/);
});

// ---- Watchdog ------------------------------------------------------------------------------------

test("a component that hangs is killed by the watchdog and Lattice Navigator recovers", async () => {
  const todo = await loadApp({ appDir: join(examples, "todo") });
  const server = createServer(todo);
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), "nav-wd-"));
  try {
    const { manifest, wasm } = await fetchApp(`http://127.0.0.1:${port}/`, { dev: true });
    const entryJs = await prepareComponent({ manifest, wasm, cacheDir: join(dir, "cache") });
    const host = new AppHost({ entryJs, granted: new Set(["storage.local"]), origin: "todo.localhost", dataDir: join(dir, "data"), rpc: null, onLog: quiet, watchdogMs: 400, debug: true });
    await host.start();
    const launch = { origin: "todo.localhost", locale: "en", colorScheme: "light", reducedMotion: false, textScale: 1, online: true, granted: [] };
    await host.call("init", launch);

    const t0 = Date.now();
    await assert.rejects(host.call("debug-hang", undefined), HostCrash);
    assert.ok(Date.now() - t0 < 3000, "killed promptly");
    await assert.rejects(host.call("init", launch), HostCrash, "dead until restarted");

    await host.restart();
    await host.call("init", launch); // a fresh instance works
    host.kill();
  } finally { await close(server); rmSync(dir, { recursive: true, force: true }); }
});

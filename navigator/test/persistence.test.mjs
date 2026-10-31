// Origin state across restarts (server/store.mjs, and what auth, payments and the tasks app keep in it).
// Each "restart" closes the data file and sets the app up again from it, as a new process would.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../../server/store.mjs";
import { createAuth } from "../../server/auth.mjs";
import { hashOf, loadApp } from "../../server/server.mjs";
import { startPsp } from "../../server/dev-psp.mjs";
import { setup } from "../../examples/tasks/api.mjs";
import { RPC_TYPE } from "../../server/rpc.mjs";
import { encode, decode } from "../../shared/cbor.mjs";
import { FakeAuthenticator } from "./fake-authenticator.mjs";
import { tasksDir, quiet, listen, close } from "./stack.mjs";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "server");
const manifest = JSON.parse(readFileSync(join(tasksDir, "manifest.json"), "utf8"));
const apiHash = hashOf(readFileSync(join(tasksDir, "api.json")));
const inDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "lattice-store-"));
  try { await fn(join(dir, "origin.sqlite"), dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("store: maps and sets come back as they were, including bytes, and deletes stay deleted", async () => {
  await inDir(async (file) => {
    let s = await openStore(file);
    const m = s.map("things");
    m.set("a", { n: 1, key: new Uint8Array([0, 1, 255]), nested: [{ b: new Uint8Array([7]) }] });
    m.set("gone", 1);
    m.delete("gone");
    s.map("other").set("a", "not the same collection");
    const set = s.set("names");
    set.add("x").add("y").add("x");
    set.delete("y");
    s.close();

    s = await openStore(file);
    const back = s.map("things");
    assert.deepEqual([...back.keys()], ["a"]);
    assert.deepEqual(back.get("a").key, new Uint8Array([0, 1, 255]));
    assert.ok(back.get("a").key instanceof Uint8Array);
    assert.deepEqual(back.get("a").nested[0].b, new Uint8Array([7]));
    assert.equal(s.map("other").get("a"), "not the same collection");
    assert.deepEqual([...s.set("names")], ["x"]);
    s.close();
  });
});

test("store: a value changed in place is only kept once it is set again", async () => {
  await inDir(async (file) => {
    let s = await openStore(file);
    const m = s.map("m");
    const v = { n: 1 };
    m.set("k", v);
    v.n = 2;
    s.close();
    s = await openStore(file);
    assert.equal(s.map("m").get("k").n, 1);
    s.close();
  });
});

test("store: a failed write throws and leaves the collection unchanged", async () => {
  await inDir(async (file) => {
    const s = await openStore(file);
    const m = s.map("m");
    m.set("k", 1);
    s.close(); // every later write fails
    assert.throws(() => m.set("k", 2));
    assert.throws(() => m.delete("k"));
    assert.equal(m.get("k"), 1);
  });
});

test("store: a second process cannot open a file that is in use, and a file from a newer version is refused", async () => {
  await inDir(async (file, dir) => {
    const s = await openStore(file);
    await assert.rejects(openStore(file), /could not open/);
    s.close();
    (await openStore(file)).close();

    const newer = join(dir, "newer.sqlite");
    const db = new DatabaseSync(newer);
    db.exec("PRAGMA user_version = 99");
    db.close();
    await assert.rejects(openStore(newer), /newer version/);
  });
});

test("auth: sessions and accounts survive a restart, the file holds no usable token, and expired sessions are removed", async () => {
  await inDir(async (file, dir) => {
    let t = 1_000_000_000;
    const opts = { rpId: "tasks.localhost", rpName: "T", now: () => t, log: quiet };
    let store = await openStore(file);
    let auth = createAuth({ ...opts, store });
    auth.users.set("u_1", { name: "Ann", credentials: [{ id: "c", publicKey: new Uint8Array([1, 2]), counter: 3 }] });
    const session = auth.issueSession("u_1", "Ann");
    store.close();

    const raw = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("");
    assert.ok(!raw.includes(session.token), "the token is not on disk");

    store = await openStore(file);
    auth = createAuth({ ...opts, store });
    assert.deepEqual(auth.identify(session.token), { subject: "u_1", name: "Ann" });
    assert.deepEqual(auth.users.get("u_1").credentials[0].publicKey, new Uint8Array([1, 2]));
    store.close();

    t += 3600_000 + 1000;
    store = await openStore(file);
    auth = createAuth({ ...opts, store });
    assert.equal(auth.sessions.size, 0, "expired while stopped");
    store.close();
  });
});

test("auth: a passkey registered before a restart signs in after it, and a clone is still caught by the saved counter", async () => {
  await inDir(async (file) => {
    const opts = { rpId: "tasks.localhost", rpName: "T", log: quiet };
    const sessions = [];
    const ctx = { setSession: (s) => sessions.push(s) };
    const authn = new FakeAuthenticator({ origin: "http://tasks.localhost:7070", rpId: "tasks.localhost" });
    const login = async (auth, counter) => {
      const { options } = await auth.passkey.loginBegin();
      return auth.passkey.loginFinish({ response: JSON.stringify(authn.get(JSON.parse(options), { counter })) }, ctx);
    };

    let store = await openStore(file);
    let auth = createAuth({ ...opts, store });
    const { options } = await auth.passkey.registerBegin({ name: "Ann" });
    await auth.passkey.registerFinish({ response: JSON.stringify(authn.create(JSON.parse(options))) }, ctx);
    await login(auth, 5);
    store.close();

    store = await openStore(file);
    auth = createAuth({ ...opts, store });
    assert.equal((await login(auth, 6)).name, "Ann");
    assert.equal(sessions.at(-1).subject, sessions[0].subject, "the same account");
    store.close();

    store = await openStore(file);
    auth = createAuth({ ...opts, store });
    await assert.rejects(login(auth, 6), "the counter from the login before the restart still counts");
    store.close();
  });
});

test("a server killed outright keeps what it had acknowledged", async () => {
  await inDir(async (file) => {
    const probe = http.createServer();
    const port = await listen(probe);
    await close(probe);
    const run = (whileUp) => new Promise((done, fail) => {
      const p = spawn(process.execPath, ["--no-warnings", join(serverDir, "server.mjs"), "--app", tasksDir, "--port", String(port), "--dev", "--no-navigator", "--no-webtransport", "--data", file], { stdio: ["ignore", "pipe", "inherit"] });
      let outcome = done;
      p.once("exit", () => outcome());
      p.stdout.on("data", async (c) => {
        if (!/data {2}/.test(String(c))) return;
        try { await whileUp(); } catch (e) { outcome = () => fail(e); }
        p.kill("SIGKILL");
      });
    });
    const rpc = async (session, method, body) => {
      const res = await fetch(`http://127.0.0.1:${port}/rpc/${method}`, { method: "POST", headers: { "Content-Type": RPC_TYPE, Accept: RPC_TYPE, "Lattice-Session": session, "Lattice-Api": apiHash, "Lattice-Request-Id": randomUUID() }, body: Buffer.from(encode(body)) });
      assert.equal(res.status, 200, await res.clone().text());
      return decode(new Uint8Array(await res.arrayBuffer()));
    };
    // Sessions are the origin's own: seed one as a sign-in would have, while nothing else has the file.
    const seed = await openStore(file);
    const { token } = createAuth({ rpId: "tasks.localhost", rpName: "T", log: quiet, store: seed }).issueSession("u_1", "Ann");
    seed.close();

    await run(() => rpc(token, "add_task", { title: "acknowledged" }));
    await run(async () => {
      assert.deepEqual((await rpc(token, "list_tasks", {})).tasks.map((t) => t.title), ["acknowledged"]);
    });
  });
});

// ---- The tasks app, with a processor -----------------------------------------------------------------------------

async function start(file, psp) {
  const store = await openStore(file);
  const impl = await setup({
    manifest, oidc: [], dev: true, log: quiet, store,
    stripe: { secretKey: psp.secretKey, webhookSecret: psp.webhookSecret, publishableKey: psp.publishableKey, processorApi: psp.url, api: { protocol: "http", host: "127.0.0.1", port: psp.port } },
  });
  const server = http.createServer((req, res) => impl.http[new URL(req.url, "http://x").pathname](req, res));
  const port = await listen(server);
  psp.configure({ webhookUrl: `http://127.0.0.1:${port}/pay/webhook` });
  return { impl, store, port, stop: async () => { await close(server); store.close(); } };
}

const SID = "a".repeat(32);
/** A signed-in user's order, with an intent at the processor, as the host would have asked for. */
async function orderWithIntent(run, token) {
  const { order_ref } = await run.impl.handlers.create_order({ sku: "pro" }, { session: token });
  const origin = `http://${manifest.app}`;
  const r = await fetch(`http://127.0.0.1:${run.port}/pay/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lattice-Session": token },
    body: JSON.stringify({ order_ref, methods: ["card_sheet"], return_url: `${origin}/_navigator/payment/return?state=${SID}`, cancel_url: `${origin}/_navigator/payment/cancel?state=${SID}` }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return { order_ref, intent: (await r.json()).reference };
}
const succeeded = (psp, id) => {
  const intent = psp.intents.get(id);
  return psp.makeEvent("payment_intent.succeeded", { ...intent, status: "succeeded", amount_received: intent.amount });
};

test("tasks: a signed-in user's tasks, order and Pro survive a restart; a webhook that arrives after it still counts", async () => {
  await inDir(async (file) => {
    const psp = await startPsp();
    let run = await start(file, psp);
    const { token, subject } = run.impl.auth.issueSession("u_1", "Ann");
    const ctx = { session: token };
    const { task } = await run.impl.handlers.add_task({ title: "keep me" }, ctx);
    await run.impl.handlers.add_task({ title: "delete me" }, ctx);
    await run.impl.handlers.set_done({ id: task.id, done: true }, ctx);
    await run.impl.handlers.delete_task({ id: task.id + 1 }, ctx);
    await run.impl.handlers.add_task({ title: "only until restart" }, { session: "anon".repeat(10) });
    const { order_ref, intent } = await orderWithIntent(run, token);
    await run.stop();

    run = await start(file, psp);
    assert.deepEqual((await run.impl.handlers.list_tasks({}, ctx)).tasks, [{ id: task.id, title: "keep me", done: true }]);
    assert.equal((await run.impl.handlers.add_task({ title: "next" }, ctx)).task.id, task.id + 2, "ids are not reused");
    assert.deepEqual((await run.impl.handlers.list_tasks({}, { session: "anon".repeat(10) })).tasks, [], "anonymous tasks are not kept");
    assert.equal((await run.impl.handlers.order_status({ order_ref }, ctx)).status, "pending");

    // The intent was remembered, so the processor's webhook is accepted by the new process.
    assert.equal((await psp.deliver(succeeded(psp, intent))).status, 200);
    assert.equal((await run.impl.handlers.order_status({ order_ref }, ctx)).status, "paid");
    assert.equal((await run.impl.handlers.profile({}, ctx)).pro, true);
    await run.stop();

    run = await start(file, psp);
    assert.equal((await run.impl.handlers.profile({}, ctx)).pro, true);
    assert.equal(run.impl.pro.has(subject), true);
    await assert.rejects(run.impl.handlers.create_order({ sku: "pro" }, ctx), /already have Pro/);
    await run.stop();
    await psp.close();
  });
});

test("payments: an order paid but not fulfilled when the process died is fulfilled at startup", async () => {
  await inDir(async (file) => {
    const psp = await startPsp();
    let run = await start(file, psp);
    const { token } = run.impl.auth.issueSession("u_1", "Ann");
    const { order_ref, intent } = await orderWithIntent(run, token);
    // What a crash between saving the payment and running the hook leaves behind.
    const order = run.impl.payments.orders.get(order_ref);
    run.impl.payments.orders.set(order_ref, { ...order, status: "paid", paidSessionId: intent });
    await run.stop();

    run = await start(file, psp);
    assert.equal(run.impl.pro.has("u_1"), true);
    assert.equal(run.impl.payments.orders.get(order_ref).fulfilled, true);
    await run.stop();
    await psp.close();
  });
});

test("payments: when the payment cannot be saved the webhook fails, nothing changes, and the processor's retry works", async () => {
  await inDir(async (file) => {
    const psp = await startPsp();
    const run = await start(file, psp);
    const { token } = run.impl.auth.issueSession("u_1", "Ann");
    const { order_ref, intent } = await orderWithIntent(run, token);
    const { orders } = run.impl.payments;
    const event = succeeded(psp, intent);

    orders.set = () => { throw new Error("disk full"); };
    assert.equal((await psp.deliver(event)).status, 500);
    assert.equal(orders.get(order_ref).status, "pending");
    assert.equal(run.impl.pro.has("u_1"), false);

    delete orders.set;
    assert.equal((await psp.deliver(event)).status, 200, "the same event, retried");
    assert.equal(orders.get(order_ref).status, "paid");
    assert.equal(run.impl.pro.has("u_1"), true);
    await run.stop();
    await psp.close();
  });
});

test("loadApp: --data opens the file for the app; without it nothing is written", async () => {
  await inDir(async (file, dir) => {
    const stored = await loadApp({ appDir: tasksDir, dev: true, data: file, log: quiet });
    stored.impl.auth.users.set("u_1", { name: "Ann", credentials: [] });
    stored.store.close();
    const again = await loadApp({ appDir: tasksDir, dev: true, data: file, log: quiet });
    assert.equal(again.impl.auth.users.get("u_1").name, "Ann");
    again.store.close();

    const before = readdirSync(dir).length;
    const memory = await loadApp({ appDir: tasksDir, dev: true, log: quiet });
    memory.impl.auth.users.set("u_1", { name: "Ann", credentials: [] });
    assert.equal(readdirSync(dir).length, before);
  });
});

test("store: a file that is not a database, or one that cannot be written to, is refused with a message that names the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lattice-store-"));
  try {
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "this is not a sqlite database, it is a text file ".repeat(40));
    await assert.rejects(openStore(junk, { log: () => {} }), (e) => e.message.includes("junk.db") && /could not open the data file/.test(e.message));
    assert.equal(readFileSync(junk, "utf8").startsWith("this is not"), true, "the file was not overwritten");

    await assert.rejects(openStore(join(dir, "missing-dir", "x.db"), { log: () => {} }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

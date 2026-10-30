// Analytics tests: the policy (levels, catalog, redaction, limits, delivery) as units, then the whole
// path through Navigator to a first-party collector. Requires the tasks component to be built.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics, LEVELS, DEFAULT_LEVEL, scrub, checkProps } from "../analytics.mjs";
import { Session, HttpError } from "../navigator.mjs";
import { HostCrash, ComponentError } from "../apphost.mjs";
import { createCollector, checkBatch } from "../../server/analytics.mjs";
import { withStack, find, sleep, quiet } from "./stack.mjs";

const stack = (fn, opts = {}) => withStack(fn, opts);

// ---- Unit harness -------------------------------------------------------------------------------

const CATALOG = [
  { name: "task_added", props: { tasks: { type: "integer" } } },
  { name: "task_done", props: { done: { type: "boolean" } } },
  { name: "signed_in", props: { method: { type: "string", enum: ["passkey", "oidc"] } } },
  { name: "ping", props: {} },
  { name: "note", props: { text: { type: "string", max_length: 100 }, score: { type: "number" } } },
  { name: "wide", props: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, { type: "integer" }])) },
];
const ALL = [{ name: "First", endpoint: "https://a.example/events", purposes: ["product", "performance", "errors"] }];

function mk({ level = "full", processors = ALL, dev = false, status = 204, now, backoffMs = [1, 1, 1], flushMs = 3_600_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nav-an-"));
  const calls = [];
  const logs = [];
  let clock = 1_730_000_005_500;
  const behaviour = { status, error: null, statuses: null };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (behaviour.error) throw behaviour.error;
    const st = behaviour.statuses ? behaviour.statuses.shift() ?? 204 : behaviour.status;
    return new Response(null, { status: st });
  };
  const manifest = { app: "tasks.localhost", version: "1.2.3", entry: "sha256-" + "A".repeat(43), analytics: { events: CATALOG } };
  const a = new Analytics({ manifest, processors, dataDir: dir, dev, log: (l, m) => logs.push([l, m]), fetchImpl, now: now ?? (() => clock), flushMs, backoffMs });
  a.setLevel(level);
  return { a, calls, logs, dir, behaviour, tick: (ms) => { clock += ms; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const sent = (calls) => calls.flatMap((c) => c.body.events);

// ---- Levels ---------------------------------------------------------------------------------------

test("levels: what each level sends, and what identifies the sender", async () => {
  const expected = { off: [], errors: ["error"], anonymous: ["error", "performance", "product"], full: ["error", "performance", "product"] };
  assert.deepEqual(LEVELS, ["off", "errors", "anonymous", "full"]);
  for (const level of LEVELS) {
    const h = mk({ level });
    h.a.emit("task_added", { tasks: 1 });
    h.a.host("performance", "host.route", { handler: "Home", ms: 42 });
    h.a.reportError("something_broke", "it broke");
    await h.a.flush();
    assert.deepEqual([...new Set(sent(h.calls).map((e) => e.kind))].sort(), expected[level], level);
    for (const c of h.calls) {
      assert.equal(c.body.level, level);
      assert.equal("client" in c.body, level === "full", `${level}: client id only at full`);
    }
    h.cleanup();
  }
});

test("levels: timestamps are coarse unless the user chose full", async () => {
  const lo = mk({ level: "anonymous" });
  lo.a.emit("ping", {});
  await lo.a.flush();
  const body = lo.calls[0].body;
  assert.equal(body.sent_at % 60, 0);
  assert.equal(body.events[0].t % 60, 0);

  const hi = mk({ level: "full" });
  hi.a.emit("ping", {});
  await hi.a.flush();
  assert.equal(hi.calls[0].body.events[0].t, Math.floor(1_730_000_005_500 / 1000), "exact seconds at full");
  lo.cleanup(); hi.cleanup();
});

test("levels: the default is errors only, and the choice persists across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-an-lv-"));
  const make = () => new Analytics({ manifest: { app: "x.example", analytics: { events: [] } }, processors: ALL, dataDir: dir, fetchImpl: async () => new Response(null, { status: 204 }) });
  try {
    assert.equal(DEFAULT_LEVEL, "errors");
    const a = make();
    assert.equal(a.level, "errors");
    a.setLevel("anonymous");
    assert.equal(make().level, "anonymous");
    assert.throws(() => a.setLevel("everything"), RangeError);
    assert.throws(() => a.setLevel(undefined), RangeError);
    assert.throws(() => a.setLevel({}), RangeError);
    assert.equal(a.level, "anonymous", "a refused change changes nothing");
    assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).analytics, "anonymous");
    // Settings written by something else do not break it.
    rmSync(join(dir, "settings.json"));
    assert.equal(make().level, "errors");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("levels: lowering the level discards what is queued and could no longer be sent", async () => {
  const h = mk({ level: "full" });
  h.a.emit("task_added", { tasks: 1 });
  h.a.reportError("late", "x");
  h.a.setLevel("errors");
  await h.a.flush();
  assert.deepEqual(sent(h.calls).map((e) => e.kind), ["error"]);
  h.a.emit("task_added", { tasks: 2 });
  h.a.setLevel("off");
  await h.a.flush();
  assert.equal(h.calls.length, 1, "nothing more once off");
  h.cleanup();
});

// ---- The catalog ----------------------------------------------------------------------------------

test("catalog: an event that is not declared, or breaks its declaration, is dropped whole", async () => {
  const h = mk();
  const bad = [
    ["not in the catalog", "unknown_event", {}],
    ["name is not a string", 42, {}],
    ["name is an object", { toString: () => "ping" }, {}],
    ["undeclared property", "task_added", { tasks: 1, email: "a@b.c" }],
    ["only undeclared properties", "ping", { x: 1 }],
    ["wrong type: string for integer", "task_added", { tasks: "3" }],
    ["wrong type: fractional integer", "task_added", { tasks: 1.5 }],
    ["wrong type: unsafe integer", "task_added", { tasks: 2 ** 60 }],
    ["wrong type: NaN", "note", { score: NaN }],
    ["wrong type: Infinity", "note", { score: Infinity }],
    ["wrong type: number for boolean", "task_done", { done: 1 }],
    ["null value", "task_added", { tasks: null }],
    ["nested object", "task_added", { tasks: { n: 1 } }],
    ["array value", "task_added", { tasks: [1] }],
    ["enum violation", "signed_in", { method: "password" }],
    ["enum with a near miss", "signed_in", { method: "Passkey" }],
    ["string too long", "note", { text: "x".repeat(101) }],
    ["props not an object", "ping", "nope"],
    ["props is null", "ping", null],
    ["props is an array", "ping", [1, 2]],
    ["too many properties", "wide", Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, i]))],
    ["prototype key", "ping", JSON.parse('{"__proto__": 1}')],
    ["inherited key", "ping", { constructor: 1 }],
  ];
  for (const [why, name, props] of bad) {
    const before = h.a.stats.dropped;
    h.a.emit(name, props);
    assert.equal(h.a.stats.dropped, before + 1, why);
  }
  await h.a.flush();
  assert.equal(h.calls.length, 0, "nothing was sent, not even a partial event");

  // Controls: the same shapes, valid.
  h.a.emit("task_added", { tasks: 3 });
  h.a.emit("task_done", { done: false });
  h.a.emit("signed_in", { method: "oidc" });
  h.a.emit("note", { text: "x".repeat(100), score: 0.5 });
  h.a.emit("ping", {});
  await h.a.flush();
  assert.deepEqual(sent(h.calls).map((e) => e.name), ["task_added", "task_done", "signed_in", "note", "ping"]);
  h.cleanup();
});

test("catalog: checkProps is strict about types and defaults strings to 64 characters", () => {
  const def = { props: { s: { type: "string" }, n: { type: "number" }, i: { type: "integer" }, b: { type: "boolean" } } };
  assert.equal(checkProps(def, { s: "x".repeat(64), n: -1.5, i: -7, b: true }), null);
  assert.match(checkProps(def, { s: "x".repeat(65) }), /too long/);
  assert.match(checkProps(def, { z: 1 }), /not declared/);
  assert.equal(checkProps({}, {}), null, "an event with no props at all");
  assert.match(checkProps({ props: { s: { type: "weird" } } }, { s: 1 }), /unknown type/);
});

test("catalog: a processor-less app, or an app with no processor for the kind, sends and drops nothing", async () => {
  const none = mk({ processors: [] });
  none.a.emit("task_added", { tasks: 1 });
  none.a.reportError("x", "y");
  await none.a.flush();
  assert.equal(none.calls.length, 0);
  assert.equal(none.a.stats.held, 2, "held back, not counted as errors");
  assert.equal(none.a.stats.dropped, 0);

  const errorsOnly = mk({ processors: [{ name: "E", endpoint: "https://e.example/in", purposes: ["errors"] }] });
  errorsOnly.a.emit("task_added", { tasks: 1 });
  errorsOnly.a.reportError("x", "y");
  await errorsOnly.a.flush();
  assert.deepEqual(sent(errorsOnly.calls).map((e) => e.kind), ["error"], "product events have nowhere to go");
  none.cleanup(); errorsOnly.cleanup();
});

// ---- Limits ----------------------------------------------------------------------------------------

test("limits: per-minute caps stop a flood, and recover as time passes", async () => {
  const h = mk();
  for (let i = 0; i < 100; i++) h.a.emit("ping", {});
  for (let i = 0; i < 50; i++) h.a.host("performance", "host.route", { handler: "H", ms: 10 });
  for (let i = 0; i < 40; i++) h.a.reportError("loop", "same failure");
  await h.a.flush();
  const kinds = sent(h.calls).reduce((o, e) => ((o[e.kind] = (o[e.kind] ?? 0) + 1), o), {});
  assert.deepEqual(kinds, { product: 60, performance: 30, error: 20 });
  assert.equal(h.a.stats.dropped, 40 + 20 + 20);

  h.tick(61_000);
  h.a.emit("ping", {});
  await h.a.flush();
  assert.equal(sent(h.calls).filter((e) => e.kind === "product").length, 61, "accepted again after a minute");
  h.cleanup();
});

test("limits: batches are at most 20 events, and each goes to every processor that wants it", async () => {
  const h = mk();
  for (let i = 0; i < 45; i++) { h.a.emit("ping", {}); if (i % 10 === 9) h.tick(30_000); }
  await h.a.flush();
  assert.deepEqual(h.calls.map((c) => c.body.events.length).sort((a, b) => b - a), [20, 20, 5]);
  assert.ok(h.calls.every((c) => Buffer.byteLength(c.init.body) < 64 * 1024));
  h.cleanup();
});

// ---- Delivery --------------------------------------------------------------------------------------

test("delivery: the request carries no credentials, no session, and follows no redirects", async () => {
  const h = mk({ level: "full", processors: [{ name: "Third", endpoint: "https://tracker.example/ingest", purposes: ["product"] }] });
  h.a.emit("signed_in", { method: "passkey" });
  await h.a.flush();
  const { url, init, body } = h.calls[0];
  assert.equal(url, "https://tracker.example/ingest");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/vnd.lattice.events+json");
  assert.deepEqual(Object.keys(init.headers), ["Content-Type"], "no Authorization, Cookie or Lattice-Session");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.deepEqual(body.app, { domain: "tasks.localhost", version: "1.2.3", build: "sha256-" + "A".repeat(43) });
  assert.equal(body.v, 1);
  assert.match(body.client, /^c_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(body.events[0].props, { method: "passkey" });
  assert.doesNotMatch(init.body, /session|token|subject|cookie/i);
  h.cleanup();
});

test("delivery: events go only to processors declared for their kind", async () => {
  const procs = [
    { name: "Product", endpoint: "https://p.example/e", purposes: ["product"] },
    { name: "Errors", endpoint: "https://e.example/e", purposes: ["errors"] },
    { name: "Both", endpoint: "https://b.example/e", purposes: ["performance", "errors"] },
  ];
  const h = mk({ processors: procs });
  h.a.emit("ping", {});
  h.a.host("performance", "host.route", { handler: "Home", ms: 5 });
  h.a.reportError("boom", "x");
  await h.a.flush();
  const to = (name) => h.calls.filter((c) => procs.find((p) => p.endpoint === c.url).name === name).flatMap((c) => c.body.events.map((e) => e.name));
  assert.deepEqual(to("Product"), ["ping"]);
  assert.deepEqual(to("Errors"), ["app.reported"]);
  assert.deepEqual(to("Both").sort(), ["app.reported", "host.route"]);
  assert.deepEqual(h.a.snapshot().recent.find((e) => e.name === "app.reported").to.sort(), ["Both", "Errors"]);
  h.cleanup();
});

test("delivery: unacceptable endpoints are never used", async () => {
  const bad = [
    { name: "Plain http", endpoint: "http://tracker.example/e", purposes: ["errors"] },
    { name: "Credentials", endpoint: "https://user:pw@tracker.example/e", purposes: ["errors"] },
    { name: "Not a URL", endpoint: "tracker", purposes: ["errors"] },
    { name: "javascript", endpoint: "javascript:alert(1)", purposes: ["errors"] },
    { name: "Loopback without dev", endpoint: "http://127.0.0.1:9/e", purposes: ["errors"] },
  ];
  const h = mk({ processors: bad });
  assert.deepEqual(h.a.processors, []);
  h.a.reportError("x", "y");
  await h.a.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.filter(([l]) => l === "warn").length, bad.length);

  const dev = mk({ dev: true, processors: [{ name: "Local", endpoint: "http://127.0.0.1:9/e", purposes: ["errors"] }] });
  assert.equal(dev.a.processors.length, 1, "loopback http is fine in development");
  h.cleanup(); dev.cleanup();
});

test("delivery: failures are retried sensibly and never reach the caller", async () => {
  const h = mk();
  h.behaviour.status = 503;
  h.a.reportError("one", "x");
  await h.a.flush();
  assert.equal(h.calls.length, 4, "the attempt plus three retries");
  assert.equal(h.a.stats.failed, 1);
  assert.equal(h.a.stats.sent, 0);

  const client = mk();
  client.behaviour.status = 400;
  client.a.reportError("one", "x");
  await client.a.flush();
  assert.equal(client.calls.length, 1, "a 4xx is the processor refusing: no retry");

  const rate = mk();
  rate.behaviour.statuses = [429, 204];
  rate.a.reportError("one", "x");
  await rate.a.flush();
  assert.equal(rate.calls.length, 2, "429 is retried");
  assert.equal(rate.a.stats.sent, 1);
  assert.equal(rate.a.stats.failed, 0);

  const down = mk();
  down.behaviour.error = new Error("ECONNREFUSED");
  down.a.reportError("one", "x");
  await down.a.flush();
  assert.equal(down.calls.length, 4);
  assert.equal(down.a.stats.failed, 1);

  // A slow processor that never answers does not hang the caller beyond the five-second timeout.
  for (const x of [h, client, rate, down]) x.cleanup();
});

test("delivery: a level lowered while a retry waits stops the retry", async () => {
  const h = mk({ backoffMs: [30, 30, 30] });
  h.behaviour.status = 500;
  h.a.reportError("one", "x");
  const flushing = h.a.flush();
  await sleep(10);
  h.a.setLevel("off");
  await flushing;
  assert.equal(h.calls.length, 1, "the retry saw the new level and did not send");
  h.cleanup();
});

test("delivery: closing makes a last attempt and stops all timers", async () => {
  const h = mk({ flushMs: 60_000 });
  h.a.reportError("late", "x");
  assert.equal(h.calls.length, 0, "not sent yet: the batch timer has not fired");
  await h.a.close();
  assert.equal(h.calls.length, 1);
  h.behaviour.status = 500;
  h.a.reportError("after", "x");
  await h.a.close(); // must not retry forever or leave timers behind
  h.cleanup();
});

// ---- Redaction ------------------------------------------------------------------------------------

test("redaction: values the user typed into sensitive fields never leave, even when the app copies them", async () => {
  const h = mk();
  h.a.noteSensitive(["hunter2hunter2", "abc", 482913]);
  h.a.reportError("login_failed", "bad password hunter2hunter2 for user, pin 482913");
  h.a.emit("note", { text: "typed hunter2hunter2 hunter2hunter2 here" });
  h.a.emit("note", { text: "short abc is ignored" }); // under four characters is not tracked
  await h.a.flush();
  const text = JSON.stringify(sent(h.calls));
  assert.doesNotMatch(text, /hunter2hunter2/);
  assert.doesNotMatch(text, /482913/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /short abc is ignored/);

  // They are forgotten after ten minutes, and only the newest twenty are kept.
  h.tick(11 * 60_000);
  h.a.reportError("later", "hunter2hunter2 again");
  const many = mk();
  many.a.noteSensitive(Array.from({ length: 25 }, (_, i) => `secret-value-${String(i).padStart(2, "0")}`));
  many.a.reportError("e", "secret-value-00 secret-value-24");
  await h.a.flush(); await many.a.flush();
  assert.match(JSON.stringify(sent(h.calls)), /hunter2hunter2 again/, "expired");
  assert.equal(sent(many.calls)[0].props.detail, "secret-value-00 [redacted]", "the oldest were evicted");
  h.cleanup(); many.cleanup();
});

test("redaction: error text is scrubbed of emails, numbers and tokens, and cut short", async () => {
  assert.equal(scrub("failed for ann.lee+x@example.co.uk now"), "failed for [email] now");
  assert.equal(scrub("card 4242 4242 4242 4242 declined"), "card [number] declined");
  assert.equal(scrub("card 4242-4242-4242-4242 declined"), "card [number] declined");
  assert.equal(scrub("phone 0123456789"), "phone [number]");
  assert.equal(scrub("token " + "A".repeat(43) + " expired"), "token [token] expired");
  assert.equal(scrub("session bfUxuND0U1nJUgSmBSLAz_6WZJuN8sWSUTmFcEaVKNc"), "session [token]");
  assert.equal(scrub("task 12 of 40 failed after 3 retries"), "task 12 of 40 failed after 3 retries", "ordinary numbers survive");
  assert.equal(scrub("x".repeat(500)).length <= 200, true);
  assert.equal(scrub(undefined), "");
  assert.equal(scrub(null), "");
  assert.equal(scrub({ toString: () => "a@b.co" }), "[email]");
  // A secret that straddles the cut is still removed: redaction happens on the full text before it is cut.
  const cut = mk();
  cut.a.noteSensitive(["hunter2hunter2"]);
  // Filler with spaces, so it is not itself scrubbed as a token and the secret really straddles the 200-character cut.
  cut.a.reportError("long", "ab ".repeat(65) + "hunter2hunter2 tail");
  await cut.a.flush();
  // Not even a truncated prefix of the secret may survive the cut.
  assert.doesNotMatch(JSON.stringify(sent(cut.calls)), /hunt/);
  cut.cleanup();
  const big = "a1 ".repeat(40_000);
  const t0 = Date.now();
  scrub(big);
  scrub("9 ".repeat(50_000));
  scrub("A".repeat(100_000));
  assert.ok(Date.now() - t0 < 1000, "no pathological slowdown on hostile input");
});

// ---- Client id ------------------------------------------------------------------------------------

test("client id: random, stable until reset, and never sent below full", async () => {
  const h = mk({ level: "full" });
  const id = h.a.clientId();
  assert.match(id, /^c_[A-Za-z0-9_-]{22}$/);
  assert.equal(h.a.clientId(), id);
  const again = new Analytics({ manifest: { app: "tasks.localhost", analytics: { events: [] } }, processors: ALL, dataDir: h.dir });
  assert.equal(again.clientId(), id, "persists across restarts");
  const fresh = h.a.resetClient();
  assert.notEqual(fresh, id);
  assert.equal(h.a.clientId(), fresh);
  h.a.reportError("x", "y");
  await h.a.flush();
  assert.equal(h.calls[0].body.client, fresh);
  h.a.setLevel("anonymous");
  h.a.reportError("z", "y");
  await h.a.flush();
  assert.equal("client" in h.calls.at(-1).body, false);
  h.cleanup();
});

// ---- Robustness -----------------------------------------------------------------------------------

test("robustness: no input from the component can throw into the host", async () => {
  const h = mk();
  const junk = [undefined, null, 0, "", "x", 1n, Symbol("s"), {}, [], () => {}, { toString() { throw new Error("boom"); } }];
  for (const a of junk) {
    for (const b of junk) {
      assert.doesNotThrow(() => { h.a.emit(a, b); h.a.reportError(a, b); h.a.host(a, b, {}); h.a.noteSensitive([a, b]); }, `${String(typeof a)}/${String(typeof b)}`);
    }
  }
  h.a.host("performance", "host.route", { handler: { toString() { throw new Error("x"); } } });
  await h.a.flush();
  h.cleanup();
});

test("host events: timings are rounded to 10 ms and carry no content", async () => {
  const h = mk();
  h.a.host("performance", "host.route", { handler: "Orders", ms: 47.3 });
  h.a.host("performance", "host.action", { action: "add_task", ms: 3 });
  h.a.host("error", "host.crash", { detail: "stopped for alice@example.com" });
  h.a.host("product", "nope", {}); // only the host's own kinds
  await h.a.flush();
  const evs = sent(h.calls);
  assert.deepEqual(evs.map((e) => e.name), ["host.route", "host.action", "host.crash"]);
  assert.deepEqual(evs[0].props, { handler: "Orders", ms: 50 });
  assert.deepEqual(evs[1].props, { action: "add_task", ms: 0 });
  assert.equal(evs[2].props.detail, "stopped for [email]");
  h.cleanup();
});

test("snapshot: what the user sees", async () => {
  const h = mk({ level: "anonymous", processors: [{ name: "First party", endpoint: "https://tasks.localhost/events", purposes: ["product", "errors"] }] });
  for (let i = 0; i < 12; i++) h.a.emit("task_added", { tasks: i });
  h.a.emit("nope", {});
  await h.a.flush();
  const s = h.a.snapshot();
  assert.equal(s.level, "anonymous");
  assert.deepEqual(s.levels, LEVELS);
  assert.deepEqual(s.processors, [{ name: "First party", host: "tasks.localhost", purposes: ["product", "errors"] }]);
  assert.equal(s.stats.sent, 12);
  assert.equal(s.stats.dropped, 1);
  assert.equal(s.recent.length, 10, "the last ten");
  assert.deepEqual(s.recent.at(-1).props, { tasks: 11 });
  assert.deepEqual(s.recent.at(-1).to, ["First party"]);
  assert.equal(s.client, false);
  assert.ok(!("endpoint" in s.processors[0]), "the snapshot does not expose raw endpoints");
  h.cleanup();
});

// ---- The collector (receiving side) ----------------------------------------------------------------

test("collector: accepts well-formed batches and refuses anything else", async () => {
  const good = { v: 1, app: { domain: "tasks.localhost" }, level: "anonymous", sent_at: 1, events: [{ kind: "product", name: "task_added", t: 1, props: { tasks: 2, ok: true, s: "x" } }] };
  assert.equal(checkBatch(good), null);
  const variants = {
    "wrong version": { ...good, v: 2 },
    "no app": { ...good, app: undefined },
    "level off": { ...good, level: "off" },
    "client below full": { ...good, client: "c_" + "A".repeat(22) },
    "client with a bad shape": { ...good, level: "full", client: "someone" },
    "no events": { ...good, events: [] },
    "too many events": { ...good, events: Array.from({ length: 51 }, () => good.events[0]) },
    "bad kind": { ...good, events: [{ ...good.events[0], kind: "pageview" }] },
    "bad name": { ...good, events: [{ ...good.events[0], name: "Has Space" }] },
    "bad timestamp": { ...good, events: [{ ...good.events[0], t: "now" }] },
    "nested prop": { ...good, events: [{ ...good.events[0], props: { a: { b: 1 } } }] },
    "long string prop": { ...good, events: [{ ...good.events[0], props: { a: "x".repeat(201) } }] },
    "bad prop name": { ...good, events: [{ ...good.events[0], props: { "Bad-Name": 1 } }] },
    "array": [good],
  };
  for (const [why, b] of Object.entries(variants)) assert.notEqual(checkBatch(b), null, why);
  assert.equal(checkBatch({ ...good, level: "full", client: "c_" + "A".repeat(22) }), null);

  const c = createCollector({ log: quiet });
  const http = await import("node:http");
  const server = http.createServer((req, res) => c.handler(req, res));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const post = (body, type = "application/vnd.lattice.events+json") => fetch(url, { method: "POST", headers: { "Content-Type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
  try {
    assert.equal((await post(good)).status, 204);
    assert.equal(c.events.length, 1);
    assert.equal(c.events[0].app, "tasks.localhost");
    assert.equal((await post(good, "application/json")).status, 415);
    assert.equal((await post("{nope")).status, 400);
    assert.equal((await post(variants["bad kind"])).status, 400);
    assert.equal((await post("x".repeat(70_000))).status, 413);
    assert.equal((await fetch(url)).status, 405);
    assert.equal(c.events.length, 1, "refused batches stored nothing");
  } finally { server.close(); server.closeAllConnections?.(); }
});

// ---- Session: the events the host itself generates ---------------------------------------------------

function fakeSession({ analytics, calls }) {
  const scene = { title: "t", lang: undefined, live: undefined, root: 1, nodes: [{ id: 1, common: { hidden: false }, body: { tag: "text", val: { text: "hi", style: "body", emphasis: "none", maxLines: undefined, selectable: true } }, children: [] }] };
  const host = {
    restarts: 0,
    async call(op) { return calls(op, scene, host); },
    async restart() { host.restarts++; },
  };
  const manifest = { app: "tasks.localhost", routes: { "/": "Home" }, capabilities: { requires: [] } };
  return { session: new Session(host, manifest, "tasks.localhost", quiet, analytics), host };
}
const spy = () => { const events = []; return { events, host: (...a) => events.push(a), noteSensitive: (v) => events.push(["sensitive", [...v]]) }; };

test("session: routes and actions are timed, and failures are reported with the right name", async () => {
  const a = spy();
  const { session } = fakeSession({ analytics: a, calls: async (op, scene) => (op === "route" ? scene : undefined) });
  await session.route("/");
  const t = a.events.find((e) => e[1] === "host.route");
  assert.deepEqual([t[0], t[1], t[2].handler], ["performance", "host.route", "Home"]);
  assert.equal(typeof t[2].ms, "number");

  // The app returns an internal error: reported, and the user gets a generic message.
  const internal = spy();
  const s2 = fakeSession({ analytics: internal, calls: async () => { throw new ComponentError({ tag: "internal", val: "db failed for alice@example.com" }); } });
  await assert.rejects(s2.session.route("/"), (e) => e instanceof HttpError && e.status === 500 && !/alice/.test(e.message));
  assert.deepEqual(internal.events.find((e) => e[1] === "app.internal")?.slice(0, 2), ["error", "app.internal"]);

  // The app returns a scene the host refuses.
  const bad = spy();
  const s3 = fakeSession({ analytics: bad, calls: async (op, scene) => ({ ...scene, root: 99 }) });
  await assert.rejects(s3.session.route("/"), HttpError);
  assert.ok(bad.events.some((e) => e[1] === "host.invalid_scene"));

  // The component stops responding: reported, restarted, and the page comes back.
  const crash = spy();
  let first = true;
  const s4 = fakeSession({ analytics: crash, calls: async (op, scene) => { if (op === "route" && first) { first = false; throw new HostCrash("did not respond within 400 ms and was stopped"); } return op === "route" ? scene : undefined; } });
  await assert.rejects(s4.session.route("/"), (e) => e instanceof HttpError && e.status === 504);
  assert.ok(crash.events.some((e) => e[1] === "host.crash"));
  assert.equal(s4.host.restarts, 1);
});

test("session: what the user types into a sensitive field is scrubbed from what the app later reports", async () => {
  const real = mk({ level: "full" });
  const formScene = {
    title: "t", root: 1, live: undefined, lang: undefined,
    nodes: [
      { id: 1, common: { hidden: false }, body: { tag: "form", val: { label: "Sign in", onSubmit: { action: "login", args: [] } } }, children: [2, 3] },
      { id: 2, common: { hidden: false }, body: { tag: "input", val: { name: "secret", kind: "password", label: "Password", required: true, sensitive: true } }, children: [] },
      { id: 3, common: { hidden: false }, body: { tag: "input", val: { name: "nickname", kind: "text", label: "Nickname", required: false, sensitive: false } }, children: [] },
    ],
  };
  const { session } = fakeSession({
    analytics: real.a,
    calls: async (op, _scene, host) => {
      if (op === "route") return formScene;
      if (op === "dispatch") { real.a.reportError("login_failed", "wrong password hunter2hunter2 for nick-the-nickname"); return { ops: [], focus: undefined }; }
    },
  });
  await session.route("/");
  await session.act(1, "submit", { secret: "hunter2hunter2", nickname: "nick-the-nickname" });
  await real.a.flush();
  const reported = sent(real.calls).find((e) => e.name === "app.reported");
  assert.doesNotMatch(JSON.stringify(reported), /hunter2hunter2/, "the sensitive value is gone");
  assert.match(reported.props.detail, /nick-the-nickname/, "a non-sensitive field is not touched");
  real.cleanup();
});

// ---- The whole path -----------------------------------------------------------------------------

const events = (h) => h.collector.events;
const names = (h) => events(h).map((e) => e.name);
async function addTask(h, title) {
  const r = await h.press("Add", { title });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test("end to end: nothing product-level leaves at the default level; anonymous sends events with no identifier", async () => {
  await stack(async (h) => {
    // Default: errors only. Using the app generates product and timing events that are held back.
    assert.equal(h.nav.analytics.level, "errors");
    await addTask(h, "one");
    await h.nav.analytics.flush();
    assert.deepEqual(names(h), [], "nothing is sent at the default level");
    assert.ok(h.nav.analytics.snapshot().stats.held >= 1);

    // The user raises the level in the host's chrome.
    assert.equal((await h.call("/_navigator/settings", { analytics: "anonymous" })).status, 200);
    await addTask(h, "two");
    await h.nav.analytics.flush();
    assert.ok(names(h).includes("task_added"));
    assert.ok(names(h).includes("host.action"), "the host's own timings");
    const added = events(h).find((e) => e.name === "task_added");
    assert.deepEqual(added.props, { tasks: 2 });
    assert.equal(added.kind, "product");
    assert.equal(added.level, "anonymous");
    assert.equal(added.client, null, "no identifier below full");
    assert.equal(added.app, "tasks.localhost");

    // Nothing that identifies the user or the session, and nothing about what they typed.
    const raw = JSON.stringify(h.collector.batches) + JSON.stringify(events(h));
    assert.doesNotMatch(raw, /one|two/, "task titles are never sent");
    assert.doesNotMatch(raw, /session|subject|token/i);
    const token = h.nav.sessionStore.token();
    assert.equal(raw.includes(token), false);
  });
});

test("end to end: full adds a resettable id; off stops everything, including error reports", async () => {
  await stack(async (h) => {
    await h.call("/_navigator/settings", { analytics: "full" });
    await addTask(h, "x");
    await h.nav.analytics.flush();
    const id = h.nav.analytics.clientId();
    assert.ok(events(h).length > 0);
    assert.ok(events(h).every((e) => e.client === id && e.level === "full"));
    assert.equal(new Set(events(h).map((e) => e.client)).size, 1);

    assert.equal((await h.call("/_navigator/analytics/reset", {})).status, 200);
    assert.notEqual(h.nav.analytics.clientId(), id);

    const before = events(h).length;
    await h.call("/_navigator/settings", { analytics: "off" });
    await addTask(h, "y");
    h.nav.analytics.reportError("will_not_be_sent", "even errors are off");
    await h.nav.analytics.flush();
    assert.equal(events(h).length, before, "nothing at all once off");
  });
});

test("end to end: the user's view of analytics, and the endpoints that change it", async () => {
  await stack(async (h) => {
    const privacy = async () => (await h.state()).chrome.privacy;
    let p = await privacy();
    assert.equal(p.level, "errors");
    assert.deepEqual(p.levels, ["off", "errors", "anonymous", "full"]);
    assert.deepEqual(p.processors, [{ name: "Lattice Tasks (first party)", host: new URL(h.nav.analytics.processors[0].endpoint).host, // where it really goes, in development the address it was fetched from
     purposes: ["product", "performance", "errors"] }]);

    await h.call("/_navigator/settings", { analytics: "anonymous" });
    await addTask(h, "a");
    await h.nav.analytics.flush();
    p = await privacy();
    assert.equal(p.level, "anonymous");
    assert.ok(p.stats.sent >= 1);
    assert.ok(p.recent.some((e) => e.name === "task_added" && e.props.tasks === 1));
    assert.ok(p.recent.every((e) => e.to.length >= 1));

    // The settings endpoint is host-only: it needs the host header, and it refuses unknown levels.
    assert.equal((await h.call("/_navigator/settings", { analytics: "everything" })).status, 400);
    assert.equal((await h.call("/_navigator/settings", { analytics: undefined })).status, 400);
    assert.equal((await h.call("/_navigator/settings", {})).status, 400);
    const noHeader = await fetch(`http://127.0.0.1:${h.nav.port}/_navigator/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analytics: "full" }) });
    assert.equal(noHeader.status, 403);
    const crossSite = await fetch(`http://127.0.0.1:${h.nav.port}/_navigator/settings`, { method: "POST", headers: { "Content-Type": "application/json", "X-Navigator": "1", Origin: "https://evil.example" }, body: JSON.stringify({ analytics: "full" }) });
    assert.equal(crossSite.status, 403);
    assert.equal((await privacy()).level, "anonymous", "none of the refused requests changed anything");
  });
});

test("end to end: the app cannot reach the level or the destination, and a flood from it is contained", async () => {
  await stack(async (h) => {
    await h.call("/_navigator/settings", { analytics: "anonymous" });
    // Many actions in a row: product events are capped per minute whatever the app does.
    for (let i = 0; i < 35; i++) {
      await addTask(h, `t${i}`);
      assert.equal((await h.press("Delete")).status, 200);
    }
    await h.nav.analytics.flush();
    assert.ok(events(h).filter((e) => e.kind === "product").length <= 60);
    assert.ok(h.nav.analytics.snapshot().stats.dropped > 0, "the excess was dropped, not queued");
    // Nothing the app did changed the user's level.
    assert.equal(h.nav.analytics.level, "anonymous");
  });
});

test("end to end: the first-party collector shows the summary the demo exposes", async () => {
  await stack(async (h) => {
    await h.call("/_navigator/settings", { analytics: "anonymous" });
    await addTask(h, "q");
    await h.nav.analytics.flush();
    const s = await (await fetch(`http://127.0.0.1:${h.originPort}/events/summary`)).json();
    assert.ok(s.total >= 2);
    assert.equal(s.by_name.task_added, 1);
    assert.equal(s.by_level.anonymous, s.total);
    assert.equal(s.clients, 0);
  });
});

test("end to end: an app without the analytics capability cannot link, and one with no processors sends nothing", async () => {
  await assert.rejects(stack(async () => {}, { requires: ["net.origin", "session", "auth.oidc", "auth.passkey", "payments.request"] }), /could not be linked/);
});

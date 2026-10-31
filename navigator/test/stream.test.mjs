// Server push (spec/rpc.md, "Topics"): the host's StreamClient against hostile and flaky servers, the server's topic
// endpoint, and the whole path with two real Navigators sharing the World example. Requires the world component built.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer } from "../../server/server.mjs";
import { startNavigator } from "../navigator.mjs";
import { StreamClient, MAX_SUBSCRIPTIONS, MAX_LINE } from "../stream.mjs";
import { decode } from "../../shared/cbor.mjs";
import { SHARED_CACHE, listen, close, sleep, quiet, find, all } from "./stack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const worldDir = resolve(here, "..", "..", "examples", "world");
const description = {
  topics: {
    world: { message: { type: "object", required: ["n"], additionalProperties: false, properties: { n: { type: "integer" } } } },
    other: { message: { type: "object" } },
  },
};
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  return false;
};

/** A fake fetch whose body is whatever chunks the test supplies; `script(n)` answers the n-th connection. */
function fakeFetch(script) {
  let n = 0;
  const f = async (url, { signal }) => {
    const step = script(n++, url);
    if (step.status && step.status !== 200) return { status: step.status, headers: new Headers(), body: (async function* () {})() };
    return {
      status: 200,
      headers: new Headers({ "content-type": step.type ?? "application/x-ndjson" }),
      body: (async function* () {
        for (const c of step.chunks ?? []) {
          yield new TextEncoder().encode(c);
          await sleep(1);
        }
        if (step.hang) await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
      })(),
    };
  };
  f.calls = () => n;
  return f;
}
const client = (fetchImpl, extra = {}) => {
  const got = [];
  const problems = [];
  const c = new StreamClient({
    endpoint: "http://x/rpc",
    description,
    apiHash: "h",
    session: { token: () => "tok" },
    onMessage: (t, b) => got.push([t, b]),
    onProblem: (t, w) => problems.push(w),
    backoffMs: [5, 20],
    fetchImpl,
    ...extra,
  });
  return { c, got, problems };
};

// ---- The host's client ----------------------------------------------------------------------------

test("stream: only messages that match the schema reach the app, in order, however the bytes are split", async () => {
  const f = fakeFetch(() => ({
    chunks: ['{"seq":1,"payload":{"n":1}}\n{"se', 'q":2,"payload":{"n":"x"}}\n\n{"seq":3,"payl', 'oad":{"n":3}}\nnot json\n{"seq":4,"payload":{"n":4,"extra":1}}\n{"seq":5,"payload":{"n":5}}\n'],
    hang: true,
  }));
  const { c, got, problems } = client(f);
  assert.equal(c.subscribe("world").ok, true);
  await until(() => got.length >= 3);
  c.close();
  assert.equal(got.length, 3);
  assert.ok(got.every(([t]) => t === "world"));
  assert.equal(c.dropped, 3);
  assert.equal(problems.length, 3);
});

test("stream: unknown topics, too many subscriptions, and use after close are refused", () => {
  const one = client(fakeFetch(() => ({ hang: true })));
  assert.deepEqual(one.c.subscribe("nope"), { ok: false, error: { tag: "invalid-argument", val: 'unknown topic "nope"' } });
  one.c.close();

  const many = { topics: Object.fromEntries(Array.from({ length: MAX_SUBSCRIPTIONS + 1 }, (_, i) => [`t${i}`, { message: { type: "object" } }])) };
  const m = client(fakeFetch(() => ({ hang: true })), { description: many });
  for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) assert.equal(m.c.subscribe(`t${i}`).ok, true);
  assert.deepEqual(m.c.subscribe(`t${MAX_SUBSCRIPTIONS}`), { ok: false, error: { tag: "rate-limited" } });
  m.c.unsubscribe("t0");
  assert.equal(m.c.subscribe(`t${MAX_SUBSCRIPTIONS}`).ok, true);
  m.c.close();
  assert.equal(m.c.subscribe("t0").ok, false);
});

test("stream: a dropped connection is retried with back-off and delivery resumes", async () => {
  const f = fakeFetch((n) => (n === 0 ? { chunks: ['{"seq":1,"payload":{"n":1}}\n'] } : n === 1 ? { status: 503 } : { chunks: ['{"seq":1,"payload":{"n":2}}\n'], hang: true }));
  const { c, got } = client(f);
  c.subscribe("world");
  assert.ok(await until(() => got.length === 2), "got the message from before and after the outage");
  assert.equal(f.calls(), 3);
  c.close();
});

test("stream: a refusal (4xx) or a wrong content type ends the subscription instead of hammering the server", async () => {
  for (const step of [{ status: 403 }, { status: 404 }, { type: "text/html", chunks: ["<p>hi"] }]) {
    const f = fakeFetch(() => step);
    const { c, problems } = client(f);
    c.subscribe("world");
    await until(() => problems.length);
    await sleep(80);
    assert.equal(f.calls(), 1, JSON.stringify(step));
    c.close();
  }
  // 429 is the exception: the server asked us to come back.
  const f = fakeFetch((n) => (n === 0 ? { status: 429 } : { hang: true }));
  const { c } = client(f);
  c.subscribe("world");
  assert.ok(await until(() => f.calls() === 2));
  c.close();
});

test("stream: an endless line is cut off rather than buffered forever", async () => {
  const f = fakeFetch((n) => (n === 0 ? { chunks: ["x".repeat(MAX_LINE + 10)] } : { hang: true }));
  const { c, problems } = client(f);
  c.subscribe("world");
  assert.ok(await until(() => problems.some((p) => /interrupted/.test(p)) && f.calls() >= 2));
  c.close();
});

test("stream: an oversized line that does end in a newline is dropped, and the stream carries on", async () => {
  // "other" accepts any object, so only the size limit can reject the first line.
  const big = `{"seq":1,"payload":{"pad":"${"x".repeat(MAX_LINE)}"}}\n`;
  const f = fakeFetch(() => ({ chunks: [big + '{"seq":2,"payload":{"n":2}}\n'], hang: true }));
  const { c, got } = client(f);
  c.subscribe("other");
  assert.ok(await until(() => got.length === 1));
  assert.equal(c.dropped, 1);
  c.close();
});

test("stream: the session token is sent on every connection and unsubscribing aborts the request", async () => {
  const seen = [];
  const f = async (url, { headers, signal }) => {
    seen.push({ url, headers });
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/x-ndjson" }),
      body: (async function* () {
        await new Promise((_, r) => signal.addEventListener("abort", () => r(new Error("aborted"))));
      })(),
    };
  };
  const { c } = client(f);
  c.subscribe("world");
  await until(() => seen.length);
  assert.equal(seen[0].url, "http://x/rpc/_topics/world");
  assert.equal(seen[0].headers["Lattice-Session"], "tok");
  assert.equal(seen[0].headers["Lattice-Api"], "h");
  c.unsubscribe("world");
  await sleep(100);
  assert.equal(seen.length, 1, "no reconnect after unsubscribe");
});

// ---- The server -------------------------------------------------------------------------------------

async function world() {
  const app = await loadApp({ appDir: worldDir, dev: true, log: quiet });
  const server = createServer(app);
  const port = await listen(server);
  return {
    app,
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      app.topics.close();
      await close(server);
    },
  };
}
const SESSION = "s".repeat(40);
const open = (w, path, headers = {}) => fetch(`${w.base}/rpc/_topics/${path}`, { headers: { "Lattice-Api": w.app.manifest.api.schema, ...headers } });

test("server: the topic endpoint checks the method, the API hash, the topic and the session", async () => {
  const w = await world();
  try {
    assert.equal((await open(w, "world")).status, 401, "no session");
    assert.equal((await open(w, "nope", { "Lattice-Session": SESSION })).status, 404, "undeclared topic");
    assert.equal((await fetch(`${w.base}/rpc/_topics/world`, { headers: { "Lattice-Api": "sha256-wrong", "Lattice-Session": SESSION } })).status, 412, "wrong description");
    assert.equal((await fetch(`${w.base}/rpc/_topics/world`, { method: "POST", headers: { "Lattice-Api": w.app.manifest.api.schema, "Lattice-Session": SESSION } })).status, 405);
    const ok = await open(w, "world", { "Lattice-Session": SESSION });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/x-ndjson");
    assert.match(ok.headers.get("cache-control"), /no-store/);
    const reader = ok.body.getReader();
    let text = "";
    while (!text.includes('"seq"')) text += new TextDecoder().decode((await reader.read()).value);
    assert.deepEqual(JSON.parse(text.trim()), { seq: 1, payload: { players: [] } }, "the first frame is the current picture");
    await reader.cancel();
  } finally {
    await w.close();
  }
});

test("server: a message that breaks the topic's schema is refused at the source", async () => {
  const w = await world();
  try {
    assert.throws(() => w.app.topics.publish("world", { players: [{ id: 1 }] }), /violates the API description/);
    assert.throws(() => w.app.topics.publish("nope", {}), /no such topic/);
    assert.equal(w.app.topics.subscribers("world"), 0);
  } finally {
    await w.close();
  }
});

// ---- Two people, one world ---------------------------------------------------------------------------

async function player(w) {
  const dir = mkdtempSync(join(tmpdir(), "nav-world-"));
  const nav = await startNavigator({ cacheDir: SHARED_CACHE, url: `${w.base}/`, dev: true, port: 0, dataDir: dir, log: quiet, streamBackoffMs: [20, 100] });
  const state = () => fetch(`http://127.0.0.1:${nav.port}/_navigator/state`).then((r) => r.json());
  const status = async () => find((await state()).tree, (n) => /online/.test(n.props?.text ?? ""))?.props.text;
  // Where everyone is drawn: the filled circles of the canvas (not the fireflies)'s drawing, as "x,y" cells of 40 units.
  const canvas = async () => find((await state()).tree, (n) => n.type === "canvas");
  const cells = async () => (await canvas()).props.drawing.ops.filter((o) => o.tag === "ellipse" && !o.val.outline && o.val.tone !== "caution").map((o) => `${Math.floor(o.val.cx / 40)},${Math.floor(o.val.cy / 40)}`).sort();
  const at = async () => (await status())?.match(/column (\d+), row (\d+)/)?.slice(1).join(",");
  const move = async (label) => {
    const b = find((await state()).tree, (n) => n.type === "button" && n.props.label === label);
    const r = await fetch(`http://127.0.0.1:${nav.port}/_navigator/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Navigator": "1", Host: `world.localhost:${nav.port}` },
      body: JSON.stringify({ source: b.id, event: "press", values: {} }),
    });
    return r.status;
  };
  return {
    nav, state, status, cells, at, canvas, move,
    stop: async () => {
      await nav.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("world: two Navigators see each other arrive and move, without polling", async () => {
  const w = await world();
  const a = await player(w);
  let b;
  try {
    assert.ok(await until(async () => /^1 online\./.test((await a.status()) ?? "")), "alone at first");
    b = await player(w);
    assert.ok(await until(async () => /^2 online\./.test((await a.status()) ?? "")), "a sees b arrive");
    assert.ok(await until(async () => /^2 online\./.test((await b.status()) ?? "")), "b sees both");

    const before = await b.at();
    let moved = false;
    for (const dir of ["Move right", "Move left", "Move down", "Move up"]) {
      assert.equal(await b.move(dir), 200);
      if (await until(async () => (await b.at()) !== before, 600)) {
        moved = true;
        break;
      }
    }
    assert.ok(moved, "b sees its own move, delivered by the server over the topic");
    const [bx, by] = (await b.at()).split(",").map(Number);
    assert.ok(await until(async () => (await a.cells()).includes(`${bx - 1},${by - 1}`)), "a sees b drawn at the new square");
    assert.equal((await a.cells()).length, 2);
  } finally {
    await b?.stop();
    await a.stop();
    await w.close();
  }
});

test("world: after the server cuts every stream the Navigators reconnect and recover the picture", async () => {
  const w = await world();
  const a = await player(w);
  let b;
  try {
    assert.ok(await until(async () => /^1 online\./.test((await a.status()) ?? "")));
    w.app.topics.close(); // the server cuts every stream
    b = await player(w); // joining publishes a new picture, which a only gets if it reconnected
    assert.ok(await until(async () => /^2 online\./.test((await a.status()) ?? ""), 8000), "a reconnected and learned about b");
  } finally {
    await b?.stop();
    await a.stop();
    await w.close();
  }
});

// ---- Datagram topics ---------------------------------------------------------------------------------------------

/**
 * A WebTransport stand-in the test drives by hand: one stream per subscription (the test writes its lines), and a
 * datagram readable the test pushes bytes into.
 */
function fakeWebTransport() {
  const fake = { streams: [], sent: [] };
  let datagrams;
  fake.ctor = class {
    ready = Promise.resolve();
    closed = new Promise(() => {});
    datagrams = { readable: new ReadableStream({ start: (c) => (datagrams = c) }) };
    close() {}
    async createBidirectionalStream() {
      let ctl;
      const readable = new ReadableStream({ start: (c) => (ctl = c) });
      const writable = new WritableStream({ write: (chunk) => void fake.sent.push(new TextDecoder().decode(chunk)) });
      fake.streams.push({ line: (s) => ctl.enqueue(new TextEncoder().encode(`${s}\n`)) });
      return { readable, writable };
    }
  };
  fake.datagram = (value) => datagrams.enqueue(typeof value === "string" ? new TextEncoder().encode(value) : value);
  return fake;
}

const dgDescription = {
  topics: {
    flies: { delivery: "datagram", message: { type: "object", required: ["n"], additionalProperties: false, properties: { n: { type: "integer" } } } },
    world: description.topics.world,
  },
};
const dgClient = (wt) => {
  const got = [];
  const problems = [];
  const c = new StreamClient({
    endpoint: "http://x/rpc", description: dgDescription, apiHash: "h", session: null,
    onMessage: (topic, bytes) => got.push([topic, decode(bytes)]), onProblem: (t, why) => problems.push(why),
    backoffMs: [10, 20], webTransport: { ctor: wt.ctor, url: "https://x/stream", certHash: null },
  });
  return { c, got, problems };
};
const dg = (topic, seq, payload) => JSON.stringify({ topic, seq, payload });

test("datagram topics: the newest message wins; a late or repeated one is ignored, and so is anything that is not for this subscription", async () => {
  const wt = fakeWebTransport();
  const { c, got, problems } = dgClient(wt);
  try {
    c.subscribe("flies");
    assert.ok(await until(() => wt.streams.length === 1), "the subscription's stream opened");
    wt.streams[0].line('{"seq":1,"payload":{"n":1}}'); // the snapshot, on the stream
    assert.ok(await until(() => got.length === 1));

    wt.datagram(dg("flies", 3, { n: 3 }));
    wt.datagram(dg("flies", 2, { n: 2 })); // outrun by 3
    wt.datagram(dg("flies", 3, { n: 3 })); // repeated
    assert.ok(await until(() => got.length === 2));
    await sleep(60);
    assert.deepEqual(got.map(([, m]) => m.n), [1, 3]);
    assert.equal(c.datagrams.stale, 2);

    // A stream frame that a datagram already outran is old news as well; a newer one is delivered.
    wt.streams[0].line('{"seq":2,"payload":{"n":2}}');
    wt.streams[0].line('{"seq":4,"payload":{"n":4}}');
    assert.ok(await until(() => got.length === 3));
    assert.deepEqual(got.map(([, m]) => m.n), [1, 3, 4]);

    // Things that are not delivered: another topic, a topic that is not a datagram topic, one the app has not subscribed to,
    // a message that breaks the description, nonsense, and anything too big to be a datagram.
    const refusedBefore = c.datagrams.refused;
    wt.datagram(dg("world", 9, { n: 9 }));
    wt.datagram(dg("other", 9, { n: 9 }));
    wt.datagram(dg("flies", 10, { n: "ten" }));
    wt.datagram(dg("flies", 0, { n: 1 }));
    wt.datagram(dg("flies", 1.5, { n: 1 }));
    wt.datagram('{"topic":"flies","seq":11}');
    wt.datagram("not json");
    wt.datagram(new Uint8Array([0xff, 0xfe]));
    wt.datagram(dg("flies", 12, { n: 1, pad: "x".repeat(2000) }));
    await sleep(80);
    assert.equal(c.datagrams.refused - refusedBefore, 9);
    assert.deepEqual(got.map(([, m]) => m.n), [1, 3, 4], "none of it reached the app");
    assert.ok(problems.some((p) => /violates the API description/.test(p)));
  } finally { c.close(); }
});

test("datagram topics: after a reconnect the numbering starts again, and datagrams stop with the subscription", async () => {
  const wt = fakeWebTransport();
  const { c, got } = dgClient(wt);
  try {
    c.subscribe("flies");
    assert.ok(await until(() => wt.streams.length === 1));
    wt.streams[0].line('{"seq":1,"payload":{"n":1}}');
    wt.datagram(dg("flies", 50, { n: 50 }));
    assert.ok(await until(() => got.length === 2));

    c.unsubscribe("flies"); // the app lets go
    wt.datagram(dg("flies", 51, { n: 51 }));
    c.subscribe("flies"); // and asks again: a new stream, numbered from 1
    assert.ok(await until(() => wt.streams.length === 2));
    wt.streams[1].line('{"seq":1,"payload":{"n":100}}');
    assert.ok(await until(() => got.length === 3));
    assert.deepEqual(got.map(([, m]) => m.n), [1, 50, 100], "what arrived while unsubscribed was not delivered, and seq 1 is new again");
  } finally { c.close(); }
});

test("server: a datagram topic sends updates as datagrams when the subscriber has them and they fit; the snapshot, the big and the rest go on the stream", async () => {
  const { createTopics } = await import("../../server/topics.mjs");
  const apiDescription = {
    topics: {
      flies: { delivery: "datagram", message: { type: "object", required: ["n"], additionalProperties: false, properties: { n: { type: "integer" }, pad: { type: "string", maxLength: 5000 } } } },
      calm: { message: { type: "object", required: ["n"], additionalProperties: false, properties: { n: { type: "integer" } } } },
    },
  };
  const hub = createTopics({ apiDescription, apiHash: "h", authorize: () => ({ snapshot: { n: 0 } }), heartbeatMs: 1e6 });
  const sink = (withDatagrams, max = 1000) => {
    const s = { lines: [], datagrams: [], closers: [], write: (x) => s.lines.push(x), queued: () => 0, destroy: () => s.closers.forEach((f) => f()), onClose: (f) => s.closers.push(f) };
    if (withDatagrams) s.datagram = (b) => (b.length > max ? false : (s.datagrams.push(JSON.parse(new TextDecoder().decode(b))), true));
    return s;
  };
  const withDg = sink(true), without = sink(false), calm = sink(true);
  await hub.open("flies", { api: "h" }, withDg);
  await hub.open("flies", { api: "h" }, without);
  await hub.open("calm", { api: "h" }, calm);
  hub.publish("flies", { n: 1 });
  hub.publish("flies", { n: 2, pad: "x".repeat(3000) }); // does not fit in a datagram
  hub.publish("calm", { n: 1 });

  assert.deepEqual(withDg.lines.map((l) => JSON.parse(l)), [{ seq: 1, payload: { n: 0 } }, { seq: 3, payload: { n: 2, pad: "x".repeat(3000) } }], "the snapshot and the big message are on the stream");
  assert.deepEqual(withDg.datagrams, [{ topic: "flies", seq: 2, payload: { n: 1 } }], "the small update is a datagram, numbered in the same sequence");
  assert.deepEqual(without.lines.map((l) => JSON.parse(l).seq), [1, 2, 3], "a subscriber with no datagrams gets everything on its stream");
  assert.deepEqual(calm.datagrams, [], "a reliable topic never uses them");
  assert.equal(calm.lines.length, 2);
  hub.close();
});

test("datagram topics: whatever bytes arrive, the host never throws and only delivers valid messages in increasing order", async () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const wt = fakeWebTransport();
  const { c, got } = dgClient(wt);
  try {
    c.subscribe("flies");
    assert.ok(await until(() => wt.streams.length === 1));
    const values = [null, true, false, 0, -1, 1, 2 ** 53, 1.5, NaN, "", "flies", "world", "x".repeat(300), [], {}, [1, 2], { n: 1 }, { n: "1" }, { n: 2 ** 40 }, { n: 1, extra: 1 }, "__proto__", { __proto__: { n: 1 } }];
    const valid = () => ({ topic: "flies", seq: 1 + Math.floor(rnd() * 400), payload: { n: Math.floor(rnd() * 1000) } });
    const sent = [];
    for (let i = 0; i < 600; i++) {
      const f = valid();
      const mode = Math.floor(rnd() * 5);
      let bytes;
      if (mode === 0) bytes = new TextEncoder().encode(JSON.stringify(f));
      else if (mode === 1) bytes = new TextEncoder().encode(JSON.stringify({ ...f, [pick(["topic", "seq", "payload"])]: pick(values) }));
      else if (mode === 2) { bytes = new TextEncoder().encode(JSON.stringify(f)); bytes = bytes.slice(0, Math.floor(rnd() * bytes.length)); }
      else if (mode === 3) { bytes = new TextEncoder().encode(JSON.stringify(f)); bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256); }
      else bytes = Uint8Array.from({ length: Math.floor(rnd() * 60) }, () => Math.floor(rnd() * 256));
      sent.push(bytes);
      wt.datagram(bytes);
    }
    const total = () => c.datagrams.delivered + c.datagrams.stale + c.datagrams.refused;
    assert.ok(await until(() => total() >= 590, 8000) || total() > 0, "all of them were looked at");
    await sleep(100);
    const seqs = got.map(([, m]) => m);
    for (const m of seqs) assert.ok(Number.isSafeInteger(m.n) && Object.keys(m).length === 1, "valid against the schema");
    assert.equal(c.datagrams.delivered, got.length);
    assert.ok(got.length > 0 && got.length < 600);
  } finally { c.close(); }
});

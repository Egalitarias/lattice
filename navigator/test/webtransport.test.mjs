// Topics over WebTransport (HTTP/3 over QUIC): the server's stream protocol, how the host decides whether to trust the
// endpoint, and two real Navigators sharing the World example over it. Requires the world component built and the
// optional WebTransport packages installed (the tests skip themselves otherwise).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer, attachWebTransport } from "../../server/server.mjs";
import { webTransportAvailable } from "../../server/webtransport.mjs";
import { startNavigator } from "../navigator.mjs";
import { fetchApp, LoadError } from "../runtime.mjs";
import { loadNodeWebTransport } from "../wt-node.mjs";
import { b64uDecode } from "../bytes.mjs";
import { SHARED_CACHE, listen, close, sleep, quiet, find } from "./stack.mjs";

const worldDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "world");
const available = (await webTransportAvailable()) && !!(await loadNodeWebTransport());
const wtTest = (name, fn) => test(name, { skip: available ? false : "WebTransport packages are not installed" }, fn);
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  return false;
};
const SESSION = "s".repeat(40);

async function world({ wt = true, tamper } = {}) {
  const app = await loadApp({ appDir: worldDir, dev: true, log: quiet });
  const listener = wt ? await attachWebTransport(app, { dev: true, log: quiet }) : null;
  tamper?.(app);
  const server = createServer(app); // freezes the manifest
  const port = await listen(server);
  return {
    app, listener, port, base: `http://127.0.0.1:${port}`,
    close: async () => {
      app.topics.close();
      listener?.close();
      await close(server);
    },
  };
}

/** A bare protocol client: a session, and a stream per request, returning the lines the server sends. */
async function rawClient(w) {
  const WebTransport = await loadNodeWebTransport();
  const url = new URL(w.listener.url);
  const t = new WebTransport(`https://127.0.0.1:${url.port}${url.pathname}`, { serverCertificateHashes: [{ algorithm: "sha-256", value: b64uDecode(w.listener.certHash.replace(/^sha256-/, "")) }] });
  await t.ready;
  return {
    t,
    async ask(line, { take = 1, wait = 3000 } = {}) {
      const s = await t.createBidirectionalStream();
      const writer = s.writable.getWriter();
      await writer.write(typeof line === "string" ? new TextEncoder().encode(line) : line);
      const reader = s.readable.getReader();
      const lines = [];
      let buf = "";
      const end = Date.now() + wait;
      while (lines.length < take && Date.now() < end) {
        const r = await Promise.race([reader.read(), sleep(Math.max(1, end - Date.now())).then(() => ({ timeout: true }))]);
        if (r.timeout || r.done) break;
        buf += new TextDecoder().decode(r.value);
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (l) lines.push(JSON.parse(l));
        }
      }
      reader.cancel().catch(() => {});
      writer.abort().catch(() => {});
      return lines;
    },
  };
}
const req = (w, extra = {}) => `${JSON.stringify({ topic: "world", api: w.app.manifest.api.schema, session: SESSION, ...extra })}\n`;

wtTest("webtransport: the manifest advertises the endpoint on the app's domain, with a development pin", async () => {
  const w = await world();
  try {
    assert.match(w.app.manifest.api.stream, /^https:\/\/world\.localhost:\d+\/stream$/);
    assert.match(w.app.manifest.api.stream_cert_hash, /^sha256-[A-Za-z0-9_-]{43}$/);
    const loaded = await fetchApp(`${w.base}/`, { dev: true });
    assert.equal(new URL(loaded.api.stream.url).hostname, "127.0.0.1", "reached at the address the manifest was fetched from");
    assert.equal(new URL(loaded.api.stream.url).port, String(w.listener.port));
    assert.equal(loaded.api.stream.certHash, w.app.manifest.api.stream_cert_hash);
  } finally { await w.close(); }
});

wtTest("webtransport: a stream endpoint on another domain is refused", async () => {
  const w = await world();
  try {
    w.app.manifest.api.stream = "https://elsewhere.example:443/stream";
    const bad = createServer(w.app);
    const p = await listen(bad);
    await assert.rejects(fetchApp(`http://127.0.0.1:${p}/`, { dev: true }), (e) => e instanceof LoadError && /api\.stream is on elsewhere\.example/.test(e.message));
    await close(bad);
  } finally { await w.close(); }
});

wtTest("webtransport: the server answers a subscription with the current picture, then updates", async () => {
  const w = await world();
  const c = await rawClient(w);
  try {
    const [first] = await c.ask(req(w));
    assert.deepEqual(first, { seq: 1, payload: { players: [] } });
    // Several subscriptions share one session.
    const [a, b] = await Promise.all([c.ask(req(w)), c.ask(req(w))]);
    assert.equal(a[0].seq, 1);
    assert.equal(b[0].seq, 1);
  } finally { c.t.close(); await w.close(); }
});

wtTest("webtransport: refusals are one error line, never a frame", async () => {
  const w = await world();
  const c = await rawClient(w);
  const err = async (line) => (await c.ask(line))[0]?.error?.code;
  try {
    assert.equal(await err(req(w, { session: undefined })), "unauthorized");
    assert.equal(await err(req(w, { topic: "nope" })), "not_found");
    assert.equal(await err(req(w, { api: "sha256-wrong" })), "api_mismatch");
    assert.equal(await err("not json\n"), "invalid_request");
    assert.equal(await err("[1,2]\n"), "invalid_request");
    assert.equal(await err('{"topic":7}\n'), "invalid_request");
    assert.equal(await err("x".repeat(5000) + "\n"), "invalid_request", "an oversized request line");
    // A request that never ends its line is cut off at the size limit, not buffered until a timeout.
    const t0 = Date.now();
    assert.equal(await err(new TextEncoder().encode("y".repeat(20000))), "invalid_request");
    assert.ok(Date.now() - t0 < 2500, "refused promptly");
    assert.equal(w.app.topics.subscribers("world"), 0, "nothing was left subscribed");
  } finally { c.t.close(); await w.close(); }
});

wtTest("webtransport: a client that goes away is forgotten", async () => {
  const w = await world();
  const c = await rawClient(w);
  try {
    await c.ask(req(w));
    assert.ok(await until(() => w.app.topics.subscribers("world") === 0), "the stream ended with the client's side");
    const s = await c.t.createBidirectionalStream();
    await s.writable.getWriter().write(new TextEncoder().encode(req(w)));
    assert.ok(await until(() => w.app.topics.subscribers("world") === 1));
    c.t.close();
    assert.ok(await until(() => w.app.topics.subscribers("world") === 0), "closing the session removes its subscriptions");
  } finally { await w.close(); }
});

// ---- Two Navigators ----------------------------------------------------------------------------------------

async function player(w, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nav-wt-"));
  const nav = await startNavigator({ cacheDir: SHARED_CACHE, url: `${w.base}/`, dev: true, port: 0, dataDir: dir, log: quiet, streamBackoffMs: [30, 150], ...extra });
  const state = () => fetch(`http://127.0.0.1:${nav.port}/_navigator/state`).then((r) => r.json());
  const status = async () => find((await state()).tree, (n) => /online/.test(n.props?.text ?? ""))?.props.text;
  const move = async (label) => {
    const b = find((await state()).tree, (n) => n.type === "button" && n.props.label === label);
    return fetch(`http://127.0.0.1:${nav.port}/_navigator/act`, { method: "POST", headers: { "Content-Type": "application/json", "X-Navigator": "1", Host: `world.localhost:${nav.port}` }, body: JSON.stringify({ source: b.id, event: "press", values: {} }) }).then((r) => r.status);
  };
  const transport = () => nav.controller.host.stream.transports.get("world");
  return { nav, status, move, transport, stop: async () => { await nav.close(); rmSync(dir, { recursive: true, force: true }); } };
}

wtTest("webtransport: two Navigators share the world over WebTransport", async () => {
  const w = await world();
  const a = await player(w);
  const b = await player(w);
  try {
    assert.ok(await until(async () => /^2 online\./.test((await a.status()) ?? "")), "a sees b arrive");
    assert.equal(a.transport(), "webtransport");
    assert.equal(b.transport(), "webtransport");
    const before = await b.status();
    for (const dir of ["Move right", "Move left", "Move down", "Move up"]) {
      await b.move(dir);
      if (await until(async () => (await b.status()) !== before, 600)) break;
    }
    assert.notEqual(await b.status(), before, "the move came back over the stream");
    assert.equal(w.app.topics.subscribers("world"), 2);
  } finally { await b.stop(); await a.stop(); await w.close(); }
});

wtTest("webtransport: if the endpoint is wrong or unreachable the Navigator falls back to streaming HTTPS and still works", async () => {
  const w = await world();
  w.listener.close(); // the manifest still advertises it
  const a = await player(w);
  const b = await player(w);
  try {
    assert.ok(await until(async () => /^2 online\./.test((await a.status()) ?? ""), 15000), "still live");
    assert.equal(a.transport(), "https");
  } finally { await b.stop(); await a.stop(); await w.close(); }
});

wtTest("webtransport: a certificate that is not the pinned one is not trusted", async () => {
  const wrong = await world(); // a different listener, with a different throwaway certificate
  const w = await world({ tamper: (app) => { app.manifest.api.stream_cert_hash = wrong.app.manifest.api.stream_cert_hash; } });
  const a = await player(w);
  try {
    assert.ok(await until(async () => /^1 online\./.test((await a.status()) ?? ""), 15000), "works, over HTTPS");
    assert.equal(a.transport(), "https", "never over a connection whose certificate does not match the pin");
  } finally { await a.stop(); await wrong.close(); await w.close(); }
});

// Host side of Lattice topics (spec/rpc.md, "Topics"). Runs on the main thread, like RpcClient: it opens the
// streams, validates every message against the API description, and only then hands bytes to the app.
//
// Portable (fetch + Web streams), so the Node and browser Navigators share it.

import { Schema } from "../shared/schema.mjs";
import { encode } from "../shared/cbor.mjs";
import { b64uDecode } from "./bytes.mjs";

export const MAX_SUBSCRIPTIONS = 8;
export const MAX_LINE = 1024 * 1024;
const RETRYABLE = new Set([408, 429]);
// Errors a WebTransport stream reports in its first line; like HTTP statuses, only these mean "try again".
const RETRYABLE_CODES = new Set(["rate_limited", "internal"]);
const WT_RETRY_AFTER_MS = 60_000;
const utf8 = new TextEncoder();

/** A ReadableStream as an async iterable of chunks (not every engine makes streams iterable). */
async function* chunksOf(readable) {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

const hostErr = (tag, val) => ({ ok: false, error: val === undefined ? { tag } : { tag, val } });

export class StreamClient {
  #subs = new Map(); // topic -> { abort }
  #closed = false;
  #wt = null; // promise of the shared WebTransport session
  #wtDownUntil = 0;
  /** Which transport each live subscription is using, for tests and diagnostics. */
  transports = new Map();

  /**
   * @param endpoint    the API root; topics are read from `${endpoint}/_topics/<topic>`
   * @param onMessage   (topic, cborBytes) => void; called in order, only with messages that passed validation
   * @param backoffMs   [first, max] reconnect delays
   * @param webTransport  { ctor, url, certHash }: offer topics over WebTransport first (ctor is the WebTransport class,
   *                    certHash a pinned development certificate or null). Falls back to streaming HTTPS if it cannot connect.
   */
  constructor({ endpoint, description, apiHash, session, onMessage, onProblem = () => {}, backoffMs = [1000, 30_000], fetchImpl = (...a) => fetch(...a), webTransport = null, wtConnectMs = 5000 }) {
    Object.assign(this, { apiHash, session, onMessage, onProblem, backoffMs, fetchImpl, webTransport, wtConnectMs });
    this.endpoint = endpoint.replace(/\/$/, "");
    this.topics = new Map(Object.entries(description.topics ?? {}).map(([name, t]) => [name, new Schema(t.message)]));
    this.dropped = 0;
  }

  /** Result in the shape of a host call: { ok: true, bytes } or { ok: false, error: <host-error> }. */
  subscribe(topic) {
    if (this.#closed) return hostErr("unavailable", "the app is stopping");
    if (!this.topics.has(topic)) return hostErr("invalid-argument", `unknown topic "${topic}"`);
    if (this.#subs.has(topic)) return { ok: true, bytes: new Uint8Array() };
    if (this.#subs.size >= MAX_SUBSCRIPTIONS) return hostErr("rate-limited");
    const sub = { abort: new AbortController() };
    this.#subs.set(topic, sub);
    void this.#run(topic, sub);
    return { ok: true, bytes: new Uint8Array() };
  }

  unsubscribe(topic) {
    this.#subs.get(topic)?.abort.abort();
    this.#subs.delete(topic);
    this.transports.delete(topic);
    if (!this.#subs.size) this.#dropSession();
  }

  #dropSession() {
    const s = this.#wt;
    this.#wt = null;
    s?.then((t) => t.close(), () => {});
  }

  /** The one WebTransport session all topics share, opened on first use. Rejects when it cannot be established. */
  #session() {
    if (!this.#wt) {
      const { ctor, url, certHash } = this.webTransport;
      const options = certHash ? { serverCertificateHashes: [{ algorithm: "sha-256", value: b64uDecode(certHash.replace(/^sha256-/, "")) }] } : {};
      const t = new ctor(url, options);
      // An unreachable QUIC endpoint (blocked UDP, a dead server) never answers, so give up after a few seconds.
      const timeout = new Promise((_, rej) => setTimeout(() => { rej(new Error("timed out connecting")); t.close?.(); }, this.wtConnectMs).unref?.());
      const p = Promise.race([t.ready.then(() => t), timeout]);
      this.#wt = p;
      const gone = () => { if (this.#wt === p) this.#wt = null; };
      t.closed.then(gone, gone);
      p.catch(gone);
    }
    return this.#wt;
  }

  /** Open a subscription stream on the shared session; resolves to an async iterable of chunks. */
  async #openWt(topic, sub) {
    const session = await this.#session();
    const stream = await session.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    sub.abort.signal.addEventListener("abort", () => { writer.abort().catch(() => {}); stream.readable.cancel().catch(() => {}); }, { once: true });
    // The request is one line; the stream's write side stays open, because closing it means "I am done".
    await writer.write(utf8.encode(`${JSON.stringify({ topic, api: this.apiHash, ...(this.session ? { session: this.session.token() } : {}) })}
`));
    return chunksOf(stream.readable);
  }

  /** Drop every subscription (the app stopped); the app may subscribe again if it is restarted. */
  reset() {
    for (const t of [...this.#subs.keys()]) this.unsubscribe(t);
  }

  close() {
    this.#closed = true;
    this.reset();
  }

  async #run(topic, sub) {
    let delay = this.backoffMs[0];
    while (!sub.abort.signal.aborted) {
      let opened = false;
      try {
        if (this.webTransport && Date.now() >= this.#wtDownUntil) {
          let chunks;
          try {
            chunks = await this.#openWt(topic, sub);
          } catch (e) {
            if (sub.abort.signal.aborted) return;
            // QUIC may be blocked or the server may not offer it: use streaming HTTPS for a while.
            this.#wtDownUntil = Date.now() + WT_RETRY_AFTER_MS;
            this.#dropSession();
            this.onProblem(topic, `WebTransport unavailable (${e?.message ?? e}); using streaming HTTPS`);
            continue;
          }
          this.transports.set(topic, "webtransport");
          opened = true;
          if ((await this.#read(topic, chunks, sub, true)) === "refused") {
            this.#subs.delete(topic);
            this.transports.delete(topic);
            return;
          }
          throw new Error("stream ended");
        }
        this.transports.set(topic, "https");
        const headers = { Accept: "application/x-ndjson", "Lattice-Api": this.apiHash };
        if (this.session) headers["Lattice-Session"] = this.session.token();
        const res = await this.fetchImpl(`${this.endpoint}/_topics/${topic}`, { headers, redirect: "error", credentials: "omit", signal: sub.abort.signal });
        if (res.status >= 400 && res.status < 500 && !RETRYABLE.has(res.status)) {
          this.onProblem(topic, `the server refused the subscription (${res.status})`);
          this.#subs.delete(topic);
          return;
        }
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        if ((res.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/x-ndjson") {
          this.onProblem(topic, "the server did not answer with a topic stream");
          this.#subs.delete(topic);
          return;
        }
        opened = true;
        await this.#read(topic, res.body, sub, false);
      } catch (e) {
        if (sub.abort.signal.aborted) return;
        this.onProblem(topic, `stream interrupted: ${e.cause?.code ?? e.message}`);
      }
      if (opened) delay = this.backoffMs[0]; // it worked for a while: start the back-off again
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, this.backoffMs[1]);
    }
  }

  /** Returns "refused" if the server ended the subscription with a final error; otherwise returns when the stream ends. */
  async #read(topic, body, sub, firstLineMayBeError) {
    const schema = this.topics.get(topic);
    const decoder = new TextDecoder();
    let buf = "";
    let first = firstLineMayBeError;
    for await (const chunk of body) {
      if (sub.abort.signal.aborted) return;
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (first) {
          first = false;
          const err = this.#errorLine(line);
          if (err) {
            if (RETRYABLE_CODES.has(err.code)) throw new Error(`the server said ${err.code}`);
            this.onProblem(topic, `the server refused the subscription (${err.code})`);
            return "refused";
          }
        }
        this.#frame(topic, schema, line);
      }
      if (buf.length > MAX_LINE) throw new Error("frame too large");
    }
  }

  /** A refusal on a WebTransport stream is a single {"error":{code,message}} line instead of frames. */
  #errorLine(line) {
    if (!line.startsWith('{"error"')) return null;
    try {
      const e = JSON.parse(line).error;
      return e && typeof e.code === "string" ? { code: e.code } : null;
    } catch {
      return null;
    }
  }

  #frame(topic, schema, line) {
    if (line.length > MAX_LINE) return void this.dropped++;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.dropped++;
      return void this.onProblem(topic, "dropped a frame that is not JSON");
    }
    const problem = frame && typeof frame === "object" && "payload" in frame ? schema.check(frame.payload) : "not a frame";
    if (problem) {
      this.dropped++;
      return void this.onProblem(topic, `dropped a message that violates the API description: ${problem}`);
    }
    this.onMessage(topic, encode(frame.payload));
  }
}

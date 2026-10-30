// Host side of Lattice topics (spec/rpc.md, "Topics"). Runs on the main thread, like RpcClient: it opens the
// streams, validates every message against the API description, and only then hands bytes to the app.
//
// Portable (fetch + Web streams), so the Node and browser Navigators share it.

import { Schema } from "../shared/schema.mjs";
import { encode } from "../shared/cbor.mjs";

export const MAX_SUBSCRIPTIONS = 8;
export const MAX_LINE = 1024 * 1024;
const RETRYABLE = new Set([408, 429]);

const hostErr = (tag, val) => ({ ok: false, error: val === undefined ? { tag } : { tag, val } });

export class StreamClient {
  #subs = new Map(); // topic -> { abort }
  #closed = false;

  /**
   * @param endpoint    the API root; topics are read from `${endpoint}/_topics/<topic>`
   * @param onMessage   (topic, cborBytes) => void; called in order, only with messages that passed validation
   * @param backoffMs   [first, max] reconnect delays
   */
  constructor({ endpoint, description, apiHash, session, onMessage, onProblem = () => {}, backoffMs = [1000, 30_000], fetchImpl = (...a) => fetch(...a) }) {
    Object.assign(this, { apiHash, session, onMessage, onProblem, backoffMs, fetchImpl });
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
        await this.#read(topic, res, sub);
      } catch (e) {
        if (sub.abort.signal.aborted) return;
        this.onProblem(topic, `stream interrupted: ${e.cause?.code ?? e.message}`);
      }
      if (opened) delay = this.backoffMs[0]; // it worked for a while: start the back-off again
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, this.backoffMs[1]);
    }
  }

  async #read(topic, res, sub) {
    const schema = this.topics.get(topic);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      if (sub.abort.signal.aborted) return;
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.#frame(topic, schema, line);
      }
      if (buf.length > MAX_LINE) throw new Error("frame too large");
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

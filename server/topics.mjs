// Server side of Lattice topics (spec/rpc.md, "Topics"): GET {api.url}/_topics/{topic} streams newline-delimited JSON
// frames `{"seq":n,"payload":{...}}`. The server publishes; every message is validated against the description first.

import { Schema } from "../shared/schema.mjs";
import { encode } from "../shared/cbor.mjs";
import { ApiError, RPC_ERROR_TYPE } from "./rpc.mjs";

const MAX_QUEUED = 256 * 1024;

/**
 * @param opts.authorize  (topic, ctx) => void | { snapshot?: message }; throw ApiError to refuse. ctx = { session }.
 * @param opts.maxSubscribers  per topic
 */
export function createTopics({ apiDescription, apiHash, authorize, heartbeatMs = 15_000, maxSubscribers = 1000, log = console.error }) {
  const topics = new Map();
  for (const [name, t] of Object.entries(apiDescription.topics ?? {})) {
    topics.set(name, { message: new Schema(t.message), subs: new Set() });
  }

  const fail = (res, status, code, message) => {
    const body = Buffer.from(encode({ code, message }));
    res.writeHead(status, { "Content-Type": RPC_ERROR_TYPE, "Content-Length": body.length });
    res.end(body);
  };

  function check(topic, message) {
    const t = topics.get(topic);
    if (!t) throw new Error(`no such topic: ${topic}`);
    const problem = t.message.check(message);
    if (problem) throw new Error(`message on topic ${topic} violates the API description: ${problem}`);
    return t;
  }

  function send(t, sub, message) {
    if (sub.res.writableLength > MAX_QUEUED) {
      t.subs.delete(sub);
      sub.res.destroy();
      return;
    }
    sub.res.write(`${JSON.stringify({ seq: ++sub.seq, payload: message })}\n`);
  }

  return {
    /** Send a message to every subscriber of `topic` for whom `to(ctx)` is true (all, when omitted). */
    publish(topic, message, to) {
      const t = check(topic, message);
      for (const sub of [...t.subs]) if (!to || to(sub.ctx)) send(t, sub, message);
    },
    subscribers: (topic) => topics.get(topic)?.subs.size ?? 0,

    async handle(req, res, topic) {
      try {
        const t = topics.get(topic);
        if (req.method !== "GET") return fail(res, 405, "invalid_request", "topics are read with GET");
        if (!t) return fail(res, 404, "not_found", `no such topic: ${topic}`);
        if (req.headers["lattice-api"] !== apiHash) return fail(res, 412, "api_mismatch", "the client is using a different API description");
        if (t.subs.size >= maxSubscribers) return fail(res, 429, "rate_limited", "too many subscribers");
        const session = req.headers["lattice-session"];
        const ctx = { session: typeof session === "string" && session ? session : undefined };
        const grant = (await authorize?.(topic, ctx)) ?? {};
        if (grant.snapshot !== undefined) check(topic, grant.snapshot);

        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        const sub = { res, ctx, seq: 0 };
        t.subs.add(sub);
        const beat = setInterval(() => res.write("\n"), heartbeatMs);
        beat.unref?.();
        const done = () => { clearInterval(beat); t.subs.delete(sub); };
        res.on("close", done);
        res.on("error", done);
        if (grant.snapshot !== undefined) send(t, sub, grant.snapshot);
        else res.write("\n"); // flush headers so the client knows the stream is open
      } catch (e) {
        if (e instanceof ApiError) return fail(res, e.status, e.code, e.message);
        log(`topic ${topic}: ${e.stack ?? e}`);
        if (!res.headersSent) fail(res, 500, "internal", "internal error");
      }
    },

    close() {
      for (const t of topics.values()) for (const s of t.subs) s.res.destroy();
    },
  };
}

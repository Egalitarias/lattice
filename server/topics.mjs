// Server side of Lattice topics (spec/rpc.md, "Topics"). A subscriber receives newline-delimited JSON frames
// `{"seq":n,"payload":{...}}` and a blank line as a heartbeat. The same frames travel over two transports:
//   - streaming HTTPS:  GET {api.url}/_topics/{topic}                       (handle, below)
//   - WebTransport:     a bidirectional stream per subscription             (webtransport.mjs, via open)
// The server publishes; every message is validated against the API description before anyone sees it.

import { Schema } from "../shared/schema.mjs";
import { encode } from "../shared/cbor.mjs";
import { ApiError, RPC_ERROR_TYPE } from "./rpc.mjs";

const MAX_QUEUED = 256 * 1024;

/**
 * @param opts.authorize  (topic, ctx) => void | { snapshot?: message }; throw ApiError to refuse. ctx = { session }.
 * @param opts.maxSubscribers  per topic
 *
 * A *sink* is where one subscriber's frames go: { write(string), queued() -> bytes waiting, destroy(), onClose(fn) }.
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
    if (sub.sink.queued() > MAX_QUEUED) {
      t.subs.delete(sub);
      sub.sink.destroy();
      return;
    }
    sub.sink.write(`${JSON.stringify({ seq: ++sub.seq, payload: message })}\n`);
  }

  /**
   * Start one subscription. Throws ApiError when it is refused (unknown topic, wrong API, not allowed, too many).
   * `request` is { api, session }, the two things a client states about itself on either transport.
   */
  async function open(topic, request, sink) {
    const t = topics.get(topic);
    if (!t) throw new ApiError("not_found", `no such topic: ${topic}`);
    if (request.api !== apiHash) throw new ApiError("api_mismatch", "the client is using a different API description");
    if (t.subs.size >= maxSubscribers) throw new ApiError("rate_limited", "too many subscribers");
    const ctx = { session: typeof request.session === "string" && request.session ? request.session : undefined };
    const grant = (await authorize?.(topic, ctx)) ?? {};
    if (grant.snapshot !== undefined) check(topic, grant.snapshot);

    const sub = { sink, ctx, seq: 0 };
    t.subs.add(sub);
    const beat = setInterval(() => sink.write("\n"), heartbeatMs);
    beat.unref?.();
    sink.onClose(() => {
      clearInterval(beat);
      t.subs.delete(sub);
    });
    if (grant.snapshot !== undefined) send(t, sub, grant.snapshot);
    else sink.write("\n"); // tells the client the stream is open
    return { close: () => sink.destroy() };
  }

  return {
    /** Send a message to every subscriber of `topic` for whom `to(ctx)` is true (all, when omitted). */
    publish(topic, message, to) {
      const t = check(topic, message);
      for (const sub of [...t.subs]) if (!to || to(sub.ctx)) send(t, sub, message);
    },
    subscribers: (topic) => topics.get(topic)?.subs.size ?? 0,
    has: (topic) => topics.has(topic),
    open,

    /** The streaming-HTTPS transport. */
    async handle(req, res, topic) {
      try {
        if (req.method !== "GET") return fail(res, 405, "invalid_request", "topics are read with GET");
        const sink = {
          write(s) {
            if (!res.headersSent) res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
            res.write(s);
          },
          queued: () => res.writableLength,
          destroy: () => res.destroy(),
          onClose(fn) {
            res.on("close", fn);
            res.on("error", fn);
          },
        };
        await open(topic, { api: req.headers["lattice-api"], session: req.headers["lattice-session"] }, sink);
      } catch (e) {
        if (e instanceof ApiError) return fail(res, e.status, e.code, e.message);
        log(`topic ${topic}: ${e.stack ?? e}`);
        if (!res.headersSent) fail(res, 500, "internal", "internal error");
      }
    },

    close() {
      for (const t of topics.values()) for (const s of t.subs) s.sink.destroy();
    },
  };
}

// A first-party analytics collector: the receiving end of spec/analytics.md.
//
// It accepts batches of events from Navigator, validates their shape strictly, and keeps them in memory.
// A real origin would write them to a store. It deliberately does not look at cookies, IP addresses or
// session tokens: Navigator sends none, and an endpoint that wants privacy should not go looking.

const EVENTS_TYPE = "application/vnd.lattice.events+json";
const MAX_BODY = 64 * 1024;
const MAX_EVENTS_PER_BATCH = 50;
const LEVELS = new Set(["errors", "anonymous", "full"]);
const KINDS = new Set(["product", "performance", "error"]);
const NAME = /^[a-z][a-z0-9_.]{0,47}$/;
const PROP_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** Why a batch is not acceptable, or null. */
export function checkBatch(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "not an object";
  if (b.v !== 1) return "unsupported version";
  if (!b.app || typeof b.app.domain !== "string" || b.app.domain.length > 253) return "bad app";
  if (!LEVELS.has(b.level)) return "bad level";
  if (b.client !== undefined && (b.level !== "full" || typeof b.client !== "string" || !/^c_[A-Za-z0-9_-]{22}$/.test(b.client))) {
    return "a client id is only valid at level full";
  }
  if (!Number.isInteger(b.sent_at)) return "bad sent_at";
  if (!Array.isArray(b.events) || b.events.length < 1 || b.events.length > MAX_EVENTS_PER_BATCH) return "bad events";
  for (const e of b.events) {
    if (!e || typeof e !== "object") return "bad event";
    if (!KINDS.has(e.kind)) return "bad kind";
    if (typeof e.name !== "string" || !NAME.test(e.name)) return "bad event name";
    if (!Number.isInteger(e.t)) return "bad timestamp";
    if (!e.props || typeof e.props !== "object" || Array.isArray(e.props)) return "bad props";
    const keys = Object.keys(e.props);
    if (keys.length > 20) return "too many props";
    for (const k of keys) {
      const v = e.props[k];
      if (!PROP_KEY.test(k)) return "bad prop name";
      if (!(typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 200))) return "bad prop value";
    }
  }
  return null;
}

export function createCollector({ maxEvents = 5000, log = console.error } = {}) {
  const events = []; // accepted events, oldest first
  const batches = []; // accepted batch envelopes (without events), for inspection

  async function handler(req, res) {
    const refuse = (status, message) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    };
    try {
      if (req.method !== "POST") return refuse(405, "POST only");
      if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== EVENTS_TYPE) return refuse(415, `Content-Type must be ${EVENTS_TYPE}`);
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return refuse(413, "too large");
        chunks.push(c);
      }
      let batch;
      try { batch = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return refuse(400, "bad JSON"); }
      const why = checkBatch(batch);
      if (why) return refuse(400, why);

      const { events: evs, ...envelope } = batch;
      batches.push(envelope);
      for (const e of evs) events.push({ ...e, app: batch.app.domain, level: batch.level, client: batch.client ?? null });
      while (events.length > maxEvents) events.shift();
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
    } catch (e) {
      log(`analytics collector: ${e.stack ?? e}`);
      refuse(500, "internal");
    }
  }

  /** Counts by name, kind and level. For the demo; a real origin would not expose this unauthenticated. */
  function summaryHandler(_req, res) {
    const by = (f) => events.reduce((o, e) => ((o[f(e)] = (o[f(e)] ?? 0) + 1), o), {});
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ total: events.length, by_name: by((e) => e.name), by_kind: by((e) => e.kind), by_level: by((e) => e.level), clients: new Set(events.map((e) => e.client).filter(Boolean)).size }));
  }

  return { handler, summaryHandler, events, batches };
}

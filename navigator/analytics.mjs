// The host's side of analytics and error reporting (spec/analytics.md).
//
// The app records events; this class decides whether anything leaves the device, what, and to whom.
// Nothing here trusts what the component says beyond what the manifest's catalog already allows, and
// nothing here can fail into the app: every entry point swallows its own errors.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const LEVELS = ["off", "errors", "anonymous", "full"];
export const DEFAULT_LEVEL = "errors";
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

/** Per kind: the processor purpose that receives it, the lowest level that sends it, and a per-minute cap. */
const KINDS = {
  product: { purpose: "product", min: RANK.anonymous, perMinute: 60 },
  performance: { purpose: "performance", min: RANK.anonymous, perMinute: 30 },
  error: { purpose: "errors", min: RANK.errors, perMinute: 20 },
};

const MAX_QUEUE = 500;
const MAX_PROPS = 20;
const BATCH = 20;
const MAX_BODY = 64 * 1024;
const SENSITIVE_TTL_MS = 10 * 60 * 1000;
const SENSITIVE_MAX = 20;
const SENSITIVE_MIN_LENGTH = 4;
const DETAIL_MAX = 200;
const RECENT_MAX = 10;
const isLoopbackHost = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TOKEN = /[A-Za-z0-9_-]{32,}/g;
const DIGITS = /\b(?:\d[ -]?){8,}\d\b/g;

/** Text longer than this is cut before any pattern is applied: the patterns can backtrack on hostile input. */
const SCRUB_INPUT_MAX = 1000;

/** Remove what looks like personal data from text bound for a developer, and cut it to a safe length. */
export function scrub(text) {
  let t;
  try { t = String(text ?? ""); } catch { return ""; }
  return t.slice(0, SCRUB_INPUT_MAX).replace(EMAIL, "[email]").replace(TOKEN, "[token]").replace(DIGITS, "[number]").slice(0, DETAIL_MAX);
}

/** Why `props` do not satisfy the catalog entry, or null if they do. */
export function checkProps(def, props) {
  if (!props || typeof props !== "object" || Array.isArray(props)) return "properties are not an object";
  const keys = Object.keys(props);
  if (keys.length > MAX_PROPS) return "too many properties";
  const declared = def.props ?? {};
  for (const k of keys) {
    const spec = Object.hasOwn(declared, k) ? declared[k] : undefined;
    if (!spec) return `property "${k}" is not declared`;
    const v = props[k];
    switch (spec.type) {
      case "string":
        if (typeof v !== "string") return `property "${k}" must be a string`;
        if (v.length > (spec.max_length ?? 64)) return `property "${k}" is too long`;
        if (spec.enum && !spec.enum.includes(v)) return `property "${k}" is not one of its declared values`;
        break;
      case "integer":
        if (!Number.isSafeInteger(v)) return `property "${k}" must be an integer`;
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) return `property "${k}" must be a number`;
        break;
      case "boolean":
        if (typeof v !== "boolean") return `property "${k}" must be a boolean`;
        break;
      default:
        return `property "${k}" has an unknown type`;
    }
  }
  return null;
}

export class Analytics {
  #queue = [];
  #sensitive = []; // { value, at }
  #windows = { product: [], performance: [], error: [] }; // timestamps of accepted events, for the per-minute caps
  #timer = null;
  #inflight = new Set();
  #sleeping = new Set(); // retry waits, so closing can cancel them instead of waiting out a backoff
  #closed = false;
  #level;
  #nextId = 1;
  stats = { sent: 0, dropped: 0, held: 0, failed: 0 };
  recent = [];

  /**
   * @param manifest   the verified manifest (its analytics section is the policy)
   * @param processors manifest processors with their endpoints already resolved to reachable addresses
   * @param dataDir    where the profile's settings and the client id live
   */
  constructor({ manifest, processors, dataDir, dev = false, log = () => {}, fetchImpl = fetch, now = () => Date.now(), flushMs = 5000, backoffMs = [1000, 4000, 16000] }) {
    Object.assign(this, { manifest, dataDir, dev, log, fetchImpl, now, flushMs, backoffMs });
    this.catalog = new Map((manifest.analytics?.events ?? []).map((e) => [e.name, e]));
    this.processors = [];
    for (const p of processors ?? []) {
      if (!this.#endpointOk(p.endpoint)) {
        log("warn", `analytics: ignoring processor "${p.name}": its endpoint is not acceptable`);
        continue;
      }
      this.processors.push({ name: p.name, endpoint: p.endpoint, purposes: [...p.purposes], host: new URL(p.endpoint).host });
    }
    this.#level = this.#readLevel();
  }

  #endpointOk(value) {
    try {
      const u = new URL(value);
      if (u.username || u.password) return false;
      return u.protocol === "https:" || (this.dev && u.protocol === "http:" && isLoopbackHost(u.hostname));
    } catch {
      return false;
    }
  }

  // ---- Settings -----------------------------------------------------------------------------------

  get #settingsFile() {
    return join(this.dataDir, "settings.json");
  }

  #readLevel() {
    try {
      const l = JSON.parse(readFileSync(this.#settingsFile, "utf8")).analytics;
      if (LEVELS.includes(l)) return l;
    } catch { /* no settings yet */ }
    return DEFAULT_LEVEL;
  }

  get level() {
    return this.#level;
  }

  /** The user's choice. Lowering it discards queued events the new level would not send. */
  setLevel(level) {
    if (!LEVELS.includes(level)) throw new RangeError(`unknown analytics level "${level}"`);
    let settings = {};
    try { settings = JSON.parse(readFileSync(this.#settingsFile, "utf8")); } catch { /* none yet */ }
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.#settingsFile, JSON.stringify({ ...settings, analytics: level }));
    this.#level = level;
    const before = this.#queue.length;
    this.#queue = this.#queue.filter((e) => RANK[level] >= KINDS[e.kind].min);
    this.stats.held += before - this.#queue.length;
    return level;
  }

  // ---- Client id (level "full" only) ---------------------------------------------------------------

  get #clientFile() {
    return join(this.dataDir, "analytics", this.manifest.app.replace(/[^A-Za-z0-9.-]/g, "_") + ".json");
  }

  clientId() {
    try {
      const c = JSON.parse(readFileSync(this.#clientFile, "utf8")).client;
      if (typeof c === "string" && /^c_[A-Za-z0-9_-]{22}$/.test(c)) return c;
    } catch { /* make one */ }
    return this.resetClient();
  }

  /** A new random id: the old one can no longer be linked to anything sent afterwards. */
  resetClient() {
    const client = "c_" + randomBytes(16).toString("base64url");
    mkdirSync(join(this.dataDir, "analytics"), { recursive: true });
    writeFileSync(this.#clientFile, JSON.stringify({ client }), { mode: 0o600 });
    return client;
  }

  // ---- Redaction ----------------------------------------------------------------------------------

  /** Remember values the user typed into sensitive inputs, so they can be scrubbed from anything sent. */
  noteSensitive(values) {
    try {
      const now = this.now();
      for (const v of values) {
        if (typeof v !== "string" && typeof v !== "number") continue; // nothing else can be typed into an input
        const s = String(v);
        if (s.length < SENSITIVE_MIN_LENGTH) continue;
        this.#sensitive = this.#sensitive.filter((x) => x.value !== s);
        this.#sensitive.push({ value: s, at: now });
      }
      this.#sensitive = this.#sensitive.filter((x) => now - x.at < SENSITIVE_TTL_MS).slice(-SENSITIVE_MAX);
    } catch { /* a bad value is simply not remembered */ }
  }

  /** Free text bound for a developer: redact sensitive values from the full text first, then scrub and cut. */
  #cleanText(text) {
    let t;
    try { t = String(text ?? ""); } catch { return ""; }
    return scrub(this.#redact(t.slice(0, SCRUB_INPUT_MAX)));
  }

  #redact(text) {
    const now = this.now();
    let out = text;
    for (const { value, at } of this.#sensitive) {
      if (now - at < SENSITIVE_TTL_MS && out.includes(value)) out = out.split(value).join("[redacted]");
    }
    return out;
  }

  // ---- Entry points -------------------------------------------------------------------------------

  /** A product event from the app. Checked against the catalog; dropped whole if anything is off. */
  emit(name, props) {
    try {
      const def = typeof name === "string" ? this.catalog.get(name) : undefined;
      if (!def) return this.#drop(`${String(name).slice(0, 48)}: not in the manifest's event catalog`);
      const why = checkProps(def, props);
      if (why) return this.#drop(`${name}: ${why}`);
      this.#enqueue("product", name, props);
    } catch (e) {
      this.log("warn", `analytics: ${e.message}`);
    }
  }

  /** A failure the app reports. `detail` is scrubbed. */
  reportError(name, detail) {
    try {
      if (typeof name !== "string" || !/^[a-z][a-z0-9_.]{0,47}$/.test(name)) return this.#drop("report-error: bad name");
      this.#enqueue("error", "app.reported", { name, detail: this.#cleanText(detail) });
    } catch (e) {
      this.log("warn", `analytics: ${e.message}`);
    }
  }

  /** An event the host itself generates (timings, failures). Not in the catalog; shaped here, not by the app. */
  host(kind, name, props = {}) {
    try {
      if (kind !== "performance" && kind !== "error") return;
      const clean = {};
      for (const [k, v] of Object.entries(props)) {
        if (k === "ms") clean.ms = Math.max(0, Math.round(Number(v) / 10) * 10);
        else if (k === "detail") clean.detail = this.#cleanText(v);
        else clean[k] = String(v).slice(0, 64);
      }
      this.#enqueue(kind, name, clean);
    } catch (e) {
      this.log("warn", `analytics: ${e.message}`);
    }
  }

  #drop(why) {
    this.stats.dropped++;
    this.log("warn", `analytics: dropped event: ${why}`);
  }

  #enqueue(kind, name, props) {
    const cfg = KINDS[kind];
    // Held back, not an error: no processor wants this kind, or the user's level does not allow it.
    if (!this.processors.some((p) => p.purposes.includes(cfg.purpose)) || RANK[this.#level] < cfg.min) {
      this.stats.held++;
      return;
    }
    const now = this.now();
    const win = this.#windows[kind];
    while (win.length && now - win[0] >= 60_000) win.shift();
    if (win.length >= cfg.perMinute) {
      this.stats.dropped++;
      return;
    }
    win.push(now);

    const safe = {};
    for (const [k, v] of Object.entries(props)) safe[k] = typeof v === "string" ? this.#redact(v) : v;
    this.#queue.push({ id: this.#nextId++, kind, name, t: now, props: safe, sentTo: [] });
    if (this.#queue.length > MAX_QUEUE) {
      this.#queue.shift();
      this.stats.dropped++;
    }
    if (this.#queue.length >= BATCH) setImmediate(() => void this.flush());
    else this.#schedule();
  }

  #schedule() {
    if (this.#timer || this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.flushMs);
    this.#timer.unref?.();
  }

  // ---- Delivery -----------------------------------------------------------------------------------

  /** Send everything queued, to each processor that wants it. Resolves when those attempts are done. */
  async flush() {
    const batch = this.#queue.splice(0);
    if (!batch.length) return;
    const jobs = [];
    for (const p of this.processors) {
      const mine = batch.filter((e) => p.purposes.includes(KINDS[e.kind].purpose));
      for (let i = 0; i < mine.length; i += BATCH) jobs.push(this.#send(p, mine.slice(i, i + BATCH), 0));
    }
    await Promise.all(jobs);
  }

  #track(promise) {
    this.#inflight.add(promise);
    promise.finally(() => this.#inflight.delete(promise));
    return promise;
  }

  #send(processor, events, attempt) {
    return this.#track(this.#sendOnce(processor, events, attempt));
  }

  async #sendOnce(processor, events, attempt) {
    // The level may have dropped while a retry was waiting.
    const level = this.#level;
    const live = events.filter((e) => RANK[level] >= KINDS[e.kind].min);
    this.stats.held += events.length - live.length;
    if (!live.length) return;

    const full = level === "full";
    const stamp = (ms) => (full ? Math.floor(ms / 1000) : Math.floor(ms / 60_000) * 60);
    const payload = {
      v: 1,
      app: { domain: this.manifest.app, version: this.manifest.version, build: this.manifest.entry },
      level,
      ...(full ? { client: this.clientId() } : {}),
      sent_at: stamp(this.now()),
      events: live.map((e) => ({ kind: e.kind, name: e.name, t: stamp(e.t), props: e.props })),
    };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BODY) {
      this.stats.dropped += live.length;
      return;
    }

    let retryable = false;
    try {
      const res = await this.fetchImpl(processor.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/vnd.lattice.events+json" },
        body,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      });
      await res.arrayBuffer().catch(() => {});
      if (res.ok) {
        this.stats.sent += live.length;
        for (const e of live) this.#delivered(e, processor.name);
        return;
      }
      retryable = res.status >= 500 || res.status === 429;
    } catch {
      retryable = true;
    }

    if (retryable && attempt < this.backoffMs.length && !this.#closed) {
      await this.#sleep(this.backoffMs[attempt]);
      if (!this.#closed) return this.#sendOnce(processor, live, attempt + 1);
    }
    this.stats.failed += live.length;
  }

  /** Wait `ms`, unless the analytics are closed first. The timer is not unref'd: someone is awaiting it. */
  #sleep(ms) {
    return new Promise((resolve) => {
      const entry = { resolve };
      entry.timer = setTimeout(() => {
        this.#sleeping.delete(entry);
        resolve();
      }, ms);
      this.#sleeping.add(entry);
    });
  }

  #delivered(e, processorName) {
    if (!e.sentTo.length) {
      this.recent.push({ kind: e.kind, name: e.name, t: Math.floor(e.t / 1000), props: e.props, to: e.sentTo });
      if (this.recent.length > RECENT_MAX) this.recent.shift();
    }
    e.sentTo.push(processorName);
  }

  // ---- What the user sees -------------------------------------------------------------------------

  snapshot() {
    return {
      level: this.#level,
      levels: LEVELS,
      processors: this.processors.map(({ name, host, purposes }) => ({ name, host, purposes })),
      stats: { ...this.stats },
      recent: this.recent.map((e) => ({ ...e, to: [...e.to] })),
      client: this.#level === "full",
    };
  }

  /** Stop timers and make a last, best-effort attempt to deliver what is queued. */
  async close() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const last = this.flush();
    this.#closed = true;
    for (const w of this.#sleeping) { clearTimeout(w.timer); w.resolve(); } // cancel any retry waiting out a backoff
    this.#sleeping.clear();
    await Promise.race([last, new Promise((r) => setTimeout(r, 2000).unref?.())]);
    await Promise.race([Promise.allSettled([...this.#inflight]), new Promise((r) => setTimeout(r, 2000).unref?.())]);
  }
}

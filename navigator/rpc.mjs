// Host side of Lattice RPC (spec/rpc.md). Runs on Lattice Navigator's main thread; the component reaches it
// through a blocking bridge (see app-worker.mjs).
//
// The component only ever sees one of: validated response bytes, or a classified error.

import { Schema } from "../shared/schema.mjs";
import { encode, decode } from "../shared/cbor.mjs";
import { b64uDecode, fromUtf8, randomToken, uuid, concat } from "./bytes.mjs";
import { getJson, setJson } from "./kv.mjs";

export const RPC_TYPE = "application/vnd.lattice.rpc+cbor";
export const RPC_ERROR_TYPE = "application/vnd.lattice.rpc-error+cbor";
export const MAX_BODY = 1024 * 1024;
const STANDARD = new Set(["invalid_request", "unauthorized", "forbidden", "not_found", "api_mismatch", "rate_limited", "internal"]);

/** Result of a call: { ok: true, bytes } or { ok: false, error } where error mirrors WIT `rpc-error`. */
const ok = (bytes) => ({ ok: true, bytes });
const host = (tag, val) => ({ ok: false, error: { tag: "host", val: { tag, val } } });
const transport = (msg) => ({ ok: false, error: { tag: "transport", val: msg } });
const application = (code, message, details) => ({ ok: false, error: { tag: "application", val: { code, message, details } } });

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_SESSION_SECONDS = 30 * 24 * 3600;

/**
 * Validate a Lattice-Set-Session header value (spec/auth.md). Returns the session or null.
 * Anything outside the limits is ignored rather than clamped: a server that sends it is broken.
 */
export function parseSetSession(value, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let s;
  try {
    s = JSON.parse(fromUtf8(b64uDecode(value)));
  } catch {
    return null;
  }
  if (!s || typeof s !== "object") return null;
  if (typeof s.token !== "string" || !TOKEN_RE.test(s.token)) return null;
  if (typeof s.subject !== "string" || s.subject.length < 1 || s.subject.length > 256) return null;
  if (s.name !== undefined && (typeof s.name !== "string" || s.name.length > 80)) return null;
  if (!Number.isInteger(s.expires) || s.expires <= nowSec || s.expires > nowSec + MAX_SESSION_SECONDS) return null;
  return { token: s.token, subject: s.subject, name: s.name, expires: s.expires };
}

/**
 * The host's session for one origin: an opaque token, plus who it belongs to once the server has
 * signed the user in. Apps never see the token. Persisted per origin.
 */
export class SessionStore {
  constructor(kv, origin, { now = () => Date.now() } = {}) {
    this.kv = kv;
    this.key = `session/${origin}`;
    this.now = now;
  }
  #read() {
    const s = getJson(this.kv, this.key);
    if (s && typeof s.token === "string" && TOKEN_RE.test(s.token)) return s;
    return this.rotate(); // none, or unreadable: a fresh anonymous session
  }
  #write(s) {
    setJson(this.kv, this.key, s);
    return s;
  }
  /** The token to send. An expired signed-in session is replaced by a fresh anonymous one. */
  token() {
    return this.#current().token;
  }
  #current() {
    const s = this.#read();
    if (s.subject && s.expires <= Math.floor(this.now() / 1000)) return this.rotate();
    return s;
  }
  info() {
    const s = this.#current();
    return { signedIn: !!s.subject, subject: s.subject, name: s.name, expiresAt: s.subject ? s.expires : undefined };
  }
  /** Install a session the server issued (already validated by parseSetSession). */
  set(session) {
    this.#write({ token: session.token, subject: session.subject, name: session.name, expires: session.expires });
  }
  /** Replace the session with a fresh anonymous one. */
  rotate() {
    return this.#write({ token: randomToken(32) });
  }
}

/**
 * Apply the session-changing headers of a 200 response to the store. Returns true if the session
 * changed. The headers are consumed here; nothing downstream sees them.
 */
export function applySessionHeaders(store, headers) {
  if (!store) return false;
  const set = headers.get("lattice-set-session");
  if (set !== null) {
    const parsed = parseSetSession(set, Math.floor(store.now() / 1000));
    if (!parsed) return false;
    store.set(parsed);
    return true;
  }
  if (headers.get("lattice-clear-session") !== null) {
    store.rotate();
    return true;
  }
  return false;
}

export class RpcClient {
  /**
   * @param endpoint     URL of the API root, e.g. http://127.0.0.1:8080/rpc
   * @param description  parsed API description
   * @param apiHash      its hash, sent as Lattice-Api
   * @param session      SessionStore, or null when the `session` capability is not granted
   */
  constructor({ endpoint, description, apiHash, session, timeoutMs = 10_000 }) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.description = description;
    this.apiHash = apiHash;
    this.session = session;
    this.timeoutMs = timeoutMs;

    // Throws SchemaError for any keyword the interpreter would not enforce: such an API is refused, not half-checked.
    this.methods = new Map(
      Object.entries(description.methods).map(([name, m]) => [
        name,
        {
          effect: m.effect ?? "write",
          request: new Schema(m.request),
          response: new Schema(m.response),
          declared: new Set((m.errors ?? []).map((e) => e.code)),
        },
      ])
    );
  }

  async call(method, requestBytes) {
    const m = this.methods.get(method);
    if (!m) return host("invalid-argument", `unknown method "${method}"`);

    let request;
    try {
      request = decode(requestBytes);
    } catch (e) {
      return host("invalid-argument", `request is not valid CBOR: ${e.message}`);
    }
    const requestProblem = m.request.check(request);
    if (requestProblem) return host("invalid-argument", `request to ${method} does not match the API description: ${requestProblem}`);
    const body = encode(request);
    if (body.length > MAX_BODY) return host("invalid-argument", "request too large");

    // Only reads are retried, and only after a network failure (never after an answer).
    const attempts = m.effect === "read" ? 2 : 1;
    let last;
    for (let i = 0; i < attempts; i++) {
      last = await this.#once(method, m, body);
      if (!(last.error?.tag === "transport" && last.networkFailure)) break;
    }
    delete last.networkFailure;
    return last;
  }

  async #once(method, m, body) {
    const headers = {
      "Content-Type": RPC_TYPE,
      Accept: `${RPC_TYPE}, ${RPC_ERROR_TYPE}`,
      "Lattice-Api": this.apiHash,
      "Lattice-Request-Id": uuid(),
    };
    if (this.session) headers["Lattice-Session"] = this.session.token();

    let res;
    try {
      res = await fetch(`${this.endpoint}/${method}`, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError";
      return { ...transport(timedOut ? `${method} timed out after ${this.timeoutMs} ms` : `could not reach the server: ${e.cause?.code ?? e.message}`), networkFailure: true };
    }

    let bytes;
    try {
      bytes = await readCapped(res, MAX_BODY);
    } catch (e) {
      return transport(e.message);
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();

    if (res.status === 200) {
      if (type !== RPC_TYPE) return transport(`server replied with ${type || "no content type"}, expected ${RPC_TYPE}`);
      let value;
      try {
        value = decode(bytes);
      } catch (e) {
        return transport(`response is not valid CBOR: ${e.message}`);
      }
      const responseProblem = m.response.check(value);
      if (responseProblem) return transport(`response violates the API description for ${method}: ${responseProblem}`);
      applySessionHeaders(this.session, res.headers); // only after the response passed validation
      return ok(bytes);
    }

    if (res.status < 400) return transport(`unexpected status ${res.status}`);
    if (type !== RPC_ERROR_TYPE) return transport(`server error ${res.status} without an RPC error body`);
    let err;
    try {
      err = decode(bytes);
    } catch (e) {
      return transport(`error body is not valid CBOR: ${e.message}`);
    }
    if (!err || typeof err.code !== "string" || typeof err.message !== "string") {
      return transport("malformed RPC error body");
    }
    if (!STANDARD.has(err.code) && !m.declared.has(err.code)) {
      return transport(`server returned undeclared error code "${err.code}" for ${method}`);
    }
    return application(err.code, err.message, err.details === undefined ? new Uint8Array() : encode(err.details));
  }
}

async function readCapped(res, max) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error("response too large");
  const chunks = [];
  let size = 0;
  for await (const c of res.body ?? []) {
    size += c.length;
    if (size > max) throw new Error("response too large");
    chunks.push(c);
  }
  return concat(chunks);
}

// Host side of Lattice RPC (spec/rpc.md). Runs on Lattice Navigator's main thread; the component reaches it
// through a blocking bridge (see app-worker.mjs).
//
// The component only ever sees one of: validated response bytes, or a classified error.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { encode, decode } from "../shared/cbor.mjs";

export const RPC_TYPE = "application/vnd.lattice.rpc+cbor";
export const RPC_ERROR_TYPE = "application/vnd.lattice.rpc-error+cbor";
export const MAX_BODY = 1024 * 1024;
const STANDARD = new Set(["invalid_request", "unauthorized", "forbidden", "not_found", "api_mismatch", "rate_limited", "internal"]);

/** Result of a call: { ok: true, bytes } or { ok: false, error } where error mirrors WIT `rpc-error`. */
const ok = (bytes) => ({ ok: true, bytes });
const host = (tag, val) => ({ ok: false, error: { tag: "host", val: { tag, val } } });
const transport = (msg) => ({ ok: false, error: { tag: "transport", val: msg } });
const application = (code, message, details) => ({ ok: false, error: { tag: "application", val: { code, message, details } } });

/** A random, opaque, per-origin token that the host attaches to RPC calls. Apps never see it. */
export class SessionStore {
  constructor(dir, origin) {
    this.file = join(dir, "sessions", origin.replace(/[^A-Za-z0-9.-]/g, "_") + ".json");
  }
  token() {
    if (existsSync(this.file)) {
      try { return JSON.parse(readFileSync(this.file, "utf8")).token; } catch { /* regenerate */ }
    }
    return this.rotate();
  }
  rotate() {
    const token = randomBytes(32).toString("base64url");
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ token }), { mode: 0o600 });
    return token;
  }
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

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    this.ajv = ajv;
    this.methods = new Map(
      Object.entries(description.methods).map(([name, m]) => [
        name,
        {
          effect: m.effect ?? "write",
          validateRequest: ajv.compile(m.request),
          validateResponse: ajv.compile(m.response),
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
    if (!m.validateRequest(request)) {
      return host("invalid-argument", `request to ${method} does not match the API description: ${this.ajv.errorsText(m.validateRequest.errors, { separator: "; " })}`);
    }
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
      "Lattice-Request-Id": randomUUID(),
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
      if (!m.validateResponse(value)) {
        return transport(`response violates the API description for ${method}: ${this.ajv.errorsText(m.validateResponse.errors, { separator: "; " })}`);
      }
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
  return new Uint8Array(Buffer.concat(chunks));
}

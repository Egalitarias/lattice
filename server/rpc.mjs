// Server side of Lattice RPC (spec/rpc.md): POST {api.url}/{method}.
// Validates the request against the API description, calls the handler, validates the response,
// and encodes errors as application/vnd.lattice.rpc-error+cbor.

import { Schema } from "../shared/schema.mjs";
import { encode, decode } from "../shared/cbor.mjs";

export const RPC_TYPE = "application/vnd.lattice.rpc+cbor";
export const RPC_ERROR_TYPE = "application/vnd.lattice.rpc-error+cbor";
const MAX_BODY = 1024 * 1024;

/** Encode a session change for the Lattice-Set-Session header (spec/auth.md). */
export function sessionHeader({ token, subject, name, expires }) {
  const body = { token, subject, expires };
  if (name) body.name = name;
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

export const STANDARD_ERRORS = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  api_mismatch: 412,
  rate_limited: 429,
  internal: 500,
};

/** Throw from a handler to return an error. Non-standard codes must be declared for the method. */
export class ApiError extends Error {
  constructor(code, message, { details, status } = {}) {
    super(message ?? code);
    this.code = code;
    this.details = details;
    this.status = status ?? STANDARD_ERRORS[code] ?? 422;
  }
}

export function createRpc({ apiDescription, apiHash, handlers, log = console.error }) {
  const methods = new Map();
  for (const [name, m] of Object.entries(apiDescription.methods)) {
    if (!handlers[name]) throw new Error(`API method "${name}" has no handler`);
    methods.set(name, {
      // The same interpreter the host uses, so both ends agree on what a valid body is. It refuses, at startup,
      // any schema keyword it would not enforce.
      request: new Schema(m.request),
      response: new Schema(m.response),
      declared: new Set((m.errors ?? []).map((e) => e.code)),
      handler: handlers[name],
    });
  }
  for (const name of Object.keys(handlers)) {
    if (!methods.has(name)) throw new Error(`handler "${name}" is not in the API description`);
  }

  const fail = (res, status, code, message, details) => {
    const body = Buffer.from(encode({ code, message, ...(details !== undefined ? { details } : {}) }));
    res.writeHead(status, { "Content-Type": RPC_ERROR_TYPE, "Content-Length": body.length });
    res.end(body);
  };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new ApiError("invalid_request", "request body too large");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  /** Handle one request. `method` is the final path segment, already extracted by the caller. */
  return async function handle(req, res, method) {
    try {
      if (req.method !== "POST") return fail(res, 405, "invalid_request", "RPC calls use POST");
      const m = methods.get(method);
      if (!m) return fail(res, 404, "not_found", `no such method: ${method}`);
      if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== RPC_TYPE) {
        return fail(res, 400, "invalid_request", `Content-Type must be ${RPC_TYPE}`);
      }
      if (req.headers["lattice-api"] !== apiHash) {
        return fail(res, 412, "api_mismatch", "the client is using a different API description");
      }

      let request;
      try {
        request = decode(new Uint8Array(await readBody(req)));
      } catch (e) {
        if (e instanceof ApiError) throw e;
        return fail(res, 400, "invalid_request", `body is not valid CBOR: ${e.message}`);
      }
      const requestProblem = m.request.check(request);
      if (requestProblem) return fail(res, 400, "invalid_request", requestProblem);

      const session = req.headers["lattice-session"];
      // Handlers change the host's session through ctx; the headers are only sent on a 200.
      const change = {};
      const ctx = {
        session: typeof session === "string" && session ? session : undefined,
        setSession: (info) => { change.set = info; },
        clearSession: () => { change.clear = true; },
      };
      const result = await m.handler(request, ctx);

      const responseProblem = m.response.check(result);
      if (responseProblem) {
        log(`rpc ${method}: handler response violates the API description: ${responseProblem}`);
        return fail(res, 500, "internal", "internal error");
      }
      const body = Buffer.from(encode(result));
      if (body.length > MAX_BODY) {
        log(`rpc ${method}: response too large`);
        return fail(res, 500, "internal", "internal error");
      }
      const headers = { "Content-Type": RPC_TYPE, "Content-Length": body.length };
      if (change.set) headers["Lattice-Set-Session"] = sessionHeader(change.set);
      else if (change.clear) headers["Lattice-Clear-Session"] = "1";
      res.writeHead(200, headers);
      res.end(body);
    } catch (e) {
      if (e instanceof ApiError) {
        const m = methods.get(method);
        if (!(e.code in STANDARD_ERRORS) && !m?.declared.has(e.code)) {
          log(`rpc ${method}: handler threw undeclared error code "${e.code}"`);
          return fail(res, 500, "internal", "internal error");
        }
        return fail(res, e.status, e.code, e.message, e.details);
      }
      log(`rpc ${method}: ${e.stack ?? e}`);
      fail(res, 500, "internal", "internal error");
    }
  };
}

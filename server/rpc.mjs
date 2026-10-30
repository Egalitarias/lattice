// Server side of Lattice RPC (spec/rpc.md): POST {api.url}/{method}.
// Validates the request against the API description, calls the handler, validates the response,
// and encodes errors as application/vnd.lattice.rpc-error+cbor.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { encode, decode } from "../shared/cbor.mjs";

export const RPC_TYPE = "application/vnd.lattice.rpc+cbor";
export const RPC_ERROR_TYPE = "application/vnd.lattice.rpc-error+cbor";
const MAX_BODY = 1024 * 1024;

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
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);

  const methods = new Map();
  for (const [name, m] of Object.entries(apiDescription.methods)) {
    if (!handlers[name]) throw new Error(`API method "${name}" has no handler`);
    methods.set(name, {
      validateRequest: ajv.compile(m.request),
      validateResponse: ajv.compile(m.response),
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
      if (!m.validateRequest(request)) {
        return fail(res, 400, "invalid_request", ajv.errorsText(m.validateRequest.errors, { separator: "; " }));
      }

      const session = req.headers["lattice-session"];
      const result = await m.handler(request, { session: typeof session === "string" ? session : undefined });

      if (!m.validateResponse(result)) {
        log(`rpc ${method}: handler response violates the API description: ${ajv.errorsText(m.validateResponse.errors)}`);
        return fail(res, 500, "internal", "internal error");
      }
      const body = Buffer.from(encode(result));
      if (body.length > MAX_BODY) {
        log(`rpc ${method}: response too large`);
        return fail(res, 500, "internal", "internal error");
      }
      res.writeHead(200, { "Content-Type": RPC_TYPE, "Content-Length": body.length });
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

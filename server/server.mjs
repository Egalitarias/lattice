// Prototype Lattice origin.
//
//   GET <any path>  Accept: application/vnd.lattice.app+cbor  -> the app manifest (CBOR)
//   GET /.lattice/blob/<hash>                                  -> an immutable, content-addressed file
//   POST <api.url path>/<method>                               -> typed RPC (see spec/rpc.md)
//   GET /.well-known/lattice.json                              -> the manifest as JSON (discovery/debug)
//   GET <any path>  (anything else)                            -> HTML fallback for non-Lattice clients
//
// An app directory contains:
//   manifest.json                     required
//   target/wasm32-wasip2/release/*.wasm   the built component (exactly one)
//   api.json + api.mjs                optional: API description and its handlers
//
// Usage: node server.mjs --app ../examples/tasks [--port 8080] [--domain tasks.localhost]

import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { encode } from "../shared/cbor.mjs";
import { createRpc } from "./rpc.mjs";

export const MANIFEST_TYPE = "application/vnd.lattice.app+cbor";
const here = dirname(fileURLToPath(import.meta.url));

export function hashOf(bytes) {
  return "sha256-" + createHash("sha256").update(bytes).digest("base64url");
}

function findComponent(appDir) {
  const dir = join(appDir, "target", "wasm32-wasip2", "release");
  const wasm = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wasm")) : [];
  if (wasm.length !== 1) {
    throw new Error(
      `expected exactly one built component in ${dir} (found ${wasm.length})\n` +
        `  run: cargo build --release --target wasm32-wasip2 (in ${appDir})`
    );
  }
  return join(dir, wasm[0]);
}

const schemaValidator = (name) => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(join(here, "..", "spec", name), "utf8")));
  return (doc, what) => {
    if (!validate(doc)) throw new Error(`${what} is invalid:\n  ` + ajv.errorsText(validate.errors, { separator: "\n  " }));
  };
};

export async function loadApp({ appDir, domain, log = console.error }) {
  const wasm = readFileSync(findComponent(appDir));
  const blobs = new Map();
  const entry = hashOf(wasm);
  blobs.set(entry, { bytes: wasm, type: "application/wasm" });

  const manifest = { ...JSON.parse(readFileSync(join(appDir, "manifest.json"), "utf8")), entry };
  if (domain) manifest.app = domain;

  let rpc = null;
  let rpcPath = null;
  const apiFile = join(appDir, "api.json");
  if (existsSync(apiFile)) {
    const apiBytes = readFileSync(apiFile);
    const apiDescription = JSON.parse(apiBytes);
    schemaValidator("api.schema.json")(apiDescription, "api.json");
    const apiHash = hashOf(apiBytes);
    blobs.set(apiHash, { bytes: apiBytes, type: "application/json" });
    if (!manifest.api) throw new Error("api.json exists but manifest.json has no \"api\" section");
    manifest.api = { ...manifest.api, schema: apiHash };
    rpcPath = new URL(manifest.api.url).pathname.replace(/\/$/, "");
    const mod = await import(pathToFileURL(join(appDir, "api.mjs")).href);
    rpc = createRpc({ apiDescription, apiHash, handlers: mod.handlers, log });
  } else if (manifest.api) {
    throw new Error("manifest.json declares an \"api\" but there is no api.json");
  }

  schemaValidator("manifest.schema.json")(manifest, "manifest");
  return { manifest, blobs, rpc, rpcPath };
}

const FALLBACK = (name) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<h1>${name}</h1>
<p>This site is a Lattice application. Open it with Lattice Navigator, or any client that sends
<code>Accept: ${MANIFEST_TYPE}</code>.</p>
`;

export function createServer({ manifest, blobs, rpc, rpcPath }) {
  const cbor = Buffer.from(encode(manifest));
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://placeholder");
    const accept = String(req.headers.accept ?? "");

    res.setHeader("Vary", "Accept");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (rpc && url.pathname.startsWith(rpcPath + "/")) {
      const method = url.pathname.slice(rpcPath.length + 1);
      res.setHeader("Cache-Control", "no-store");
      return void rpc(req, res, method);
    }

    const blob = url.pathname.match(/^\/\.lattice\/blob\/(sha256-[A-Za-z0-9_-]{43})$/);
    if (blob) {
      const b = blobs.get(blob[1]);
      if (!b) return void res.writeHead(404).end();
      res.writeHead(200, {
        "Content-Type": b.type,
        "Content-Length": b.bytes.length,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      return void res.end(b.bytes);
    }

    if (url.pathname === "/.well-known/lattice.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify(manifest, null, 2));
    }

    if (accept.includes(MANIFEST_TYPE)) {
      res.writeHead(200, { "Content-Type": MANIFEST_TYPE, "Content-Length": cbor.length, "Cache-Control": "no-cache" });
      return void res.end(cbor);
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(FALLBACK(manifest.name ?? manifest.app));
  });
}

function args(argv) {
  const out = { port: 8080, app: resolve(here, "..", "examples", "todo"), domain: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--app") out.app = resolve(argv[++i]);
    else if (argv[i] === "--domain") out.domain = argv[++i];
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = args(process.argv.slice(2));
  const app = await loadApp({ appDir: a.app, domain: a.domain });
  createServer(app).listen(a.port, "127.0.0.1", () => {
    console.log(`lattice server for ${app.manifest.app} on http://127.0.0.1:${a.port}`);
    console.log(`  entry ${app.manifest.entry}`);
    if (app.manifest.api) console.log(`  api   ${app.manifest.api.schema} at ${app.rpcPath}/<method>`);
  });
}

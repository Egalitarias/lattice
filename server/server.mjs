// Prototype Lattice origin.
//
//   GET <any path>  Accept: application/vnd.lattice.app+cbor  -> the app manifest (CBOR)
//   GET /.lattice/blob/<hash>                                  -> an immutable, content-addressed file
//   GET /.well-known/lattice.json                              -> the manifest as JSON (discovery/debug)
//   GET <any path>  (anything else)                            -> HTML fallback for non-Lattice clients
//
// Usage: node server.mjs --app ../examples/todo [--port 8080] [--domain todo.localhost]

import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { encode } from "../shared/cbor.mjs";

export const MANIFEST_TYPE = "application/vnd.lattice.app+cbor";
const here = dirname(fileURLToPath(import.meta.url));

export function hashOf(bytes) {
  return "sha256-" + createHash("sha256").update(bytes).digest("base64url");
}

export function loadApp({ appDir, domain }) {
  const manifestPath = join(appDir, "manifest.json");
  const wasmPath = join(appDir, "target", "wasm32-wasip2", "release", "todo.wasm");
  if (!existsSync(wasmPath)) {
    throw new Error(`component not built: ${wasmPath}\n  run: cargo build --release --target wasm32-wasip2 (in ${appDir})`);
  }
  const wasm = readFileSync(wasmPath);
  const entry = hashOf(wasm);
  const manifest = { ...JSON.parse(readFileSync(manifestPath, "utf8")), entry };
  if (domain) manifest.app = domain;

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(join(here, "..", "spec", "manifest.schema.json"), "utf8")));
  if (!validate(manifest)) {
    throw new Error("manifest is invalid:\n" + ajv.errorsText(validate.errors, { separator: "\n  " }));
  }
  return { manifest, blobs: new Map([[entry, { bytes: wasm, type: "application/wasm" }]]) };
}

const FALLBACK = (name) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<h1>${name}</h1>
<p>This site is a Lattice application. Open it with Lattice Navigator, or any client that sends
<code>Accept: ${MANIFEST_TYPE}</code>.</p>
`;

export function createServer({ manifest, blobs }) {
  const cbor = Buffer.from(encode(manifest));
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://placeholder");
    const accept = String(req.headers.accept ?? "");

    res.setHeader("Vary", "Accept");
    res.setHeader("X-Content-Type-Options", "nosniff");

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

    const html = FALLBACK(manifest.name ?? manifest.app);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
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
  const app = loadApp({ appDir: a.app, domain: a.domain });
  createServer(app).listen(a.port, "127.0.0.1", () => {
    console.log(`lattice server for ${app.manifest.app} on http://127.0.0.1:${a.port}`);
    console.log(`  entry ${app.manifest.entry}`);
  });
}

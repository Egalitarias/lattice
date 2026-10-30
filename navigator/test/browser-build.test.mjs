// What the browser build depends on, checked in Node: the generated validators agree with the runtime ones, the
// browser-only strictness of fetchApp, and the server refusing schemas the shared interpreter cannot enforce.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import { checkManifest, checkApiDescription } from "../validators.mjs";
import { formatAjvErrors } from "../validators-format.mjs";
import { fetchApp, LoadError, MANIFEST_TYPE } from "../runtime.mjs";
import { encode } from "../../shared/cbor.mjs";
import { createRpc } from "../../server/rpc.mjs";
import { SchemaError } from "../../shared/schema.mjs";
import { loadApp } from "../../server/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const spec = join(repo, "spec");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
const close = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); });

// ---- The generated (browser) validators agree with the runtime (Node) ones ------------------------------

async function generated() {
  const ajv = new Ajv2020({ strict: false, allErrors: true, code: { source: true, esm: true } });
  addFormats(ajv);
  ajv.addSchema(json(join(spec, "manifest.schema.json")), "manifest");
  ajv.addSchema(json(join(spec, "api.schema.json")), "api");
  const dir = join(here, "..", "browser", "gen");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `validators-test-${process.pid}.mjs`);
  const bundled = join(dir, `validators-test-${process.pid}.bundle.mjs`);
  writeFileSync(file, standaloneCode(ajv, { checkManifest: "manifest", checkApi: "api" }));
  try {
    // Bundle it exactly as the browser build does (the generated code requires Ajv's small runtime helpers), then use the result.
    await build({ entryPoints: [file], outfile: bundled, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
    const m = await import(pathToFileURL(bundled).href);
    return {
      manifest: (d) => (m.checkManifest(d) ? null : formatAjvErrors(m.checkManifest.errors)),
      api: (d) => (m.checkApi(d) ? null : formatAjvErrors(m.checkApi.errors)),
    };
  } finally { rmSync(file, { force: true }); rmSync(bundled, { force: true }); }
}

/** Every way of breaking a document by one change: drop a key, or replace a value with the wrong kind of thing. */
function mutations(doc) {
  const out = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") return;
    for (const k of Object.keys(node)) {
      const at = [...path, k];
      const clone = (f) => { const c = structuredClone(doc); const parent = at.slice(0, -1).reduce((o, p) => o[p], c); f(parent, at.at(-1)); out.push(c); };
      clone((o, key) => delete o[key]);
      for (const wrong of [null, 7, "x", true, [], {}, "http://evil.example/", "sha256-short"]) clone((o, key) => { o[key] = wrong; });
      walk(node[k], at);
    }
  };
  walk(doc, []);
  return out;
}

test("the generated validators agree with the runtime ones on every example, fixture and mutation", async () => {
  const g = await generated();
  const docs = { manifest: [], api: [] };
  for (const f of readdirSync(join(repo, "examples"), { recursive: true })) {
    if (/node_modules|target/.test(f)) continue;
    if (/(^|[\\/])manifest\.json$/.test(f)) docs.manifest.push(json(join(repo, "examples", f)));
    if (/(^|[\\/])api\.json$/.test(f)) docs.api.push(json(join(repo, "examples", f)));
  }
  for (const f of readdirSync(join(spec, "tests", "invalid"))) {
    if (f.endsWith(".manifest.json")) docs.manifest.push(json(join(spec, "tests", "invalid", f)));
    if (f.endsWith(".api.json")) docs.api.push(json(join(spec, "tests", "invalid", f)));
  }
  assert.ok(docs.manifest.length >= 4 && docs.api.length >= 4, "found the fixtures");
  let compared = 0;
  for (const [kind, runtime, gen] of [["manifest", checkManifest, g.manifest], ["api", checkApiDescription, g.api]]) {
    for (const d of docs[kind]) {
      for (const v of [d, ...mutations(d)]) {
        compared++;
        assert.equal(gen(v), runtime(v), `${kind}: ${JSON.stringify(v).slice(0, 100)}`);
      }
    }
  }
  assert.ok(compared > 1000, `compared ${compared} documents`);
});

test("the generated validators use no eval", async () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true, code: { source: true, esm: true } });
  addFormats(ajv);
  ajv.addSchema(json(join(spec, "manifest.schema.json")), "manifest");
  ajv.addSchema(json(join(spec, "api.schema.json")), "api");
  const code = standaloneCode(ajv, { checkManifest: "manifest", checkApi: "api" });
  assert.doesNotMatch(code, /new Function|\beval\(/);
});

// ---- fetchApp: the browser requires the page's own domain -------------------------------------------------

test("fetchApp: a manifest naming another domain is refused when the domain must match the address", async () => {
  const app = await loadApp({ appDir: join(repo, "examples", "todo"), dev: true, log: () => {} });
  const manifest = Buffer.from(encode(app.manifest));
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/.lattice/blob/")) return void res.writeHead(200).end(app.blobs.get(app.manifest.entry).bytes);
    res.writeHead(200, { "Content-Type": MANIFEST_TYPE }).end(manifest);
  });
  const port = await listen(server);
  try {
    // Node development: fetched from a loopback address while the manifest names the app's domain. Accepted, with a warning.
    const lenient = await fetchApp(`http://127.0.0.1:${port}/`, { dev: true });
    assert.equal(lenient.manifest.app, "todo.localhost");
    // The browser Navigator: the page's own hostname is the only legitimate value.
    await assert.rejects(fetchApp(`http://127.0.0.1:${port}/`, { dev: true, strictDomain: true }), (e) => e instanceof LoadError && /manifest is for todo\.localhost but was served from 127\.0\.0\.1/.test(e.message));
    // And without development mode it never was accepted.
    await assert.rejects(fetchApp(`http://127.0.0.1:${port}/`), LoadError);
  } finally { await close(server); }
});

// ---- The server uses the same interpreter, and refuses what it cannot enforce --------------------------

test("the server refuses to start with an API schema the interpreter would not enforce", () => {
  const api = (schema) => ({ methods: { ping: { request: { type: "object", additionalProperties: false }, response: schema } } });
  const handlers = { ping: async () => ({}) };
  assert.doesNotThrow(() => createRpc({ apiDescription: api({ type: "object" }), apiHash: "h", handlers }));
  for (const bad of [{ type: "object", not: {} }, { type: "object", format: "email" }, { type: "object", patternProperties: { a: {} } }, { type: "object", properties: { a: { type: "string", pattern: "(a+)+$" } } }]) {
    assert.throws(() => createRpc({ apiDescription: api(bad), apiHash: "h", handlers }), SchemaError, JSON.stringify(bad));
  }
});

// Prototype Lattice origin.
//
//   GET <any path>  Accept: application/vnd.lattice.app+cbor  -> the app manifest (CBOR)
//   GET /.lattice/blob/<hash>                                  -> an immutable, content-addressed file
//   POST <api.url path>/<method>                               -> typed RPC (see spec/rpc.md)
//   GET /.well-known/lattice.json                              -> the manifest as JSON (discovery/debug)
//   GET <any path>  Accept: text/html (a browser)              -> the browser Navigator, if it has been built (spec/browser.md)
//   GET /.lattice/navigator/<file>                             -> the browser Navigator's own files
//   GET <any path>  (anything else)                            -> a plain HTML page for non-Lattice clients
//
// An app directory contains:
//   manifest.json                     required
//   target/wasm32-wasip2/release/*.wasm   the built component (exactly one)
//   api.json + api.mjs                optional: API description and its handlers. api.mjs exports either
//                                     `handlers`, or `setup({ manifest, oidc, dev, log })` returning
//                                     `{ handlers, http }` (setup also receives `stripe`: { secretKey, webhookSecret, api }) where http maps absolute paths to (req, res)
//                                     handlers (e.g. the manifest's auth.token_endpoint).
//
// Usage: node server.mjs --app ../examples/tasks [--port 8080] [--domain tasks.localhost]
//                        [--oidc <issuer>,<client_id>[,<client_secret>]]... [--dev]
//                        [--navigator-dist <dir> | --no-navigator]
//                        [--no-webtransport] [--wt-port n] [--wt-cert pem --wt-key pem]
//                        [--stripe-key sk_test_...] [--stripe-webhook-secret whsec_...] [--stripe-publishable-key pk_test_...] [--stripe-api http://127.0.0.1:9200]

import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { encode } from "../shared/cbor.mjs";
import { createRpc } from "./rpc.mjs";
import { memoryStore, openStore } from "./store.mjs";
import { createTopics } from "./topics.mjs";
import { startWebTransport, loadCertFiles } from "./webtransport.mjs";

export const MANIFEST_TYPE = "application/vnd.lattice.app+cbor";
const here = dirname(fileURLToPath(import.meta.url));

// ---- The browser Navigator ----------------------------------------------------------------------

const NAVIGATOR_PATH = "/.lattice/navigator/";
const TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".map": "application/json" };

/** Read the built browser Navigator (navigator/browser/dist), or null if it has not been built. */
export function loadNavigator(dir = resolve(here, "..", "navigator", "browser", "dist")) {
  if (!existsSync(join(dir, "bootstrap.html"))) return null;
  const files = new Map();
  for (const f of readdirSync(dir)) {
    const ext = f.slice(f.lastIndexOf("."));
    if (TYPES[ext]) files.set(f, { bytes: readFileSync(join(dir, f)), type: TYPES[ext] });
  }
  return { bootstrap: readFileSync(join(dir, "bootstrap.html")), files };
}

// A page that runs the host must be cross-origin isolated: the component's thread blocks on shared memory.
const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** The page's policy: scripts only from this origin, no eval, and workers only from this origin. */
const pageCsp = (dev) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src https: data:",
    "media-src https:",
    // Identity providers' discovery documents and declared analytics processors are fetched from the page.
    `connect-src 'self' https:${dev ? " http://127.0.0.1:* http://localhost:* http://*.localhost:*" : ""}`,
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

/**
 * The scripts that run in workers carry their own policy. The component's thread gets `connect-src 'none'`: it
 * cannot open a network connection at all, whatever the code in it tries. It needs blob: only to load the module the
 * host generated from the hash-verified component, and 'wasm-unsafe-eval' to compile that component's WebAssembly.
 */
const WORKER_CSP = {
  "component-worker.js": "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'none'",
  "transpile-worker.js": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'",
};

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

export async function loadApp({ appDir, domain, oidc = [], dev = false, stripe = null, data = null, log = console.error }) {
  const wasm = readFileSync(findComponent(appDir));
  const blobs = new Map();
  const entry = hashOf(wasm);
  blobs.set(entry, { bytes: wasm, type: "application/wasm" });

  // Where the host may call the processor with the publishable key (the card sheet): the stand-in when one is configured.
  if (stripe) stripe = { ...stripe, processorApi: stripe.processorApi ?? (stripe.api ? `${stripe.api.protocol}://${stripe.api.host}:${stripe.api.port}` : "https://api.stripe.com") };

  const manifest = { ...JSON.parse(readFileSync(join(appDir, "manifest.json"), "utf8")), entry };
  if (domain) manifest.app = domain;

  // OIDC providers come from server configuration and are advertised in the manifest.
  if (oidc.length) {
    manifest.auth = { ...manifest.auth, providers: [...(manifest.auth?.providers ?? [])] };
    for (const p of oidc) {
      manifest.auth.providers.push({ type: "oidc", issuer: p.issuer, client_id: p.clientId, scopes: ["openid", "profile"] });
    }
  }

  let rpc = null;
  let apiDescription = null;
  let topics = null;
  let rpcPath = null;
  let http = {};
  let impl = null;
  let store = null;
  const apiFile = join(appDir, "api.json");
  if (existsSync(apiFile)) {
    const apiBytes = readFileSync(apiFile);
    apiDescription = JSON.parse(apiBytes);
    schemaValidator("api.schema.json")(apiDescription, "api.json");
    const apiHash = hashOf(apiBytes);
    blobs.set(apiHash, { bytes: apiBytes, type: "application/json" });
    if (!manifest.api) throw new Error("api.json exists but manifest.json has no \"api\" section");
    manifest.api = { ...manifest.api, schema: apiHash };
    rpcPath = new URL(manifest.api.url).pathname.replace(/\/$/, "");
    const mod = await import(pathToFileURL(join(appDir, "api.mjs")).href);
    // Topics exist before setup, so handlers can publish to them; who may subscribe is decided by impl.authorizeTopic.
    topics = createTopics({ apiDescription, apiHash, authorize: (topic, ctx) => impl?.authorizeTopic?.(topic, ctx), log });
    store = data ? await openStore(data, { log }) : memoryStore();
    impl = mod.setup ? await mod.setup({ manifest, oidc, dev, stripe, log, topics, store }) : { handlers: mod.handlers, http: mod.http };
    http = impl.http ?? {};
    rpc = createRpc({ apiDescription, apiHash, handlers: impl.handlers, log });
  } else if (manifest.api) {
    throw new Error("manifest.json declares an \"api\" but there is no api.json");
  }

  schemaValidator("manifest.schema.json")(manifest, "manifest");
  return { manifest, blobs, rpc, rpcPath, http, impl, dev, topics, apiDescription, store };
}

/**
 * Offer the app's topics over WebTransport too, when the optional packages are installed: starts an HTTP/3 listener and
 * advertises it in the manifest (call before createServer, which freezes the manifest). Returns the listener or null.
 */
export async function attachWebTransport(app, { port = 0, cert, key, dev = false, log = console.error } = {}) {
  if (!app.topics || !app.manifest.api || !Object.keys(app.apiDescription?.topics ?? {}).length) return null;
  const wt = await startWebTransport({ topics: app.topics, port, publicHost: app.manifest.app, cert, key, dev, log });
  if (!wt) return null;
  app.manifest.api = { ...app.manifest.api, stream: wt.url, ...(wt.certHash ? { stream_cert_hash: wt.certHash } : {}) };
  schemaValidator("manifest.schema.json")(app.manifest, "manifest");
  return wt;
}

const FALLBACK = (name) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<h1>${name}</h1>
<p>This site is a Lattice application. Open it with Lattice Navigator, or any client that sends
<code>Accept: ${MANIFEST_TYPE}</code>.</p>
`;

export function createServer({ manifest, blobs, rpc, rpcPath, http: routes = {}, navigator = null, dev = false, topics = null }) {
  const cbor = Buffer.from(encode(manifest));
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://placeholder");
    const accept = String(req.headers.accept ?? "");

    res.setHeader("Vary", "Accept");
    res.setHeader("X-Content-Type-Options", "nosniff");

    // The browser Navigator's own files.
    if (navigator && url.pathname.startsWith(NAVIGATOR_PATH)) {
      const name = url.pathname.slice(NAVIGATOR_PATH.length);
      const f = req.method === "GET" ? navigator.files.get(name) : null;
      if (!f) return void res.writeHead(404).end();
      res.writeHead(200, {
        "Content-Type": f.type,
        "Content-Length": f.bytes.length,
        "Cache-Control": "no-cache",
        ...ISOLATION,
        ...(WORKER_CSP[name] ? { "Content-Security-Policy": WORKER_CSP[name] } : {}),
        ...(name === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      });
      return void res.end(f.bytes);
    }

    if (Object.hasOwn(routes, url.pathname)) {
      res.setHeader("Cache-Control", "no-store");
      return void routes[url.pathname](req, res);
    }

    if (topics && url.pathname.startsWith(`${rpcPath}/_topics/`)) {
      res.setHeader("Cache-Control", "no-store");
      return void topics.handle(req, res, url.pathname.slice(rpcPath.length + 9));
    }

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

    // A browser: give it the host that runs this app, served by the app's own origin.
    if (navigator && req.method === "GET" && accept.includes("text/html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": navigator.bootstrap.length,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": pageCsp(dev),
        "Referrer-Policy": "no-referrer",
        ...ISOLATION,
      });
      return void res.end(navigator.bootstrap);
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(FALLBACK(manifest.name ?? manifest.app));
  });
}

function args(argv) {
  const out = { port: 8080, app: resolve(here, "..", "examples", "todo"), domain: undefined, oidc: [], dev: false, stripe: null, navigatorDist: undefined, noNavigator: false, wt: true, wtPort: 0, wtCert: undefined, wtKey: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--app") out.app = resolve(argv[++i]);
    else if (argv[i] === "--domain") out.domain = argv[++i];
    else if (argv[i] === "--dev") out.dev = true;
    else if (argv[i] === "--data") out.data = resolve(argv[++i]);
    else if (argv[i] === "--navigator-dist") out.navigatorDist = resolve(argv[++i]);
    else if (argv[i] === "--no-navigator") out.noNavigator = true;
    else if (argv[i] === "--no-webtransport") out.wt = false;
    else if (argv[i] === "--wt-port") out.wtPort = Number(argv[++i]);
    else if (argv[i] === "--wt-cert") out.wtCert = resolve(argv[++i]);
    else if (argv[i] === "--wt-key") out.wtKey = resolve(argv[++i]);
    else if (argv[i] === "--stripe-key") (out.stripe ??= {}).secretKey = argv[++i];
    else if (argv[i] === "--stripe-webhook-secret") (out.stripe ??= {}).webhookSecret = argv[++i];
    else if (argv[i] === "--stripe-publishable-key") (out.stripe ??= {}).publishableKey = argv[++i];
    else if (argv[i] === "--stripe-api") {
      // Point the Stripe client at a stand-in (development). Real Stripe needs no override.
      const u = new URL(argv[++i]);
      (out.stripe ??= {}).api = { protocol: u.protocol.replace(":", ""), host: u.hostname, port: Number(u.port) };
    }
    else if (argv[i] === "--oidc") {
      const [issuer, clientId, clientSecret] = argv[++i].split(",");
      out.oidc.push({ issuer, clientId, clientSecret });
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = args(process.argv.slice(2));
  const app = await loadApp({ appDir: a.app, domain: a.domain, oidc: a.oidc, dev: a.dev, stripe: a.stripe, data: a.data });
  const navigator = a.noNavigator ? null : loadNavigator(a.navigatorDist);
  // Topics over WebTransport as well, if the app has any and the optional packages are installed. A real deployment
  // supplies a certificate; --dev makes a throwaway one that the manifest tells development hosts how to pin.
  let wt = null;
  if (a.wt && (a.dev || (a.wtCert && a.wtKey))) {
    wt = await attachWebTransport(app, { port: a.wtPort, dev: a.dev, ...(a.wtCert ? loadCertFiles(a.wtCert, a.wtKey) : {}) });
  }
  createServer({ ...app, navigator }).listen(a.port, "127.0.0.1", () => {
    console.log(`lattice server for ${app.manifest.app} on http://127.0.0.1:${a.port}`);
    console.log(`  entry ${app.manifest.entry}`);
    if (app.manifest.api) console.log(`  api   ${app.manifest.api.schema} at ${app.rpcPath}/<method>`);
    if (app.manifest.api) console.log(a.data ? `  data  ${a.data}` : "  data  in memory, lost on exit (--data <file> keeps it)");
    if (Object.keys(app.apiDescription?.topics ?? {}).length) console.log(wt ? `  webtransport: ${wt.url} (udp ${wt.port})` : "  webtransport: not offered (topics use streaming HTTPS)");
    console.log(navigator ? "  browser navigator: serving it to browsers" : "  browser navigator: not built (run: cd navigator && npm run build:browser)");
  });
}

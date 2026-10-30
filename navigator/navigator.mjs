// Lattice Navigator for Node.
//
//   node navigator.mjs <url> [--dev] [--port 7070] [--data .navigator]
//
// Discovers and verifies the app at <url>, runs its WASM component, and serves a local, semantic UI projection of
// its scene tree to a browser on this machine. The logic is in controller.mjs, shared with the browser build; this file
// is the Node environment around it: a profile on disk, worker threads, and an HTTP server with the checks a local server
// needs. The app's code never runs in the browser: the page is a renderer that receives a validated tree and sends back
// only {node, event, values}.

import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchApp, LoadError } from "./runtime.mjs";
import { prepareComponent } from "./runtime-node.mjs";
import { Controller, HttpError, Session } from "./controller.mjs";
import { FileKv } from "./kv-node.mjs";
import { nodeSpawn } from "./spawn-node.mjs";

export { Session, HttpError };

const here = dirname(fileURLToPath(import.meta.url));

// ---- HTTP -------------------------------------------------------------------------------------

const STATIC = {
  "/_navigator/ui.js": ["ui/ui-http.js", "text/javascript; charset=utf-8"],
  "/_navigator/ui-core.js": ["ui/ui-core.js", "text/javascript; charset=utf-8"],
  "/_navigator/ui.css": ["ui/ui.css", "text/css; charset=utf-8"],
};
const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src https: data:",
  "media-src https:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

async function readJson(req, max = 64 * 1024) {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "expected application/json");
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HttpError(413, "request too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

const CALLBACK_PAGE = (message) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lattice Navigator</title><body><main><h1>Lattice Navigator</h1><p>${message}</p></main>`;

export async function startNavigator({ url, dev = false, port = 7070, dataDir = join(here, ".navigator"), cacheDir = join(dataDir, "cache"), log = defaultLog, watchdogMs, rpcTimeoutMs, authTimeoutMs, analyticsOptions = {} }) {
  const { url: appUrl, wasm, ...app } = await fetchApp(url, { dev });
  const entryJs = await prepareComponent({ manifest: app.manifest, wasm, cacheDir });
  const domain = app.manifest.app;

  // The page the user is looking at is served from the app's own domain when that is a *.localhost
  // name, so a browser accepts it as the relying party for passkeys. Otherwise from 127.0.0.1. (The browser build,
  // which is served by the app's origin itself, has no such restriction.)
  const uiHost = domain.endsWith(".localhost") ? domain : "127.0.0.1";
  let boundPort;
  const uiOrigin = () => `http://${uiHost}:${boundPort}`;

  const controller = new Controller({
    app, kv: new FileKv(join(dataDir, "kv")), spawn: nodeSpawn, component: { entryJs }, uiOrigin,
    dev, log, watchdogMs, rpcTimeoutMs, authTimeoutMs, analyticsOptions,
  });
  await controller.start(appUrl.pathname || "/");

  // Browser windows connected to this Navigator.
  const clients = new Set();
  const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  controller.subscribe((msg) => clients.forEach((c) => send(c, msg)));

  const ok = (res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `${uiHost}:${boundPort}`]);
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) throw new HttpError(421, "wrong host");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");

      if (req.method === "GET" && STATIC[u.pathname]) {
        const [file, type] = STATIC[u.pathname];
        res.writeHead(200, { "Content-Type": type });
        return void res.end(readFileSync(join(here, file)));
      }

      if (req.method === "GET" && u.pathname === "/_navigator/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return void send(res, controller.current());
      }

      if (req.method === "GET" && u.pathname === "/_navigator/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify(controller.current()));
      }

      // The identity provider / payment processor sends the user's browser back here. There is no X-Navigator header on
      // a redirect; the single-use `state` value is what binds the request to one pending interaction.
      const callback =
        req.method === "GET" && u.pathname === "/_navigator/auth/callback" ? () => controller.authCallback(u.searchParams)
        : req.method === "GET" && u.pathname === "/_navigator/payment/return" ? () => controller.paymentCallback("return", u.searchParams)
        : req.method === "GET" && u.pathname === "/_navigator/payment/cancel" ? () => controller.paymentCallback("cancel", u.searchParams)
        : null;
      if (callback) {
        const r = callback();
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-store" });
        return void res.end(CALLBACK_PAGE(r.message));
      }

      if (req.method === "POST" && u.pathname.startsWith("/_navigator/")) {
        // Custom header forces a CORS preflight, which cross-site pages cannot pass.
        if (req.headers["x-navigator"] !== "1") throw new HttpError(403, "missing X-Navigator header");
        const fromOrigin = req.headers.origin;
        if (fromOrigin && !allowedHosts.has(new URL(fromOrigin).host)) throw new HttpError(403, "cross-origin request");
        const endpoint = u.pathname.slice("/_navigator/".length);
        const body = await readJson(req, endpoint === "auth/result" ? 256 * 1024 : undefined);
        await controller.handle(endpoint, body);
        return ok(res);
      }

      // Any other GET is an app URL: serve the renderer shell. It asks Lattice Navigator to route location.pathname.
      if (req.method === "GET" && (req.headers.accept ?? "").includes("text/html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": SHELL_CSP });
        return void res.end(readFileSync(join(here, "ui", "index.html")));
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log("error", e.stack ?? String(e));
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : "internal error" }));
    }
  });

  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  boundPort = server.address().port;
  return {
    port: boundPort,
    uiOrigin: uiOrigin(),
    controller,
    manifest: controller.manifest,
    session: controller.session,
    host: controller.host,
    auth: controller.auth,
    payments: controller.payments,
    prompts: controller.prompts,
    sessionStore: controller.sessionStore,
    analytics: controller.analytics,
    close: async () => {
      await controller.close();
      await new Promise((done) => { clients.forEach((c) => c.end()); server.close(done); server.closeAllConnections?.(); });
    },
  };
}

function defaultLog(level, message) {
  const line = `[app ${level}] ${message}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

// ---- CLI --------------------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opts = { url: undefined, dev: false, port: 7070, dataDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dev") opts.dev = true;
    else if (argv[i] === "--port") opts.port = Number(argv[++i]);
    else if (argv[i] === "--data") opts.dataDir = resolve(argv[++i]);
    else opts.url = argv[i];
  }
  if (!opts.url) {
    console.error("usage: node navigator.mjs <url> [--dev] [--port 7070] [--data dir]");
    process.exit(2);
  }
  try {
    const nav = await startNavigator(opts);
    console.log(`navigator: running ${nav.manifest.name ?? nav.manifest.app} (${nav.manifest.entry})`);
    console.log(`navigator: open ${nav.uiOrigin}${new URL(opts.url).pathname}`);
  } catch (e) {
    if (e instanceof LoadError) {
      console.error(`navigator: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

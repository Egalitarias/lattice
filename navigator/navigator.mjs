// Lattice Navigator: prototype Lattice host.
//
//   node navigator.mjs <url> [--dev] [--port 7070] [--data .navigator]
//
// Lattice Navigator discovers and verifies the app at <url>, runs its WASM component, and serves a local,
// semantic UI projection of the scene tree. The app's code never runs in the browser: the page is
// a renderer that receives a validated tree and sends back only {node, event, values}.

import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchApp, instantiateApp, LoadError } from "./runtime.mjs";
import { SceneStore, SceneError, toArgs, argsObject } from "./scene.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ---- Routing ----------------------------------------------------------------------------------

function compileRoutes(routes) {
  return Object.entries(routes)
    .map(([pattern, handler]) => {
      const names = [];
      const re = pattern
        .split("/")
        .map((seg) => {
          const m = seg.match(/^\{([a-z][A-Za-z0-9_]*)(\*?)\}$/);
          if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          names.push(m[1]);
          return m[2] ? "(.*)" : "([^/]+)";
        })
        .join("/");
      return { handler, names, re: new RegExp(`^${re}$`), literal: names.length === 0 };
    })
    .sort((a, b) => Number(b.literal) - Number(a.literal));
}

function matchRoute(compiled, pathname) {
  for (const r of compiled) {
    const m = r.re.exec(pathname);
    if (m) {
      const params = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
  }
  return null;
}

// ---- Errors from the component ----------------------------------------------------------------

/** jco throws ComponentError with the WIT error in .payload. */
function appFailure(e) {
  const p = e?.payload;
  if (p && typeof p === "object" && typeof p.tag === "string") {
    switch (p.tag) {
      case "invalid": return { status: 422, message: p.val };
      case "not-found": return { status: 404, message: "That page does not exist." };
      case "unauthorized": return { status: 401, message: "Please sign in to continue." };
      case "forbidden": return { status: 403, message: "You are not allowed to do that." };
      default: return { status: 500, message: "The app hit an error.", detail: p.val };
    }
  }
  return null;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- The session ------------------------------------------------------------------------------

class Session {
  store = new SceneStore();
  path = "/";
  #chain = Promise.resolve();
  constructor(lifecycle, manifest, origin, log) {
    this.lifecycle = lifecycle;
    this.routes = compileRoutes(manifest.routes);
    this.origin = origin;
    this.log = log;
  }

  /** Calls into the component are serialised, as the contract requires. */
  serial(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #call(fn) {
    try {
      return fn();
    } catch (e) {
      const f = appFailure(e);
      if (!f) throw e;
      if (f.detail) this.log("error", `app error: ${f.detail}`);
      throw new HttpError(f.status, f.message);
    }
  }

  init(manifest) {
    return this.serial(() =>
      this.#call(() =>
        this.lifecycle.init({
          origin: this.origin,
          locale: "en-US",
          colorScheme: "light",
          reducedMotion: false,
          textScale: 1,
          online: true,
          granted: [...(manifest.capabilities?.requires ?? []), ...(manifest.capabilities?.optional ?? [])],
        })
      )
    );
  }

  route(rawPath) {
    return this.serial(() =>
      this.#call(() => {
        const u = new URL(rawPath, "http://x");
        const m = matchRoute(this.routes, u.pathname);
        if (!m) throw new HttpError(404, "That page does not exist.");
        const scene = this.lifecycle.route({
          handler: m.handler,
          path: u.pathname,
          params: toArgs(m.params),
          query: toArgs(Object.fromEntries(u.searchParams)),
        });
        try {
          this.store.load(scene);
        } catch (e) {
          if (e instanceof SceneError) throw new HttpError(500, `The app returned an invalid scene: ${e.message}`);
          throw e;
        }
        this.path = u.pathname;
        return {};
      })
    );
  }

  act(source, event, values) {
    return this.serial(() =>
      this.#call(() => {
        const field = { press: "onPress", submit: "onSubmit", change: "onChange" }[event];
        if (!field) throw new HttpError(400, "unknown event");
        const ref = this.store.actionRef(source, field);
        if (!ref) throw new HttpError(400, "that control has no such action");

        // Only the node's own fields, or fields of its form, may be submitted.
        const allowed = this.store.formFields(source);
        const own = this.store.get(source)?.body.val?.name;
        if (own) allowed.add(own);
        for (const k of Object.keys(values)) {
          if (!allowed.has(k)) throw new HttpError(400, `unexpected field ${k}`);
        }

        const update = this.lifecycle.dispatch({
          action: ref.action,
          args: ref.args,
          source,
          values: toArgs(values),
          input: undefined,
        });
        try {
          this.store.apply(update);
        } catch (e) {
          if (e instanceof SceneError) throw new HttpError(500, `The app returned an invalid update: ${e.message}`);
          throw e;
        }
        return { focus: update.focus };
      })
    );
  }

  snapshot(focus) {
    const s = this.store;
    return { kind: "scene", path: this.path, title: s.title, lang: s.lang, live: s.live, focus, tree: s.tree() };
  }
}

// ---- HTTP -------------------------------------------------------------------------------------

const STATIC = {
  "/_navigator/ui.js": ["ui/ui.js", "text/javascript; charset=utf-8"],
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

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "expected application/json");
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, "request too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export async function startNavigator({ url, dev = false, port = 7070, dataDir = join(here, ".navigator"), log = defaultLog }) {
  const cacheDir = join(dataDir, "cache");
  const { url: appUrl, manifest, wasm } = await fetchApp(url, { dev, cacheDir });
  const origin = manifest.app;
  const lifecycle = await instantiateApp({ manifest, wasm, origin, dataDir: join(dataDir, "data"), cacheDir, onLog: log });
  const session = new Session(lifecycle, manifest, origin, log);
  await session.init(manifest);

  const startPath = appUrl.pathname || "/";
  let lastError = null;
  try {
    await session.route(startPath);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    lastError = e.message;
    if (startPath !== "/") await session.route("/").then(() => (lastError = null)).catch(() => {});
  }

  const clients = new Set();
  const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  const broadcast = (msg) => clients.forEach((c) => send(c, msg));
  const current = (focus) => (lastError && !session.store.root ? { kind: "error", message: lastError } : session.snapshot(focus));

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const allowedHosts = new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`]);
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
        return void send(res, current());
      }

      if (req.method === "GET" && u.pathname === "/_navigator/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify(current()));
      }

      if (req.method === "POST" && u.pathname.startsWith("/_navigator/")) {
        // Custom header forces a CORS preflight, which cross-site pages cannot pass.
        if (req.headers["x-navigator"] !== "1") throw new HttpError(403, "missing X-Navigator header");
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(new URL(origin).host)) throw new HttpError(403, "cross-origin request");
        const body = await readJson(req);

        if (u.pathname === "/_navigator/route") {
          if (typeof body.path !== "string" || !body.path.startsWith("/")) throw new HttpError(400, "bad path");
          try {
            await session.route(body.path);
            lastError = null;
            broadcast(session.snapshot());
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            broadcast({ kind: "notice", message: e.message });
            throw e;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          return void res.end("{}");
        }

        if (u.pathname === "/_navigator/act") {
          const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
          for (const v of Object.values(values)) {
            if (!["string", "number", "boolean"].includes(typeof v)) throw new HttpError(400, "bad value");
          }
          if (!Number.isInteger(body.source)) throw new HttpError(400, "bad source");
          try {
            const { focus } = await session.act(body.source, String(body.event), values);
            broadcast(session.snapshot(focus));
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            broadcast({ kind: "notice", message: e.message });
            throw e;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          return void res.end("{}");
        }
        throw new HttpError(404, "no such endpoint");
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

  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return {
    port: server.address().port,
    manifest,
    session,
    close: () => new Promise((ok) => { clients.forEach((c) => c.end()); server.close(ok); server.closeAllConnections?.(); }),
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
    console.log(`navigator: open http://127.0.0.1:${nav.port}${new URL(opts.url).pathname}`);
  } catch (e) {
    if (e instanceof LoadError) {
      console.error(`navigator: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

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
import { fetchApp, prepareComponent, LoadError } from "./runtime.mjs";
import { AppHost, HostCrash, LinkFailure } from "./apphost.mjs";
import { RpcClient, SessionStore } from "./rpc.mjs";
import { AuthBroker } from "./auth.mjs";
import { PaymentBroker } from "./payments.mjs";
import { Prompts } from "./prompts.mjs";
import { CAPABILITY_IMPORTS } from "./host.mjs";
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
  constructor(host, manifest, origin, log) {
    this.host = host;
    this.manifest = manifest;
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

  /** Run a call into the component, translating its failures into HttpErrors. */
  async #call(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof HostCrash) {
        this.log("error", `component stopped: ${e.message}`);
        await this.#recover();
        throw new HttpError(504, "The app stopped responding and was restarted.");
      }
      const f = appFailure(e);
      if (!f) throw e;
      if (f.detail) this.log("error", `app error: ${f.detail}`);
      throw new HttpError(f.status, f.message);
    }
  }

  /** The worker was killed or died: start a fresh instance and show the current page again. */
  async #recover() {
    try {
      await this.host.restart();
      await this.#init();
      await this.#route(this.path);
    } catch (e) {
      this.log("error", `could not restart the app: ${e.message}`);
    }
  }

  #init() {
    return this.host.call("init", {
      origin: this.origin,
      locale: "en-US",
      colorScheme: "light",
      reducedMotion: false,
      textScale: 1,
      online: true,
      granted: [...(this.manifest.capabilities?.requires ?? []), ...(this.manifest.capabilities?.optional ?? [])],
      oidcIssuers: (this.manifest.auth?.providers ?? []).filter((p) => p.type === "oidc").map((p) => p.issuer),
    });
  }

  async #route(rawPath) {
    const u = new URL(rawPath, "http://x");
    const m = matchRoute(this.routes, u.pathname);
    if (!m) throw new HttpError(404, "That page does not exist.");
    const scene = await this.host.call("route", {
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
  }

  init() {
    return this.serial(() => this.#call(() => this.#init()));
  }

  route(rawPath) {
    return this.serial(() => this.#call(() => this.#route(rawPath)));
  }

  act(source, event, values) {
    return this.serial(() =>
      this.#call(async () => {
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

        const update = await this.host.call("dispatch", {
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

  /** Deliver a host-initiated event (not a reply to an app call) and apply the app's update. */
  event(event) {
    return this.serial(() =>
      this.#call(async () => {
        const update = await this.host.call("onEvent", event);
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

export async function startNavigator({ url, dev = false, port = 7070, dataDir = join(here, ".navigator"), cacheDir = join(dataDir, "cache"), log = defaultLog, watchdogMs, rpcTimeoutMs, authTimeoutMs }) {
  const { url: appUrl, manifest, wasm, api, tokenEndpoint, paymentsEndpoint } = await fetchApp(url, { dev });
  const domain = manifest.app;
  const entryJs = await prepareComponent({ manifest, wasm, cacheDir });

  const granted = new Set([...(manifest.capabilities?.requires ?? []), ...(manifest.capabilities?.optional ?? [])]);
  const wantsAuth = ["session", "auth.oidc", "auth.passkey", "payments.request"].some((c) => granted.has(c));

  // Browser windows connected to this Navigator.
  const clients = new Set();
  const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  const broadcast = (msg) => clients.forEach((c) => send(c, msg));

  // The page the user is looking at is served from the app's own domain when that is a *.localhost
  // name, so a browser accepts it as the relying party for passkeys. Otherwise from 127.0.0.1.
  const uiHost = domain.endsWith(".localhost") ? domain : "127.0.0.1";
  let boundPort;
  const uiOrigin = () => `http://${uiHost}:${boundPort}`;

  const sessionStore = wantsAuth ? new SessionStore(dataDir, domain) : null;
  // Everything the user is asked (sign-in, payment) goes through one prompt manager.
  const prompts = new Prompts({ broadcast, app: { name: manifest.name ?? domain, domain }, timeoutMs: authTimeoutMs });
  const auth = sessionStore ? new AuthBroker({ manifest, tokenEndpoint, session: sessionStore, uiOrigin, prompts, dev }) : null;
  const payments = sessionStore && manifest.payments
    ? new PaymentBroker({ manifest, endpoint: paymentsEndpoint, session: sessionStore, uiOrigin, prompts, dev, timeoutMs: authTimeoutMs })
    : null;
  const rpc = api
    ? new RpcClient({
        endpoint: api.endpoint,
        description: api.description,
        apiHash: api.hash,
        session: granted.has("session") ? sessionStore : null,
        timeoutMs: rpcTimeoutMs,
      })
    : null;

  const host = new AppHost({ entryJs, granted, origin: domain, dataDir: join(dataDir, "data"), rpc, session: granted.has("session") ? sessionStore : null, auth, payments, onLog: log, watchdogMs });
  try {
    await host.start();
  } catch (e) {
    if (e instanceof LinkFailure) {
      throw new LoadError(
        `component could not be linked: ${e.message}. It likely imports a capability that the manifest does not request ` +
          `or that this Lattice Navigator does not implement. Implemented imports: ${Object.keys(CAPABILITY_IMPORTS).join(", ")}`
      );
    }
    throw e;
  }
  const session = new Session(host, manifest, domain, log);
  await session.init();

  const startPath = appUrl.pathname || "/";
  let lastError = null;
  try {
    await session.route(startPath);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    lastError = e.message;
    if (startPath !== "/") await session.route("/").then(() => (lastError = null)).catch(() => {});
  }

  /** What the host itself draws around the app: who the page belongs to and who is signed in. */
  const chrome = () => {
    const i = sessionStore?.info();
    return {
      app: { name: manifest.name ?? domain, domain },
      session: i ? { signedIn: i.signedIn, name: i.name ?? null } : null,
      prompts: prompts.list(),
    };
  };
  const snap = (focus) => ({ ...session.snapshot(focus), chrome: chrome() });
  const current = (focus) => (lastError && !session.store.root ? { kind: "error", message: lastError, chrome: chrome() } : snap(focus));

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
        return void send(res, current());
      }

      if (req.method === "GET" && u.pathname === "/_navigator/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify(current()));
      }

      // The identity provider sends the user's browser back here. There is no X-Navigator header on a
      // redirect; the single-use `state` value is what binds this request to one pending sign-in.
      if (req.method === "GET" && u.pathname === "/_navigator/auth/callback" && auth) {
        const r = auth.callback(u.searchParams);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-store" });
        return void res.end(CALLBACK_PAGE(r.message));
      }

      // The payment processor sends the user's browser back here (success_url / cancel_url, which the host
      // itself chose). As with sign-in, only the single-use `state` binds it to a pending request.
      if (req.method === "GET" && (u.pathname === "/_navigator/payment/return" || u.pathname === "/_navigator/payment/cancel") && payments) {
        const r = payments.callback(u.pathname.endsWith("/return") ? "return" : "cancel", u.searchParams);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-store" });
        return void res.end(CALLBACK_PAGE(r.message));
      }

      if (req.method === "POST" && u.pathname.startsWith("/_navigator/")) {
        // Custom header forces a CORS preflight, which cross-site pages cannot pass.
        if (req.headers["x-navigator"] !== "1") throw new HttpError(403, "missing X-Navigator header");
        const fromOrigin = req.headers.origin;
        if (fromOrigin && !allowedHosts.has(new URL(fromOrigin).host)) throw new HttpError(403, "cross-origin request");
        const body = await readJson(req, u.pathname === "/_navigator/auth/result" ? 256 * 1024 : undefined);

        if (u.pathname === "/_navigator/route") {
          if (typeof body.path !== "string" || !body.path.startsWith("/")) throw new HttpError(400, "bad path");
          try {
            await session.route(body.path);
            lastError = null;
            broadcast(snap());
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            broadcast({ kind: "notice", message: e.message });
            throw e;
          }
          return ok(res);
        }

        if (u.pathname === "/_navigator/act") {
          const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
          for (const v of Object.values(values)) {
            if (!["string", "number", "boolean"].includes(typeof v)) throw new HttpError(400, "bad value");
          }
          if (!Number.isInteger(body.source)) throw new HttpError(400, "bad source");
          try {
            const { focus } = await session.act(body.source, String(body.event), values);
            broadcast(snap(focus));
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            broadcast({ kind: "notice", message: e.message });
            throw e;
          }
          return ok(res);
        }

        // The user's answer to a host-drawn passkey prompt, or a cancel.
        if (u.pathname === "/_navigator/auth/result" && auth) {
          if (typeof body.id !== "string") throw new HttpError(400, "bad id");
          if (!auth.finishPasskey(body.id, body)) throw new HttpError(404, "no such sign-in request");
          return ok(res);
        }
        // Cancel any pending prompt (sign-in or payment). The older path is kept as an alias.
        if (u.pathname === "/_navigator/prompt/cancel" || u.pathname === "/_navigator/auth/cancel") {
          if (typeof body.id !== "string") throw new HttpError(400, "bad id");
          prompts.cancel(body.id);
          return ok(res);
        }

        // Sign out, from the host's own chrome. The app is told afterwards and updates itself.
        if (u.pathname === "/_navigator/signout" && auth) {
          try {
            await auth.signOut();
            const i = sessionStore.info();
            await session.event({ tag: "session-changed", val: { signedIn: i.signedIn, subject: i.subject, expiresAt: undefined } });
            broadcast(snap());
          } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            broadcast({ kind: "notice", message: e.message });
            throw e;
          }
          return ok(res);
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

  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  boundPort = server.address().port;
  return {
    port: boundPort,
    uiOrigin: uiOrigin(),
    manifest,
    session,
    host,
    auth,
    payments,
    prompts,
    sessionStore,
    close: () => new Promise((done) => { prompts.dispose(); host.kill(); clients.forEach((c) => c.end()); server.close(done); server.closeAllConnections?.(); }),
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

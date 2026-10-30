// The Navigator's core, independent of where it runs (Node, a browser): routing, the Session that drives the
// component, and the Controller that wires the brokers and answers the user's window.

import { SceneStore, SceneError, toArgs } from "./scene.mjs";
import { AppHost, HostCrash, LinkFailure } from "./apphost.mjs";
import { RpcClient, SessionStore } from "./rpc.mjs";
import { StreamClient } from "./stream.mjs";
import { AuthBroker } from "./auth.mjs";
import { PaymentBroker } from "./payments.mjs";
import { Prompts } from "./prompts.mjs";
import { Analytics } from "./analytics.mjs";
import { AppStorage } from "./storage.mjs";
import { CAPABILITY_IMPORTS } from "./host.mjs";
import { LoadError } from "./runtime.mjs";
import { SchemaError } from "../shared/schema.mjs";

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

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- The session ------------------------------------------------------------------------------

export class Session {
  store = new SceneStore();
  path = "/";
  #chain = Promise.resolve();
  constructor(host, manifest, origin, log, analytics = null) {
    this.analytics = analytics;
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
        this.analytics?.host("error", "host.crash", { detail: e.message });
        await this.#recover();
        throw new HttpError(504, "The app stopped responding and was restarted.");
      }
      const f = appFailure(e);
      if (!f) throw e;
      if (f.detail) {
        this.log("error", `app error: ${f.detail}`);
        this.analytics?.host("error", "app.internal", { detail: f.detail });
      }
      throw new HttpError(f.status, f.message);
    }
  }

  /** The worker was killed or died: start a fresh instance and show the current page again. */
  async #recover() {
    if (this.host.closed) return;
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
    const t0 = performance.now();
    const scene = await this.host.call("route", {
      handler: m.handler,
      path: u.pathname,
      params: toArgs(m.params),
      query: toArgs(Object.fromEntries(u.searchParams)),
    });
    try {
      this.store.load(scene);
    } catch (e) {
      if (e instanceof SceneError) {
        this.analytics?.host("error", "host.invalid_scene", { detail: e.message });
        throw new HttpError(500, `The app returned an invalid scene: ${e.message}`);
      }
      throw e;
    }
    this.analytics?.host("performance", "host.route", { handler: m.handler, ms: performance.now() - t0 });
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

        // Remember what the user typed into sensitive fields, so it can be scrubbed from anything sent.
        const sensitive = this.store.sensitiveFields(source);
        this.analytics?.noteSensitive(Object.entries(values).filter(([k]) => sensitive.has(k)).map(([, v]) => v));

        const t0 = performance.now();
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
          if (e instanceof SceneError) {
            this.analytics?.host("error", "host.invalid_scene", { detail: e.message });
            throw new HttpError(500, `The app returned an invalid update: ${e.message}`);
          }
          throw e;
        }
        this.analytics?.host("performance", "host.action", { action: ref.action, ms: performance.now() - t0 });
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

// ---- The controller ---------------------------------------------------------------------------
// Everything a Navigator does that is not about the environment it runs in: it wires the brokers, runs the
// component through a Session, builds the host chrome, and answers the requests the user's window sends. A Node
// process puts an HTTP server in front of it; a browser calls it directly. Same logic, same checks.

const defaultLogger = () => {};
const MAX_PUSHED_QUEUE = 64;

export class Controller {
  #listeners = new Set();
  lastError = null;

  /**
   * @param app           what fetchApp returned (without the component bytes)
   * @param kv            the profile's store
   * @param spawn         (workerData) => component thread handle
   * @param component     what the thread needs to load the transpiled component
   * @param uiOrigin      () => the origin the user's window is on (redirect URIs are built from it)
   */
  constructor({ app, kv, spawn, component, uiOrigin, dev = false, log = defaultLogger, watchdogMs, streamBackoffMs, rpcTimeoutMs, authTimeoutMs, analyticsOptions = {}, fetchImpl }) {
    Object.assign(this, { app, kv, spawn, component, uiOrigin, dev, log, watchdogMs, streamBackoffMs, rpcTimeoutMs, authTimeoutMs, analyticsOptions, fetchImpl });
    this.manifest = app.manifest;
    this.domain = app.manifest.app;
  }

  /** Messages for the window: scenes, notices, prompts, chrome updates. Returns an unsubscribe function. */
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #pushQueue = [];
  #pushing = false;

  #emit(msg) {
    for (const fn of this.#listeners) {
      try { fn(msg); } catch { /* one bad listener must not stop the others */ }
    }
  }

  async start(startPath = "/") {
    const { manifest, api, tokenEndpoint, paymentsEndpoint, analyticsProcessors } = this.app;
    const { domain, kv, log, dev } = this;
    const granted = new Set([...(manifest.capabilities?.requires ?? []), ...(manifest.capabilities?.optional ?? [])]);
    const wantsAuth = ["session", "auth.oidc", "auth.passkey", "payments.request"].some((c) => granted.has(c));
    const fetchOpt = this.fetchImpl ? { fetchImpl: this.fetchImpl } : {};

    // Everything the profile remembers (session, analytics choices, app storage) lives in the one kv.
    this.sessionStore = wantsAuth ? new SessionStore(kv, domain) : null;

    // Everything the user is asked (sign-in, payment) goes through one prompt manager.
    this.prompts = new Prompts({ broadcast: (m) => this.#emit(m), app: { name: manifest.name ?? domain, domain }, timeoutMs: this.authTimeoutMs });
    this.auth = this.sessionStore ? new AuthBroker({ manifest, tokenEndpoint, session: this.sessionStore, uiOrigin: this.uiOrigin, prompts: this.prompts, dev, ...fetchOpt }) : null;
    this.payments = this.sessionStore && manifest.payments
      ? new PaymentBroker({ manifest, endpoint: paymentsEndpoint, session: this.sessionStore, uiOrigin: this.uiOrigin, prompts: this.prompts, dev, timeoutMs: this.authTimeoutMs, ...fetchOpt })
      : null;

    let rpc = null;
    if (api) {
      try {
        rpc = new RpcClient({
          endpoint: api.endpoint,
          description: api.description,
          apiHash: api.hash,
          session: granted.has("session") ? this.sessionStore : null,
          timeoutMs: this.rpcTimeoutMs,
        });
      } catch (e) {
        if (e instanceof SchemaError) throw new LoadError(`the API description uses a schema feature this Navigator will not enforce, so it will not run the app: ${e.message}`);
        throw e;
      }
    }

    // Server push: only for an app that holds net.realtime and whose API description declares topics.
    const stream = rpc && granted.has("net.realtime") && api.description.topics
      ? new StreamClient({
          endpoint: api.endpoint,
          description: api.description,
          apiHash: api.hash,
          session: granted.has("session") ? this.sessionStore : null,
          onMessage: (topic, payload) => this.#pushed(topic, payload),
          onProblem: (topic, why) => log("warn", `topic ${topic}: ${why}`),
          backoffMs: this.streamBackoffMs,
          ...fetchOpt,
        })
      : null;

    // Analytics policy lives in the manifest; the user's level lives in this profile. Without declared
    // processors there is nothing to configure and nothing is ever sent.
    this.analytics = analyticsProcessors ? new Analytics({ manifest, processors: analyticsProcessors, kv, dev, log, ...this.analyticsOptions }) : null;

    this.host = new AppHost({
      spawn: this.spawn,
      component: this.component,
      granted,
      rpc,
      stream,
      session: granted.has("session") ? this.sessionStore : null,
      auth: this.auth,
      payments: this.payments,
      analytics: this.analytics,
      storage: ["storage.local", "storage.sync"].some((c) => granted.has(c)) ? new AppStorage(kv, domain) : null,
      onLog: log,
      watchdogMs: this.watchdogMs,
    });
    try {
      await this.host.start();
    } catch (e) {
      if (e instanceof LinkFailure) {
        throw new LoadError(
          `component could not be linked: ${e.message}. It likely imports a capability that the manifest does not request ` +
            `or that this Lattice Navigator does not implement. Implemented imports: ${Object.keys(CAPABILITY_IMPORTS).join(", ")}`
        );
      }
      throw e;
    }
    this.session = new Session(this.host, manifest, domain, log, this.analytics);
    await this.session.init();

    try {
      await this.session.route(startPath);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      this.lastError = e.message;
      if (startPath !== "/") await this.session.route("/").then(() => (this.lastError = null)).catch(() => {});
    }
    return this;
  }

  /** What the host itself draws around the app: whose page this is, who is signed in, what is being asked. */
  chrome() {
    const i = this.sessionStore?.info();
    return {
      app: { name: this.manifest.name ?? this.domain, domain: this.domain },
      session: i ? { signedIn: i.signedIn, name: i.name ?? null } : null,
      prompts: this.prompts.list(),
      privacy: this.analytics ? this.analytics.snapshot() : null,
    };
  }

  snap(focus) {
    return { ...this.session.snapshot(focus), chrome: this.chrome() };
  }

  /** The current state of the window: a scene, or the error that stopped one being shown. */
  current(focus) {
    return this.lastError && !this.session.store.root ? { kind: "error", message: this.lastError, chrome: this.chrome() } : this.snap(focus);
  }

  /** Run a session call that can fail the way an app does, telling the window why when it does. */
  async #noticing(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpError) this.#emit({ kind: "notice", message: e.message });
      throw e;
    }
  }

  /**
   * Answer one request from the user's window. `endpoint` is the part after /_navigator/ in the HTTP form.
   * Throws HttpError (with a status the HTTP layer uses) when a request is refused.
   */
  async handle(endpoint, body) {
    switch (endpoint) {
      case "route":
        if (typeof body.path !== "string" || !body.path.startsWith("/")) throw new HttpError(400, "bad path");
        await this.#noticing(async () => {
          await this.session.route(body.path);
          this.lastError = null;
          this.#emit(this.snap());
        });
        return;

      case "act": {
        const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
        for (const v of Object.values(values)) {
          if (!["string", "number", "boolean"].includes(typeof v)) throw new HttpError(400, "bad value");
        }
        if (!Number.isInteger(body.source)) throw new HttpError(400, "bad source");
        await this.#noticing(async () => {
          const { focus } = await this.session.act(body.source, String(body.event), values);
          this.#emit(this.snap(focus));
        });
        return;
      }

      // The user's answer to a host-drawn passkey prompt.
      case "auth/result":
        if (!this.auth) throw new HttpError(404, "no such endpoint");
        if (typeof body.id !== "string") throw new HttpError(400, "bad id");
        if (!this.auth.finishPasskey(body.id, body)) throw new HttpError(404, "no such sign-in request");
        return;

      // Cancel any pending prompt (sign-in or payment). The older path is kept as an alias.
      case "prompt/cancel":
      case "auth/cancel":
        if (typeof body.id !== "string") throw new HttpError(400, "bad id");
        this.prompts.cancel(body.id);
        return;

      // Sign out, from the host's own chrome. The app is told afterwards and updates itself.
      case "signout": {
        if (!this.auth) throw new HttpError(404, "no such endpoint");
        await this.#noticing(async () => {
          await this.auth.signOut();
          const i = this.sessionStore.info();
          await this.session.event({ tag: "session-changed", val: { signedIn: i.signedIn, subject: i.subject, expiresAt: undefined } });
          this.#emit(this.snap());
        });
        return;
      }

      // The user's analytics choices, made in the host's own chrome.
      case "settings":
        if (!this.analytics) throw new HttpError(404, "no such endpoint");
        try {
          this.analytics.setLevel(body.analytics);
        } catch {
          throw new HttpError(400, "unknown analytics level");
        }
        this.#emit({ kind: "chrome", chrome: this.chrome() });
        return;

      case "analytics/reset":
        if (!this.analytics) throw new HttpError(404, "no such endpoint");
        this.analytics.resetClient();
        this.#emit({ kind: "chrome", chrome: this.chrome() });
        return;

      default:
        throw new HttpError(404, "no such endpoint");
    }
  }

  /** The identity provider sent the user's browser back. Returns what to tell the user. */
  authCallback(params) {
    return this.auth ? this.auth.callback(params) : { ok: false, message: "Sign-in is not available." };
  }

  /** The payment processor sent the user's browser back. `outcome` is "return" or "cancel". */
  paymentCallback(outcome, params) {
    return this.payments ? this.payments.callback(outcome, params) : { ok: false, message: "Payments are not available." };
  }

  /**
   * A validated message arrived on a topic. Messages reach the app one at a time and in order. If the app falls behind,
   * the oldest beyond MAX_PUSHED_QUEUE are dropped: topics carry state, not commands.
   */
  #pushed(topic, payload) {
    this.#pushQueue.push({ topic, payload });
    if (this.#pushQueue.length > MAX_PUSHED_QUEUE) this.#pushQueue.shift();
    if (this.#pushing) return;
    this.#pushing = true;
    void (async () => {
      try {
        while (this.#pushQueue.length && this.session) {
          const { topic, payload } = this.#pushQueue.shift();
          try {
            const { focus } = await this.session.event({ tag: "stream-message", val: { topic, payload } });
            this.#emit(this.snap(focus));
          } catch (e) {
            this.log("warn", `push on ${topic} failed: ${e.message}`);
          }
        }
      } finally {
        this.#pushing = false;
      }
    })();
  }

  async close() {
    this.#pushQueue.length = 0;
    this.host?.stream?.close();
    await this.analytics?.close();
    this.prompts?.dispose();
    this.host?.close();
  }
}

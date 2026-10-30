// Main-thread owner of the component's thread. Serves its host calls (RPC, storage, session, sign-in,
// payments), forwards its logs, and kills it if it stops responding.
//
// It does not know how threads are made: `spawn(workerData)` returns a handle (postMessage, terminate, and
// onMessage / onError / onExit slots), supplied by Node (spawn-node.mjs) or by a browser. The same
// logic therefore runs in both.

import { MAX_BODY } from "./rpc.mjs";
import { HostFailure } from "./prompts.mjs";
import { argsObject } from "./scene.mjs";
import { b64Encode, utf8 } from "./bytes.mjs";

export class ComponentError extends Error {
  constructor(payload, message) {
    super(message ?? "component returned an error");
    this.payload = payload;
  }
}
export class HostCrash extends Error {}
export class LinkFailure extends Error {}

const jsonBytes = (v) => utf8(JSON.stringify(v));

export class AppHost {
  #worker = null;
  #pending = new Map();
  #nextId = 1;
  #sab = new SharedArrayBuffer(16 + MAX_BODY + 4096);

  /**
   * @param opts.spawn       (workerData) => handle; see above
   * @param opts.component   what the thread needs to load the transpiled component (opaque to this class)
   * @param opts.granted     capability names the manifest grants
   * @param opts.rpc         RpcClient, or null if the app has no API
   * @param opts.stream      StreamClient, or null (topics need `net.realtime`)
   * @param opts.experiments Experiments, or null
   * @param opts.session     SessionStore, or null
   * @param opts.auth        AuthBroker, or null
   * @param opts.payments    PaymentBroker, or null
   * @param opts.analytics   Analytics, or null
   * @param opts.storage     AppStorage, or null
   * @param opts.watchdogMs  longest the component may run without finishing a call. Time spent waiting
   *                         on a host call (the network, a person) does not count.
   */
  constructor({ spawn, component, granted, rpc = null, stream = null, experiments = null, session = null, auth = null, payments = null, analytics = null, storage = null, onLog, watchdogMs = 30_000, debug = false }) {
    Object.assign(this, { spawn, component, granted: [...granted], rpc, stream, experiments, session, auth, payments, analytics, storage, onLog, watchdogMs, debug });
  }

  async start() {
    const worker = this.spawn({
      component: this.component,
      granted: this.granted,
      sab: this.#sab,
      hasHost: !!(this.rpc || this.stream || this.experiments || this.session || this.auth || this.payments || this.storage),
      debug: this.debug,
    });
    this.#worker = worker;

    // Until the component reports in, a failure means it never started; afterwards it means it died.
    await new Promise((resolve, reject) => {
      worker.onError = (e) => reject(e instanceof Error ? e : new Error(String(e?.message ?? e)));
      worker.onExit = () => reject(new HostCrash("component stopped before it was ready"));
      worker.onMessage = (m) => {
        if (m.type === "ready") resolve();
        else if (m.type === "failed") reject(m.link ? new LinkFailure(m.message) : new Error(m.message));
      };
    });

    worker.onMessage = (m) => this.#onMessage(m);
    worker.onError = (e) => this.#failAll(new HostCrash(String(e?.message ?? e)));
    worker.onExit = () => this.#failAll(new HostCrash("component stopped"));
  }

  #onMessage(m) {
    if (m.type === "log") return void this.onLog?.(m.level, m.message);
    if (m.type === "host") return void this.#serveHostCall(m);
    if (m.type === "analytics") return void this.#fromApp(m);
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.value);
    else if ("payload" in m) p.reject(new ComponentError(m.payload));
    else p.reject(new Error(m.message));
  }

  /** Analytics from the component: fire and forget, and nothing it sends can throw back into the host. */
  #fromApp(m) {
    try {
      if (m.op === "emit" && typeof m.name === "string" && Array.isArray(m.props)) this.analytics?.emit(m.name, argsObject(m.props));
      else if (m.op === "report-error") this.analytics?.reportError(String(m.name), String(m.detail));
    } catch {
      /* a malformed message is dropped */
    }
  }

  /** (Re)start the watchdog for the call in flight. */
  #arm(id) {
    const p = this.#pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      this.#pending.delete(id);
      this.kill();
      p.reject(new HostCrash(`component did not respond within ${this.watchdogMs} ms and was stopped`));
    }, this.watchdogMs);
  }

  /** Answer a blocked worker. Always writes a reply, or the worker would wait for its timeout. */
  async #serveHostCall(m) {
    // The component is waiting on us, not running: its watchdog pauses until we answer.
    for (const p of this.#pending.values()) clearTimeout(p.timer);

    let r;
    try {
      r = await this.#dispatchHostCall(m);
    } catch (e) {
      r = { ok: false, error: e instanceof HostFailure ? e.hostError : m.kind === "rpc" ? { tag: "transport", val: `host error: ${e.message}` } : { tag: "internal", val: e.message } };
    }

    const ctrl = new Int32Array(this.#sab, 0, 4);
    const out = new Uint8Array(this.#sab, 16);
    let bytes;
    let kind;
    if (r.ok) {
      kind = 1;
      bytes = r.bytes;
    } else {
      kind = 2;
      const e = structuredClone(r.error);
      if (e.tag === "application") e.val.details = b64Encode(e.val.details ?? new Uint8Array());
      bytes = jsonBytes(e);
    }
    if (bytes.length > out.length) {
      kind = 2;
      bytes = jsonBytes(m.kind === "rpc" ? { tag: "transport", val: "response too large" } : { tag: "internal", val: "response too large" });
    }
    out.set(bytes);
    for (const id of this.#pending.keys()) this.#arm(id);
    Atomics.store(ctrl, 1, kind);
    Atomics.store(ctrl, 2, bytes.length);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
  }

  async #dispatchHostCall(m) {
    const denied = (what) => ({ ok: false, error: m.kind === "rpc" ? { tag: "host", val: { tag: "capability-denied", val: what } } : { tag: "capability-denied", val: what } });
    const info = (i) => ({ signedIn: i.signedIn, subject: i.subject ?? null, expiresAt: i.expiresAt ?? null });
    switch (m.kind) {
      case "rpc":
        return this.rpc ? this.rpc.call(m.method, m.request) : denied("net.origin");
      case "experiment": {
        if (!this.experiments) return denied("experiments");
        const v = typeof m.name === "string" ? this.experiments.variant(m.name) : undefined;
        return v === undefined ? { ok: false, error: { tag: "invalid-argument", val: "no such experiment" } } : { ok: true, bytes: utf8(v) };
      }
      case "subscribe":
        return this.stream ? this.stream.subscribe(m.topic) : denied("net.realtime");
      case "unsubscribe":
        this.stream?.unsubscribe(m.topic);
        return { ok: true, bytes: new Uint8Array() };
      case "session-current":
        return this.session ? { ok: true, bytes: jsonBytes(info(this.session.info())) } : denied("session");
      case "session-sign-out":
        if (!this.auth) return denied("session");
        await this.auth.signOut();
        return { ok: true, bytes: new Uint8Array() };
      case "oidc":
        if (!this.auth) return denied("auth.oidc");
        return { ok: true, bytes: jsonBytes(info(await this.auth.oidc(m.issuer))) };
      case "passkey":
        if (!this.auth) return denied("auth.passkey");
        return { ok: true, bytes: await this.auth.passkey(m.flow, m.options) };
      case "storage": {
        if (!this.storage) return denied("storage.local");
        const s = this.storage;
        switch (m.op) {
          case "get": {
            const v = s.get(m.key);
            if (v === null) return { ok: true, bytes: Uint8Array.of(0) };
            const out = new Uint8Array(v.length + 1);
            out[0] = 1;
            out.set(v, 1);
            return { ok: true, bytes: out };
          }
          case "set": s.set(m.key, m.value); return { ok: true, bytes: new Uint8Array() };
          case "delete": s.delete(m.key); return { ok: true, bytes: new Uint8Array() };
          case "list": return { ok: true, bytes: jsonBytes(s.list(m.prefix)) };
          default: return { ok: false, error: { tag: "invalid-argument", val: "unknown storage operation" } };
        }
      }
      case "payment": {
        if (!this.payments) return denied("payments.request");
        const r = await this.payments.request(m.orderRef);
        return { ok: true, bytes: jsonBytes({ orderRef: r.orderRef, handler: r.handler }) };
      }
      default:
        return { ok: false, error: { tag: "invalid-argument", val: `unknown host call ${m.kind}` } };
    }
  }

  /** Call a lifecycle export. Rejects with ComponentError (the app returned `err`) or HostCrash. */
  call(op, arg) {
    if (!this.#worker) return Promise.reject(new HostCrash("component is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, timer: null });
      this.#arm(id);
      this.#worker.postMessage({ id, op, arg });
    });
  }

  #failAll(err) {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.#pending.delete(id);
    }
  }

  kill() {
    this.stream?.reset();
    const w = this.#worker;
    this.#worker = null;
    w?.terminate();
  }

  /** Stop for good: unlike kill(), nothing (a call that finds the component gone, a crash handler) may start it again. */
  close() {
    this.closed = true;
    this.kill();
  }

  async restart() {
    if (this.closed) throw new HostCrash("the app was closed");
    this.kill();
    await this.start();
  }
}

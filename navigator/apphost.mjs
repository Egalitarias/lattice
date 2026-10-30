// Main-thread owner of the component's worker. Serves its host calls (RPC, session, sign-in),
// forwards its logs, and kills it if it stops responding.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { MAX_BODY } from "./rpc.mjs";
import { HostFailure } from "./prompts.mjs";
import { argsObject } from "./scene.mjs";

const workerFile = join(dirname(fileURLToPath(import.meta.url)), "app-worker.mjs");

export class ComponentError extends Error {
  constructor(payload, message) {
    super(message ?? "component returned an error");
    this.payload = payload;
  }
}
export class HostCrash extends Error {}
export class LinkFailure extends Error {}

const jsonBytes = (v) => Buffer.from(JSON.stringify(v), "utf8");

export class AppHost {
  #worker = null;
  #pending = new Map();
  #nextId = 1;
  #sab = new SharedArrayBuffer(16 + MAX_BODY + 4096);

  /**
   * @param opts.entryJs     transpiled component entry module
   * @param opts.granted     capability names the manifest grants
   * @param opts.rpc         RpcClient, or null if the app has no API
   * @param opts.session     SessionStore, or null
   * @param opts.auth        AuthBroker, or null
   * @param opts.payments    PaymentBroker, or null
   * @param opts.analytics   Analytics, or null
   * @param opts.watchdogMs  longest the component may run without finishing a call. Time spent waiting
   *                         on a host call (the network, a person) does not count.
   */
  constructor({ entryJs, granted, origin, dataDir, rpc = null, session = null, auth = null, payments = null, analytics = null, onLog, watchdogMs = 30_000, debug = false }) {
    Object.assign(this, { entryJs, granted: [...granted], origin, dataDir, rpc, session, auth, payments, analytics, onLog, watchdogMs, debug });
  }

  async start() {
    const worker = new Worker(workerFile, {
      workerData: {
        entryJs: this.entryJs,
        granted: this.granted,
        origin: this.origin,
        dataDir: this.dataDir,
        sab: this.#sab,
        hasHost: !!(this.rpc || this.session || this.auth || this.payments),
        debug: this.debug,
      },
      // The component gets no environment and no stdio of its own.
      env: {},
      stdout: false,
      stderr: false,
    });
    this.#worker = worker;

    await new Promise((resolve, reject) => {
      const fail = (e) => reject(e);
      worker.on("error", fail);
      worker.once("exit", () => reject(new HostCrash("component stopped before it was ready")));
      worker.on("message", (m) => {
        if (m.type === "ready") {
          worker.off("error", fail);
          resolve();
        } else if (m.type === "failed") {
          reject(m.link ? new LinkFailure(m.message) : new Error(m.message));
        }
      });
    });

    worker.on("message", (m) => this.#onMessage(m));
    worker.on("error", (e) => this.#failAll(new HostCrash(e.message)));
    worker.on("exit", () => this.#failAll(new HostCrash("component stopped")));
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
      if (e.tag === "application") e.val.details = Buffer.from(e.val.details ?? []).toString("base64");
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
    const w = this.#worker;
    this.#worker = null;
    w?.terminate();
  }

  async restart() {
    this.kill();
    await this.start();
  }
}

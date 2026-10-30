// Main-thread owner of the component's worker. Serves its RPC calls, forwards its logs, and kills
// it if a call into the component takes too long.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { MAX_BODY } from "./rpc.mjs";

const workerFile = join(dirname(fileURLToPath(import.meta.url)), "app-worker.mjs");

export class ComponentError extends Error {
  constructor(payload, message) {
    super(message ?? "component returned an error");
    this.payload = payload;
  }
}
export class HostCrash extends Error {}
export class LinkFailure extends Error {}

export class AppHost {
  #worker = null;
  #pending = new Map();
  #nextId = 1;
  #sab = new SharedArrayBuffer(16 + MAX_BODY + 4096);

  /**
   * @param opts.entryJs     transpiled component entry module
   * @param opts.granted     capability names the manifest grants
   * @param opts.rpc         RpcClient, or null if the app has no API
   * @param opts.watchdogMs  longest a single call into the component may take
   */
  constructor({ entryJs, granted, origin, dataDir, rpc, onLog, watchdogMs = 30_000, debug = false }) {
    Object.assign(this, { entryJs, granted: [...granted], origin, dataDir, rpc, onLog, watchdogMs, debug });
  }

  async start() {
    const worker = new Worker(workerFile, {
      workerData: {
        entryJs: this.entryJs,
        granted: this.granted,
        origin: this.origin,
        dataDir: this.dataDir,
        sab: this.#sab,
        hasApi: !!this.rpc,
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
    if (m.type === "rpc") return void this.#serveRpc(m);
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.value);
    else if ("payload" in m) p.reject(new ComponentError(m.payload));
    else p.reject(new Error(m.message));
  }

  /** Answer a blocked worker. Always writes a reply, or the worker would wait for its timeout. */
  async #serveRpc({ method, request }) {
    let r;
    try {
      r = this.rpc ? await this.rpc.call(method, request) : { ok: false, error: { tag: "host", val: { tag: "capability-denied", val: "rpc" } } };
    } catch (e) {
      r = { ok: false, error: { tag: "transport", val: `host error: ${e.message}` } };
    }
    const ctrl = new Int32Array(this.#sab, 0, 4);
    const payload = new Uint8Array(this.#sab, 16);
    let bytes;
    let kind;
    if (r.ok) {
      kind = 1;
      bytes = r.bytes;
    } else {
      kind = 2;
      const e = structuredClone(r.error);
      if (e.tag === "application") e.val.details = Buffer.from(e.val.details ?? []).toString("base64");
      bytes = Buffer.from(JSON.stringify(e), "utf8");
    }
    if (bytes.length > payload.length) {
      kind = 2;
      bytes = Buffer.from(JSON.stringify({ tag: "transport", val: "response too large" }), "utf8");
    }
    payload.set(bytes);
    Atomics.store(ctrl, 1, kind);
    Atomics.store(ctrl, 2, bytes.length);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
  }

  /** Call a lifecycle export. Rejects with ComponentError (the app returned `err`) or HostCrash. */
  call(op, arg) {
    if (!this.#worker) return Promise.reject(new HostCrash("component is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.kill();
        reject(new HostCrash(`component did not respond within ${this.watchdogMs} ms and was stopped`));
      }, this.watchdogMs);
      this.#pending.set(id, { resolve, reject, timer });
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

// Runs one app component on its own thread.
//
// Why a thread: WIT 0.2 host calls are synchronous, but RPC is network I/O. The worker blocks on a
// shared buffer while the main thread does the fetch, so Lattice Navigator stays responsive, and a component that
// hangs or loops can be killed from outside (see apphost.mjs).
//
// Protocol with the main thread:
//   main -> worker  { id, op, arg }              call a lifecycle export
//   worker -> main  { id, ok, value | payload }  its result
//   worker -> main  { type: "log", level, message }
//   worker -> main  { type: "host", kind, ...payload }  then block until main fills the shared buffer
//                   (kind: rpc | session-current | session-sign-out | oidc | passkey | payment)

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import { hostImports } from "./host.mjs";

const { entryJs, granted, origin, dataDir, sab, hasHost, debug } = workerData;
const ctrl = new Int32Array(sab, 0, 4); // [0] state (0 waiting, 1 ready), [1] kind (1 ok, 2 error), [2] length
const shared = new Uint8Array(sab, 16); // bytes of the main thread's reply
// Calls that wait on a person get minutes, not seconds. The main thread pauses its watchdog meanwhile.
const INTERACTIVE = new Set(["oidc", "passkey", "payment", "session-sign-out"]);
const WAIT_MS = 30_000;
const INTERACTIVE_WAIT_MS = 6 * 60_000;

/** Block until the main thread answers. Returns { ok, bytes } or { ok: false, error }. */
function hostCall(kind, payload = {}) {
  Atomics.store(ctrl, 0, 0);
  parentPort.postMessage({ type: "host", kind, ...payload });
  const waited = Atomics.wait(ctrl, 0, 0, INTERACTIVE.has(kind) ? INTERACTIVE_WAIT_MS : WAIT_MS);
  if (waited === "timed-out") {
    const error = kind === "rpc" ? { tag: "transport", val: "host did not answer" } : { tag: "unavailable", val: "host did not answer" };
    return { ok: false, error };
  }
  const resultKind = Atomics.load(ctrl, 1);
  const length = Atomics.load(ctrl, 2);
  const bytes = shared.slice(0, length);
  Atomics.store(ctrl, 0, 0);
  if (resultKind === 1) return { ok: true, bytes };
  const e = JSON.parse(Buffer.from(bytes).toString("utf8"));
  // application.details travels as base64
  if (e.tag === "application") e.val.details = new Uint8Array(Buffer.from(e.val.details ?? "", "base64"));
  return { ok: false, error: e };
}

const onLog = (level, message) => parentPort.postMessage({ type: "log", level, message });

const { instantiate } = await import(pathToFileURL(entryJs).href);
const getCoreModule = async (path) => WebAssembly.compile(readFileSync(join(dirname(entryJs), path)));

// The only WASI the app sees: no filesystem, no environment, no network.
const wasi = new WASIShim({ sandbox: { preopens: {}, env: {}, args: ["app"], enableNetwork: false } }).getImportObject();
const imports = {
  ...wasi,
  ...hostImports({ granted: new Set(granted), origin, dataDir, onLog, hostCall: hasHost ? hostCall : undefined, post: (m) => parentPort.postMessage({ type: "analytics", ...m }) }),
};

let lifecycle;
try {
  lifecycle = (await instantiate(getCoreModule, imports)).lifecycle;
} catch (e) {
  parentPort.postMessage({ type: "failed", message: e.message, link: e instanceof TypeError });
  process.exit(0);
}
parentPort.postMessage({ type: "ready" });

parentPort.on("message", ({ id, op, arg }) => {
  try {
    if (debug && op === "debug-hang") for (;;);
    const value = lifecycle[op](arg);
    parentPort.postMessage({ id, ok: true, value });
  } catch (e) {
    // jco throws ComponentError with the WIT error value in .payload
    if (e && typeof e === "object" && "payload" in e) parentPort.postMessage({ id, ok: false, payload: e.payload });
    else parentPort.postMessage({ id, ok: false, message: String(e?.message ?? e) });
  }
});

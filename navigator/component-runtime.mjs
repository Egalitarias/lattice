// The code that runs on the component's own thread, identical in Node and in a browser.
//
// Why a thread: host calls are synchronous from the component's side (WIT 0.2) but are I/O on ours. The
// component thread blocks on a shared buffer while the main thread does the work, so the host stays
// responsive, and a component that hangs or loops can be killed from outside (see apphost.mjs).
//
// Protocol with the main thread (messages through `port`):
//   main -> worker  { id, op, arg }                      call a lifecycle export
//   worker -> main  { id, ok, value | payload | message } its result
//   worker -> main  { type: "log", level, message }
//   worker -> main  { type: "analytics", op, ... }        fire and forget
//   worker -> main  { type: "host", kind, ...payload }    then block until main fills the shared buffer
//                   (kind: rpc | storage | session-current | session-sign-out | oidc | passkey | payment)
//   worker -> main  { type: "ready" } | { type: "failed", message, link }

import { hostImports } from "./host.mjs";
import { b64Decode, fromUtf8 } from "./bytes.mjs";

// Calls that wait on a person get minutes, not seconds. The main thread pauses its watchdog meanwhile.
const INTERACTIVE = new Set(["oidc", "passkey", "payment", "session-sign-out"]);
const WAIT_MS = 30_000;
const INTERACTIVE_WAIT_MS = 6 * 60_000;

/**
 * @param port        { post(message), onMessage(handler) }
 * @param config      { granted, sab, hasHost, debug } from the main thread
 * @param loadModule  () => the transpiled component's module (it exports `instantiate`)
 * @param compile     (path) => Promise<WebAssembly.Module> for one of the component's core modules
 * @param wasiImports the import object for the WASI interfaces the component's runtime library needs: sandboxed
 * @returns true once the component is instantiated and listening; false if it could not be linked
 */
export async function runComponent({ port, config, loadModule, compile, wasiImports }) {
  const { granted, sab, hasHost, debug } = config;
  const ctrl = new Int32Array(sab, 0, 4); // [0] state (0 waiting, 1 ready), [1] kind (1 ok, 2 error), [2] length
  const shared = new Uint8Array(sab, 16); // bytes of the main thread's reply

  /** Block until the main thread answers. Returns { ok, bytes } or { ok: false, error }. */
  function hostCall(kind, payload = {}) {
    Atomics.store(ctrl, 0, 0);
    port.post({ type: "host", kind, ...payload });
    const waited = Atomics.wait(ctrl, 0, 0, INTERACTIVE.has(kind) ? INTERACTIVE_WAIT_MS : WAIT_MS);
    if (waited === "timed-out") {
      return { ok: false, error: kind === "rpc" ? { tag: "transport", val: "host did not answer" } : { tag: "unavailable", val: "host did not answer" } };
    }
    const resultKind = Atomics.load(ctrl, 1);
    const length = Atomics.load(ctrl, 2);
    const bytes = shared.slice(0, length);
    Atomics.store(ctrl, 0, 0);
    if (resultKind === 1) return { ok: true, bytes };
    const e = JSON.parse(fromUtf8(bytes));
    if (e.tag === "application") e.val.details = b64Decode(e.val.details ?? ""); // details travel as base64
    return { ok: false, error: e };
  }

  const onLog = (level, message) => port.post({ type: "log", level, message });
  const imports = {
    ...wasiImports,
    ...hostImports({
      granted: new Set(granted),
      onLog,
      hostCall: hasHost ? hostCall : undefined,
      post: (m) => port.post({ type: "analytics", ...m }),
    }),
  };

  let lifecycle;
  try {
    const mod = await loadModule();
    lifecycle = (await mod.instantiate(compile, imports)).lifecycle;
  } catch (e) {
    // A TypeError here means an import the component needs was not provided: it asked for more than the manifest grants.
    port.post({ type: "failed", message: e.message, link: e instanceof TypeError });
    return false;
  }
  port.post({ type: "ready" });

  port.onMessage(({ id, op, arg }) => {
    try {
      if (debug && op === "debug-hang") for (;;);
      const value = lifecycle[op](arg);
      port.post({ id, ok: true, value });
    } catch (e) {
      // The generated code throws ComponentError with the WIT error value in .payload
      if (e && typeof e === "object" && "payload" in e) port.post({ id, ok: false, payload: e.payload });
      else port.post({ id, ok: false, message: String(e?.message ?? e) });
    }
  });
  return true;
}

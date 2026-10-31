// Host-side implementations of the lattice:app capability imports. These run inside the worker
// that hosts the component.
//
// An import is linked only when the manifest grants the capability that backs it. Anything else is
// simply absent from the import object, so a component that needs it fails to instantiate.

import { fromUtf8 } from "./bytes.mjs";

/** WIT interface -> capabilities that grant it (any one suffices). */
export const CAPABILITY_IMPORTS = {
  "lattice:app/log": null, // always available
  "lattice:app/storage": ["storage.local", "storage.sync"],
  "lattice:app/rpc": ["net.origin", "net.realtime"],
  "lattice:app/session": ["session"],
  "lattice:app/auth": ["auth.oidc", "auth.passkey"],
  "lattice:app/payments": ["payments.request"],
  "lattice:app/analytics": ["analytics.event"],
  "lattice:app/experiments": ["experiments"],
  "lattice:app/surface": ["gpu.surface"],
};

/** Throw a WIT `err` from a host function. jco reads the payload property. */
export function hostError(tag, val) {
  const e = new Error(val ? `${tag}: ${val}` : tag);
  e.payload = val === undefined ? { tag } : { tag, val };
  return e;
}

/**
 * @param post     (message) => void; fire and forget to the main thread (analytics). No reply, so no timing channel.
 * @param hostCall (kind, payload) => { ok, bytes } | { ok: false, error }; blocks until the host answers.
 *                 Provided when the app has an API, a session or auth.
 */
export function hostImports({ granted, onLog, hostCall, post }) {
  const imports = {};

  imports["lattice:app/log"] = {
    write(level, message) {
      onLog?.(level, message);
    },
  };

  /** Unwrap a host-call result: bytes on success, otherwise throw the WIT error carried in the result. */
  const unwrap = (r) => {
    if (r.ok) return r.bytes;
    const err = new Error(`host call failed: ${r.error.tag}`);
    err.payload = r.error; // rpc-error for rpc calls, host-error for the rest (see apphost.mjs)
    throw err;
  };
  const json = (bytes) => JSON.parse(fromUtf8(bytes));
  const sessionInfo = (bytes) => {
    const i = json(bytes);
    return { signedIn: i.signedIn, subject: i.subject ?? undefined, expiresAt: i.expiresAt == null ? undefined : BigInt(i.expiresAt) };
  };
  const need = (cap) => {
    if (!granted.has(cap)) throw hostError("capability-denied", cap);
  };

  // Storage lives on the main thread (the host's kv); the component reaches it with a blocking call. A get
  // returns one byte (0 = absent, 1 = present) followed by the value.
  if (hostCall && ["storage.local", "storage.sync"].some((c) => granted.has(c))) {
    imports["lattice:app/storage"] = {
      get(key) {
        const r = unwrap(hostCall("storage", { op: "get", key }));
        return r[0] === 1 ? r.slice(1) : undefined;
      },
      set: (key, value) => void unwrap(hostCall("storage", { op: "set", key, value })),
      delete: (key) => void unwrap(hostCall("storage", { op: "delete", key })),
      listKeys: (prefix) => json(unwrap(hostCall("storage", { op: "list", prefix }))),
    };
  }

  if (hostCall && ["net.origin", "net.realtime"].some((c) => granted.has(c))) {
    imports["lattice:app/rpc"] = {
      call: (method, request) => unwrap(hostCall("rpc", { method, request })),
      subscribe(topic) {
        need("net.realtime");
        unwrap(hostCall("subscribe", { topic }));
      },
      unsubscribe(topic) {
        if (granted.has("net.realtime")) unwrap(hostCall("unsubscribe", { topic }));
      },
    };
  }

  if (hostCall && granted.has("session")) {
    imports["lattice:app/session"] = {
      current: () => sessionInfo(unwrap(hostCall("session-current"))),
      signOut: () => void unwrap(hostCall("session-sign-out")),
    };
  }

  if (hostCall && (granted.has("auth.oidc") || granted.has("auth.passkey"))) {
    imports["lattice:app/auth"] = {
      signInOidc(issuer) {
        need("auth.oidc");
        return sessionInfo(unwrap(hostCall("oidc", { issuer })));
      },
      passkeyCreate(options) {
        need("auth.passkey");
        return unwrap(hostCall("passkey", { flow: "create", options }));
      },
      passkeyAssert(options) {
        need("auth.passkey");
        return unwrap(hostCall("passkey", { flow: "assert", options }));
      },
    };
  }

  if (post && granted.has("analytics.event")) {
    imports["lattice:app/analytics"] = {
      emit: (name, props) => post({ op: "emit", name, props }),
      reportError: (name, detail) => post({ op: "report-error", name, detail }),
    };
  }

  if (hostCall && granted.has("experiments")) {
    imports["lattice:app/experiments"] = {
      lookup: (name) => fromUtf8(unwrap(hostCall("experiment", { name }))),
    };
  }

  if (hostCall && granted.has("gpu.surface")) {
    imports["lattice:app/surface"] = {
      create: (width, height) => fromUtf8(unwrap(hostCall("surface-create", { width, height }))),
      present: (handle, pixels) => void unwrap(hostCall("surface-present", { handle, pixels })),
      destroy: (handle) => void unwrap(hostCall("surface-destroy", { handle })),
    };
  }

  if (hostCall && granted.has("payments.request")) {
    imports["lattice:app/payments"] = {
      request(orderRef) {
        const r = json(unwrap(hostCall("payment", { orderRef })));
        return { orderRef: r.orderRef, handler: r.handler };
      },
    };
  }

  return imports;
}

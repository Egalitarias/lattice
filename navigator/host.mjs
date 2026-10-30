// Host-side implementations of the lattice:app capability imports. These run inside the worker
// that hosts the component.
//
// An import is linked only when the manifest grants the capability that backs it. Anything else is
// simply absent from the import object, so a component that needs it fails to instantiate.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** WIT interface -> capabilities that grant it (any one suffices). */
export const CAPABILITY_IMPORTS = {
  "lattice:app/log": null, // always available
  "lattice:app/storage": ["storage.local", "storage.sync"],
  "lattice:app/rpc": ["net.origin", "net.realtime"],
  "lattice:app/session": ["session"],
  "lattice:app/auth": ["auth.oidc", "auth.passkey"],
  "lattice:app/payments": ["payments.request"],
};

/** Throw a WIT `err` from a host function. jco reads the payload property. */
export function hostError(tag, val) {
  const e = new Error(val ? `${tag}: ${val}` : tag);
  e.payload = val === undefined ? { tag } : { tag, val };
  return e;
}

/**
 * @param hostCall (kind, payload) => { ok, bytes } | { ok: false, error }; blocks until the host answers.
 *                 Provided when the app has an API, a session or auth.
 */
export function hostImports({ granted, origin, dataDir, onLog, hostCall }) {
  const imports = {};

  imports["lattice:app/log"] = {
    write(level, message) {
      onLog?.(level, message);
    },
  };

  if (["storage.local", "storage.sync"].some((c) => granted.has(c))) {
    const dir = join(dataDir, origin.replace(/[^A-Za-z0-9.-]/g, "_"));
    const file = join(dir, "storage.json");
    const MAX_KEYS = 1000;
    const MAX_VALUE = 1024 * 1024;

    const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
    const write = (data) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(data));
    };

    imports["lattice:app/storage"] = {
      get(key) {
        const v = read()[key];
        return v === undefined ? undefined : new Uint8Array(Buffer.from(v, "base64"));
      },
      set(key, value) {
        if (value.length > MAX_VALUE) throw hostError("invalid-argument", "value too large");
        const data = read();
        if (!(key in data) && Object.keys(data).length >= MAX_KEYS) throw hostError("invalid-argument", "too many keys");
        data[key] = Buffer.from(value).toString("base64");
        write(data);
      },
      delete(key) {
        const data = read();
        delete data[key];
        write(data);
      },
      listKeys(prefix) {
        return Object.keys(read()).filter((k) => k.startsWith(prefix));
      },
    };
  }

  /** Unwrap a host-call result: bytes on success, otherwise throw the WIT error carried in the result. */
  const unwrap = (r) => {
    if (r.ok) return r.bytes;
    const err = new Error(`host call failed: ${r.error.tag}`);
    err.payload = r.error; // rpc-error for rpc calls, host-error for the rest (see apphost.mjs)
    throw err;
  };
  const json = (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8"));
  const sessionInfo = (bytes) => {
    const i = json(bytes);
    return { signedIn: i.signedIn, subject: i.subject ?? undefined, expiresAt: i.expiresAt == null ? undefined : BigInt(i.expiresAt) };
  };
  const need = (cap) => {
    if (!granted.has(cap)) throw hostError("capability-denied", cap);
  };

  if (hostCall && ["net.origin", "net.realtime"].some((c) => granted.has(c))) {
    imports["lattice:app/rpc"] = {
      call: (method, request) => unwrap(hostCall("rpc", { method, request })),
      subscribe() {
        throw hostError("unavailable", "streaming is not implemented in this Lattice Navigator");
      },
      unsubscribe() {},
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

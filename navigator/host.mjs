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
};

/** Throw a WIT `err` from a host function. jco reads the payload property. */
export function hostError(tag, val) {
  const e = new Error(val ? `${tag}: ${val}` : tag);
  e.payload = val === undefined ? { tag } : { tag, val };
  return e;
}

/**
 * @param rpcCall  (method, Uint8Array) => result; blocks until the host answers. Only provided when
 *                 the app has an API.
 */
export function hostImports({ granted, origin, dataDir, onLog, rpcCall }) {
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

  if (rpcCall && ["net.origin", "net.realtime"].some((c) => granted.has(c))) {
    imports["lattice:app/rpc"] = {
      call(method, request) {
        const r = rpcCall(method, request);
        if (r.ok) return r.bytes;
        const e = r.error;
        // WIT: rpc-error = host(host-error) | application(application-error) | transport(string)
        const err = new Error(`rpc ${e.tag}`);
        err.payload = e;
        throw err;
      },
      subscribe() {
        throw hostError("unavailable", "streaming is not implemented in this Lattice Navigator");
      },
      unsubscribe() {},
    };
  }

  return imports;
}

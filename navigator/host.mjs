// Host-side implementations of the lattice:app capability imports.
//
// An import is linked only when the manifest grants the capability that backs it. Anything else is
// simply absent from the import object, so a component that needs it fails to instantiate.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** WIT interface -> capabilities that grant it (any one suffices). */
export const CAPABILITY_IMPORTS = {
  "lattice:app/log": null, // always available
  "lattice:app/storage": ["storage.local", "storage.sync"],
};

/** Throw a WIT `err` from a host function. jco reads the payload property. */
function hostError(tag, val) {
  const e = new Error(val ? `${tag}: ${val}` : tag);
  e.payload = val === undefined ? { tag } : { tag, val };
  return e;
}

export function hostImports({ granted, origin, dataDir, onLog }) {
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

  return imports;
}

// The Node implementation of the kv interface: one private file per key under a directory.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// encodeURIComponent never leaves a "$" in its output, so "%" -> "$" is reversible and the mapping is unambiguous.
const encodeKey = (key) => encodeURIComponent(key).replace(/%/g, "$");
const decodeKey = (name) => decodeURIComponent(name.replace(/\$/g, "%"));
const fileFor = (dir, key) => join(dir, encodeKey(key) + ".kv");

export class FileKv {
  constructor(dir) {
    this.dir = dir;
  }
  get(key) {
    const f = fileFor(this.dir, key);
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  }
  set(key, value) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(fileFor(this.dir, key), String(value), { mode: 0o600 });
  }
  delete(key) {
    rmSync(fileFor(this.dir, key), { force: true });
  }
  keys(prefix = "") {
    if (!existsSync(this.dir)) return [];
    const want = encodeKey(prefix);
    return readdirSync(this.dir).filter((f) => f.endsWith(".kv") && f.startsWith(want)).map((f) => decodeKey(f.slice(0, -3)));
  }
}

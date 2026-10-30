// The browser's implementation of the kv interface: localStorage, falling back to memory when storage is
// unavailable (a private window, blocked site data). Never throws: losing persistence is better than losing the app.

import { MemoryKv } from "../kv.mjs";

export class LocalStorageKv {
  #fallback = new MemoryKv();
  constructor(prefix = "lattice:") {
    this.prefix = prefix;
  }
  get(key) {
    try { return localStorage.getItem(this.prefix + key); } catch { return this.#fallback.get(key); }
  }
  set(key, value) {
    try { localStorage.setItem(this.prefix + key, String(value)); } catch { this.#fallback.set(key, value); }
  }
  delete(key) {
    try { localStorage.removeItem(this.prefix + key); } catch { this.#fallback.delete(key); }
  }
  keys(prefix = "") {
    try {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(this.prefix + prefix)) out.push(k.slice(this.prefix.length));
      }
      return out;
    } catch {
      return this.#fallback.keys(prefix);
    }
  }
}

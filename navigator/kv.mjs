// A small synchronous string store, so the core does not care whether it runs against a directory on
// disk (Node) or localStorage (a browser). Keys are short names like "session/tasks.localhost";
// values are strings.

export class MemoryKv {
  #m = new Map();
  get(key) {
    return this.#m.has(key) ? this.#m.get(key) : null;
  }
  set(key, value) {
    this.#m.set(key, String(value));
  }
  delete(key) {
    this.#m.delete(key);
  }
  keys(prefix = "") {
    return [...this.#m.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** JSON convenience over any kv: a missing or unreadable value is `fallback`. */
export function getJson(kv, key, fallback = null) {
  try {
    const raw = kv.get(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
export const setJson = (kv, key, value) => kv.set(key, JSON.stringify(value));

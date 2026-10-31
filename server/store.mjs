// Durable state for an origin: Maps and Sets that write through to one SQLite file.
//
// Reads come from memory; every set, add and delete is committed to disk before it returns, and throws if it cannot be,
// leaving the collection unchanged. A value that is changed in place is saved by setting it again. Values are JSON, plus bytes.
//
// One process owns the file: a second one is refused rather than left to overwrite the first with its own view.
//
// memoryStore() has the same shape and keeps nothing, for an origin started without a data file.

import { chmodSync } from "node:fs";

const VERSION = 1;

const encode = (value) => JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64url") } : v));
const decode = (text) => JSON.parse(text, (_k, v) => (v && typeof v.$bytes === "string" ? new Uint8Array(Buffer.from(v.$bytes, "base64url")) : v));

export function memoryStore() {
  return { map: () => new Map(), set: () => new Set(), close() {} };
}

/** Open (or create) the data file. Throws if another process has it, or a newer version of this code wrote it. */
export async function openStore(path, { log = console.error } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0;");
    const { user_version: version } = db.prepare("PRAGMA user_version").get();
    if (version > VERSION) throw new Error(`${path} was written by a newer version (${version})`);
    // A write, so that the exclusive lock is taken now and not at the first request.
    db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS entries (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, key)) WITHOUT ROWID; PRAGMA user_version = ${VERSION}; COMMIT;`);
  } catch (e) {
    db.close();
    throw new Error(`could not open the data file ${path}: ${e.message}`);
  }
  // It holds sessions and accounts. (Has no effect on Windows, where the directory's permissions apply.)
  try { chmodSync(path, 0o600); } catch (e) { log(`store: could not restrict ${path}: ${e.message}`); }

  const load = db.prepare("SELECT key, value FROM entries WHERE collection = ?");
  const put = db.prepare("INSERT INTO entries (collection, key, value) VALUES (?, ?, ?) ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value");
  const remove = db.prepare("DELETE FROM entries WHERE collection = ? AND key = ?");
  const empty = db.prepare("DELETE FROM entries WHERE collection = ?");
  const rows = (name) => load.all(name);

  class StoredMap extends Map {
    #name;
    constructor(name) {
      super();
      this.#name = name;
      for (const { key, value } of rows(name)) super.set(key, decode(value));
    }
    set(key, value) {
      put.run(this.#name, key, encode(value));
      return super.set(key, value);
    }
    delete(key) {
      remove.run(this.#name, key);
      return super.delete(key);
    }
    clear() {
      empty.run(this.#name);
      super.clear();
    }
  }

  class StoredSet extends Set {
    #name;
    constructor(name) {
      super();
      this.#name = name;
      for (const { key } of rows(name)) super.add(key);
    }
    add(key) {
      if (!this.has(key)) put.run(this.#name, key, "1");
      return super.add(key);
    }
    delete(key) {
      remove.run(this.#name, key);
      return super.delete(key);
    }
    clear() {
      empty.run(this.#name);
      super.clear();
    }
  }

  return { map: (name) => new StoredMap(name), set: (name) => new StoredSet(name), close: () => db.close() };
}

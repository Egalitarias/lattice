// The `storage` capability: a small private key-value store per app origin, backed by the host's kv.
// It runs on the main thread; the component reaches it through a blocking host call (see host.mjs).

import { b64uDecode, b64uEncode } from "./bytes.mjs";
import { HostFailure } from "./prompts.mjs";

const MAX_KEYS = 1000;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE = 1024 * 1024;

export class AppStorage {
  constructor(kv, origin) {
    this.kv = kv;
    this.prefix = `app/${origin}/`;
  }

  #key(key) {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) throw new HostFailure("invalid-argument", "bad key");
    return this.prefix + key;
  }

  /** The value as bytes, or null. */
  get(key) {
    const raw = this.kv.get(this.#key(key));
    return raw === null ? null : b64uDecode(raw);
  }

  set(key, value) {
    const k = this.#key(key);
    if (!(value instanceof Uint8Array)) throw new HostFailure("invalid-argument", "value must be bytes");
    if (value.length > MAX_VALUE) throw new HostFailure("invalid-argument", "value too large");
    if (this.kv.get(k) === null && this.kv.keys(this.prefix).length >= MAX_KEYS) throw new HostFailure("invalid-argument", "too many keys");
    this.kv.set(k, b64uEncode(value));
  }

  delete(key) {
    this.kv.delete(this.#key(key));
  }

  list(prefix) {
    if (typeof prefix !== "string" || prefix.length > MAX_KEY_LENGTH) throw new HostFailure("invalid-argument", "bad prefix");
    return this.kv.keys(this.prefix + prefix).map((k) => k.slice(this.prefix.length));
  }
}

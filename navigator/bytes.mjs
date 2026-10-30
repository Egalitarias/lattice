// Bytes, randomness and hashing with Web APIs only, so the same code runs in Node and in a browser.

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (bytes) => dec.decode(bytes);

/** Unpadded base64url. */
export function b64uEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict: throws on anything that is not base64url. */
export function b64uDecode(text) {
  if (typeof text !== "string" || /[^A-Za-z0-9_-]/.test(text) || text.length % 4 === 1) throw new TypeError("not base64url");
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
/** A random URL-safe string of `n` random bytes (43 characters for 32). */
export const randomToken = (n = 32) => b64uEncode(randomBytes(n));
export const uuid = () => crypto.randomUUID();

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** `sha256-<base64url>`, the form used for content addresses. */
export async function hashOf(bytes) {
  return "sha256-" + b64uEncode(await sha256(bytes));
}

export function concat(chunks) {
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Standard base64 (with padding), for the few places a value travels inside JSON. */
export function b64Encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64Decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

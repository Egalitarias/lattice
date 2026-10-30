// Minimal deterministic CBOR (RFC 8949 section 4.2) for the JSON data model plus byte strings.
// Objects use string keys; Maps may use integer keys. Keys are sorted by their encoded form (length first, then bytewise).
// Floats are always encoded as 64-bit; integers use the shortest form.

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function head(major, n, out) {
  const m = major << 5;
  if (n < 24) out.push(m | n);
  else if (n < 0x100) out.push(m | 24, n);
  else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
  else if (n < 0x100000000) out.push(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  else {
    out.push(m | 27);
    const big = BigInt(n);
    for (let i = 7n; i >= 0n; i--) out.push(Number((big >> (i * 8n)) & 0xffn));
  }
}

function encodeInto(v, out) {
  if (v === null || v === undefined) return out.push(0xf6);
  if (v === false) return out.push(0xf4);
  if (v === true) return out.push(0xf5);
  if (typeof v === "bigint") {
    if (v >= 0n) return head(0, v, out);
    return head(1, -1n - v, out);
  }
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
      return v >= 0 ? head(0, v, out) : head(1, -1 - v, out);
    }
    out.push(0xfb);
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v);
    for (let i = 0; i < 8; i++) out.push(b.getUint8(i));
    return;
  }
  if (typeof v === "string") {
    const bytes = enc.encode(v);
    head(3, bytes.length, out);
    for (const x of bytes) out.push(x);
    return;
  }
  if (v instanceof Uint8Array) {
    head(2, v.length, out);
    for (const x of v) out.push(x);
    return;
  }
  if (Array.isArray(v)) {
    head(4, v.length, out);
    for (const x of v) encodeInto(x, out);
    return;
  }
  if (v instanceof Map) {
    // Maps allow integer keys (COSE, WebAuthn). Keys are ordered by their encoded form.
    const entries = [...v.entries()].map(([k, x]) => {
      const kb = [];
      encodeInto(k, kb);
      return { kb, x };
    }).sort((p, q) => p.kb.length - q.kb.length || compareBytes(p.kb, q.kb));
    head(5, entries.length, out);
    for (const { kb, x } of entries) {
      for (const byte of kb) out.push(byte);
      encodeInto(x, out);
    }
    return;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => {
        const kb = [];
        encodeInto(k, kb);
        return { kb, x };
      })
      .sort((a, b) => a.kb.length - b.kb.length || compareBytes(a.kb, b.kb));
    head(5, entries.length, out);
    for (const { kb, x } of entries) {
      for (const b of kb) out.push(b);
      encodeInto(x, out);
    }
    return;
  }
  throw new TypeError(`cannot encode ${typeof v}`);
}

function compareBytes(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function encode(value) {
  const out = [];
  encodeInto(value, out);
  return Uint8Array.from(out);
}

export function decode(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  const need = (n) => {
    if (pos + n > bytes.length) throw new RangeError("truncated CBOR");
  };
  const arg = (info) => {
    if (info < 24) return info;
    if (info === 24) { need(1); return bytes[pos++]; }
    if (info === 25) { need(2); const n = view.getUint16(pos); pos += 2; return n; }
    if (info === 26) { need(4); const n = view.getUint32(pos); pos += 4; return n; }
    if (info === 27) {
      need(8);
      const n = view.getBigUint64(pos);
      pos += 8;
      return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
    }
    throw new SyntaxError("indefinite lengths are not allowed");
  };

  function item(depth) {
    if (depth > 64) throw new RangeError("CBOR nested too deeply");
    need(1);
    const ib = bytes[pos++];
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0: return arg(info);
      case 1: { const n = arg(info); return typeof n === "bigint" ? -1n - n : -1 - n; }
      case 2: { const n = arg(info); need(n); const s = bytes.slice(pos, pos + n); pos += n; return s; }
      case 3: { const n = arg(info); need(n); const s = dec.decode(bytes.subarray(pos, pos + n)); pos += n; return s; }
      case 4: { const n = arg(info); const a = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: {
        const n = arg(info);
        const o = {};
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if (typeof k !== "string") throw new SyntaxError("map keys must be text");
          if (Object.hasOwn(o, k)) throw new SyntaxError(`duplicate map key ${k}`);
          o[k] = item(depth + 1);
        }
        return o;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) {
          need(2);
          const h = view.getUint16(pos); pos += 2;
          const e = (h >> 10) & 31, f = h & 1023, s = h & 0x8000 ? -1 : 1;
          if (e === 0) return s * 2 ** -14 * (f / 1024);
          if (e === 31) return f ? NaN : s * Infinity;
          return s * 2 ** (e - 15) * (1 + f / 1024);
        }
        if (info === 26) { need(4); const n = view.getFloat32(pos); pos += 4; return n; }
        if (info === 27) { need(8); const n = view.getFloat64(pos); pos += 8; return n; }
        throw new SyntaxError(`unsupported simple value ${info}`);
      default:
        throw new SyntaxError(`unsupported CBOR major type ${major}`);
    }
  }

  const v = item(0);
  if (pos !== bytes.length) throw new SyntaxError("trailing bytes after CBOR item");
  return v;
}

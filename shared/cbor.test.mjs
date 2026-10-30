import test from "node:test";
import assert from "node:assert/strict";
import { encode, decode } from "./cbor.mjs";

const hex = (u) => Buffer.from(u).toString("hex");

test("RFC 8949 appendix A vectors", () => {
  assert.equal(hex(encode(0)), "00");
  assert.equal(hex(encode(23)), "17");
  assert.equal(hex(encode(24)), "1818");
  assert.equal(hex(encode(1000)), "1903e8");
  assert.equal(hex(encode(1000000)), "1a000f4240");
  assert.equal(hex(encode(-1)), "20");
  assert.equal(hex(encode(-1000)), "3903e7");
  assert.equal(hex(encode("")), "60");
  assert.equal(hex(encode("IETF")), "6449455446");
  assert.equal(hex(encode([1, 2, 3])), "83010203");
  assert.equal(hex(encode(false)), "f4");
  assert.equal(hex(encode(null)), "f6");
  assert.equal(hex(encode(1.1)), "fb3ff199999999999a");
  assert.equal(hex(encode(new Uint8Array([1, 2, 3, 4]))), "4401020304");
});

test("map keys are sorted deterministically", () => {
  const a = encode({ b: 1, aa: 2, a: 3 });
  const b = encode({ a: 3, aa: 2, b: 1 });
  assert.equal(hex(a), hex(b));
  assert.equal(hex(a), "a3616103616201626161 02".replace(" ", ""));
});

test("round trip", () => {
  const v = { s: "héllo", n: [1, -2, 3.5, 2 ** 40], t: true, f: false, z: null, o: { k: [] }, b: new Uint8Array([9]) };
  assert.deepEqual(decode(encode(v)), v);
});

test("rejects trailing bytes, duplicate keys, and indefinite lengths", () => {
  assert.throws(() => decode(Uint8Array.from([0x00, 0x00])));
  assert.throws(() => decode(Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])));
  assert.throws(() => decode(Uint8Array.from([0x9f, 0xff])));
});

test("Map with integer keys encodes deterministically (COSE-style)", () => {
  // {1: 2, 3: -7, -1: 1}  -> keys sorted by encoded form: 1, 3, -1
  const m = new Map([[-1, 1], [3, -7], [1, 2]]);
  assert.equal(hex(encode(m)), "a301020326" + "2001");
});

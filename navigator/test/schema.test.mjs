// The JSON Schema interpreter: every keyword it supports, everything it refuses, hostile input, and a
// differential test against Ajv (the reference implementation) over the real API descriptions.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { Schema, SchemaError } from "../../shared/schema.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (schema, value) => new Schema(schema).check(value) === null;
const bad = (schema, value) => new Schema(schema).check(value) !== null;

// ---- Keywords -----------------------------------------------------------------------------------

test("types: each JSON type matches exactly its own values", () => {
  const values = { string: "x", integer: 3, number: 1.5, boolean: false, object: {}, array: [], null: null };
  for (const [t, v] of Object.entries(values)) {
    for (const [other, w] of Object.entries(values)) {
      const expected = t === other || (t === "number" && other === "integer");
      assert.equal(ok({ type: t }, w), expected, `type ${t} vs a ${other}`);
    }
    assert.equal(ok({ type: t }, v), true);
  }
  assert.equal(ok({ type: ["string", "null"] }, null), true);
  assert.equal(ok({ type: ["string", "null"] }, 3), false);
  assert.equal(ok({ type: "integer" }, 3.0), true, "3.0 is an integer in JSON");
});

test("strings: length counts code points, and patterns are anchored only where the author anchors them", () => {
  assert.equal(ok({ maxLength: 2 }, "\u{1F600}\u{1F600}"), true, "two code points even though four UTF-16 units");
  assert.equal(bad({ maxLength: 2 }, "abc"), true);
  assert.equal(bad({ minLength: 2 }, "a"), true);
  assert.equal(ok({ pattern: "^[a-z]+$" }, "abc"), true);
  assert.equal(bad({ pattern: "^[a-z]+$" }, "abc1"), true);
  assert.equal(ok({ pattern: "b" }, "abc"), true, "unanchored patterns match anywhere");
  assert.equal(ok({ type: "string", minLength: 1 }, 5), false);
  assert.equal(ok({ minLength: 1 }, 5), true, "a string keyword does not constrain a number");
});

test("numbers: bounds, exclusive bounds and multipleOf", () => {
  const s = { type: "number", minimum: 0, maximum: 10, exclusiveMinimum: -1, exclusiveMaximum: 11 };
  assert.deepEqual([-1, 0, 10, 11].map((v) => ok(s, v)), [false, true, true, false]);
  assert.equal(ok({ multipleOf: 0.5 }, 2.5), true);
  assert.equal(ok({ multipleOf: 0.5 }, 2.6), false);
  assert.equal(ok({ multipleOf: 0.1 }, 0.3), true, "floating point noise is tolerated");
  assert.equal(ok({ type: "integer", minimum: 0 }, 2 ** 53), true);
});

test("objects: required, properties, additionalProperties, counts and propertyNames", () => {
  const s = { type: "object", required: ["a"], properties: { a: { type: "integer" }, b: { type: "string" } }, additionalProperties: false };
  assert.equal(ok(s, { a: 1 }), true);
  assert.equal(ok(s, { a: 1, b: "x" }), true);
  assert.equal(bad(s, {}), true);
  assert.equal(bad(s, { a: "1" }), true);
  assert.equal(bad(s, { a: 1, c: 2 }), true);
  assert.equal(ok({ additionalProperties: { type: "integer" } }, { x: 1, y: 2 }), true);
  assert.equal(bad({ additionalProperties: { type: "integer" } }, { x: 1, y: "2" }), true);
  assert.equal(bad({ minProperties: 1 }, {}), true);
  assert.equal(bad({ maxProperties: 1 }, { a: 1, b: 2 }), true);
  assert.equal(ok({ propertyNames: { pattern: "^[a-z]+$" } }, { abc: 1 }), true);
  assert.equal(bad({ propertyNames: { pattern: "^[a-z]+$" } }, { "Not-ok": 1 }), true);
  assert.equal(bad({ required: ["__proto__"] }, JSON.parse("{}")), true);
  assert.equal(ok({ required: ["__proto__"] }, JSON.parse('{"__proto__": 1}')), true, "own properties named like prototype keys count");
  assert.equal(bad({ required: ["toString"] }, {}), true, "inherited properties do not count");
});

test("arrays: items, counts, uniqueness", () => {
  assert.equal(ok({ items: { type: "integer" } }, [1, 2]), true);
  assert.equal(bad({ items: { type: "integer" } }, [1, "2"]), true);
  assert.equal(bad({ minItems: 2 }, [1]), true);
  assert.equal(bad({ maxItems: 1 }, [1, 2]), true);
  assert.equal(ok({ uniqueItems: true }, [1, "1", [1], { a: 1 }]), true);
  assert.equal(bad({ uniqueItems: true }, [{ a: [1, 2] }, { a: [1, 2] }]), true, "structural equality");
  assert.equal(bad({ uniqueItems: true }, [1, 2, 1]), true);
});

test("enum, const, and the combinators", () => {
  assert.equal(ok({ enum: ["a", 1, null, { x: 1 }] }, { x: 1 }), true);
  assert.equal(bad({ enum: ["a", "b"] }, "c"), true);
  assert.equal(bad({ enum: [1] }, "1"), true);
  assert.equal(ok({ const: [1, { a: 2 }] }, [1, { a: 2 }]), true);
  assert.equal(bad({ const: 5 }, 6), true);
  assert.equal(ok({ allOf: [{ type: "integer" }, { minimum: 3 }] }, 4), true);
  assert.equal(bad({ allOf: [{ type: "integer" }, { minimum: 3 }] }, 2), true);
  assert.equal(ok({ anyOf: [{ type: "string" }, { type: "integer" }] }, 3), true);
  assert.equal(bad({ anyOf: [{ type: "string" }, { type: "integer" }] }, null), true);
  assert.equal(ok({ oneOf: [{ type: "string" }, { type: "integer", minimum: 5 }] }, "x"), true, "exactly one matches");
  assert.equal(bad({ oneOf: [{ type: "string" }, { minimum: 5 }] }, "x"), true, "minimum only constrains numbers, so a string matches both");
  assert.equal(bad({ oneOf: [{ type: "integer" }, { minimum: 5 }] }, 7), true, "two match");
  assert.equal(bad({ oneOf: [{ type: "string" }, { type: "integer" }] }, null), true, "none match");
});

test("references: local pointers, recursion, and booleans", () => {
  const tree = { $defs: { node: { type: "object", required: ["v"], properties: { v: { type: "integer" }, kids: { type: "array", items: { $ref: "#/$defs/node" } } }, additionalProperties: false } }, $ref: "#/$defs/node" };
  assert.equal(ok(tree, { v: 1, kids: [{ v: 2, kids: [{ v: 3 }] }] }), true);
  assert.equal(bad(tree, { v: 1, kids: [{ v: 2, kids: [{ v: "x" }] }] }), true);
  assert.equal(ok({ properties: { a: true } }, { a: [1] }), true);
  assert.equal(bad({ properties: { a: false } }, { a: 1 }), true);
  assert.equal(ok({ $defs: { i: { type: "integer" } }, $ref: "#/$defs/i", minimum: 2 }, 3), true, "a reference with sibling keywords: both apply");
  assert.equal(bad({ $defs: { i: { type: "integer" } }, $ref: "#/$defs/i", minimum: 2 }, 1), true);
  assert.equal(ok({ $defs: { "a/b": { type: "integer" } }, $ref: "#/$defs/a~1b" }, 3), true, "~1 escapes a slash in a pointer");
});

test("annotations are ignored; $defs and definitions are containers", () => {
  const s = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "x", title: "t", description: "d", default: 1, examples: [1], type: "integer", $comment: "c" };
  assert.equal(ok(s, 3), true);
  assert.equal(bad(s, "x"), true);
});

// ---- Failing closed -----------------------------------------------------------------------------

test("a keyword the interpreter does not enforce is refused, never silently ignored", () => {
  for (const k of ["not", "if", "then", "else", "patternProperties", "contains", "minContains", "prefixItems", "unevaluatedProperties", "unevaluatedItems", "dependentRequired", "dependentSchemas", "format", "contentEncoding", "$anchor", "$dynamicRef", "additionalItems", "dependencies"]) {
    assert.throws(() => new Schema({ type: "object", [k]: {} }), (e) => e instanceof SchemaError && e.message.includes(k), k);
  }
  assert.throws(() => new Schema({ properties: { a: { format: "email" } } }), SchemaError, "inside a nested schema too");
  assert.throws(() => new Schema({ items: { not: {} } }), SchemaError);
  assert.throws(() => new Schema({ allOf: [{ not: {} }] }), SchemaError);
  assert.throws(() => new Schema({ $defs: { unused: { not: {} } } }), SchemaError, "even in an unreferenced definition");
  assert.throws(() => new Schema({ type: "strng" }), SchemaError);
  assert.throws(() => new Schema({ type: ["string", "wat"] }), SchemaError);
  assert.throws(() => new Schema({ pattern: "([" }), SchemaError);
  assert.throws(() => new Schema({ pattern: 5 }), SchemaError);
  assert.throws(() => new Schema({ $ref: "https://example.com/schema.json" }), SchemaError, "remote references");
  assert.throws(() => new Schema({ $ref: "#/$defs/missing" }), SchemaError);
  assert.throws(() => new Schema("nope"), SchemaError);
  assert.throws(() => new Schema(null), SchemaError);
  assert.throws(() => new Schema({ allOf: {} }), SchemaError);
});

test("patterns that can take exponential time are refused; ordinary ones are not", () => {
  for (const p of ["(a+)+$", "(a*)*", "^(a|b+)*$", "(x{2,})+", "^(\w+\s?)+$"]) assert.throws(() => new Schema({ pattern: p }), SchemaError, p);
  for (const p of ["^(ab)+$", "^[a-z0-9_]{1,40}$", "^(?:foo|bar)$", "^\\(a\\+\\)+$", "^sha256-[A-Za-z0-9_-]{43}$", "^(\\d{3}-){2}\\d{4}$"]) assert.doesNotThrow(() => new Schema({ pattern: p }), p);
  // And the input a pattern is run on is bounded.
  assert.equal(bad({ pattern: "^a+$" }, "a".repeat(5000)), true);
  assert.equal(ok({ pattern: "^a+$" }, "a".repeat(4000)), true);
});

// ---- Hostile input -----------------------------------------------------------------------------

test("values outside the JSON data model never validate, whatever the schema says", () => {
  const anything = { properties: { x: {} } };
  for (const [why, v] of Object.entries({
    "bytes": { x: new Uint8Array(3) }, "bigint": { x: 10n }, "NaN": { x: NaN }, "Infinity": { x: Infinity }, "undefined": { x: undefined },
    "function": { x: () => 1 }, "symbol": { x: Symbol("s") }, "nested bytes": { x: [{ y: new Uint8Array(1) }] },
  })) assert.equal(bad(anything, v), true, why);
  assert.equal(bad({}, new Uint8Array(1)), true);
  assert.equal(bad({}, undefined), true);
});

test("hostile schemas and data cannot hang the host", () => {
  // A reference to itself with nothing consumed: bounded, not infinite.
  const loop = new Schema({ $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" });
  assert.notEqual(loop.check(1), null);
  const loop2 = new Schema({ allOf: [{ $ref: "#" }] });
  assert.notEqual(loop2.check(1), null);

  // Deep data, wide data, many errors.
  let deep = 1;
  for (let i = 0; i < 100; i++) deep = [deep];
  assert.notEqual(new Schema({}).check(deep), null, "nesting beyond the limit is refused");
  const t0 = Date.now();
  const wide = new Schema({ type: "array", items: { type: "object", properties: { a: { type: "integer" } }, additionalProperties: false } });
  assert.equal(wide.check(Array.from({ length: 50_000 }, (_, i) => ({ a: i }))), null);
  const errors = wide.errors(Array.from({ length: 50_000 }, () => ({ a: "x" })));
  assert.equal(errors.length <= 10, true, "the error list is capped");
  assert.ok(Date.now() - t0 < 3000, "large inputs stay fast");

  // The schema is copied: validating cannot be affected by later changes to the original.
  const original = { type: "integer" };
  const s = new Schema(original);
  original.type = "string";
  assert.equal(s.check(3), null);
});

test("error text names where the problem is", () => {
  const s = new Schema({ type: "object", required: ["id"], properties: { id: { type: "integer" }, tags: { type: "array", items: { type: "string" } } }, additionalProperties: false });
  assert.match(s.check({}), /missing required property "id"/);
  assert.match(s.check({ id: "x" }), /\/id: must be integer/);
  assert.match(s.check({ id: 1, tags: ["a", 2] }), /\/tags\/1: must be string/);
  assert.match(s.check({ id: 1, extra: 1 }), /unexpected property "extra"/);
});

// ---- Differential: agree with Ajv on the real API descriptions ------------------------------------

function sample(schema, root = schema) {
  if (schema.$ref) return sample(schema.$ref.slice(2).split("/").reduce((o, k) => o[k], root), root);
  switch (schema.type) {
    case "object": {
      const o = {};
      for (const [k, s] of Object.entries(schema.properties ?? {})) o[k] = sample(s, root);
      return o;
    }
    case "array": return schema.maxItems === 0 ? [] : [sample(schema.items, root)]; // one item, so mutations can reach inside
    case "string": return schema.enum ? schema.enum[0] : "x".repeat(Math.max(schema.minLength ?? 1, 1));
    case "integer": return Math.max(schema.minimum ?? 0, 0);
    case "number": return schema.minimum ?? 0;
    case "boolean": return true;
    default: return null;
  }
}

/** The valid sample plus a spread of ways to break it. */
function mutants(schema, root = schema) {
  const base = sample(schema, root);
  const out = [base, null, [], "x", 5, true, {}];
  const visit = (node, s, path) => {
    const rs = s.$ref ? s.$ref.slice(2).split("/").reduce((o, k) => o[k], root) : s;
    const clone = () => structuredClone(base);
    const at = (c) => path.reduce((o, k) => o[k], c);
    if (rs.type === "object") {
      for (const key of Object.keys(rs.properties ?? {})) {
        const c1 = clone(); delete at(c1)[key]; out.push(c1);
        for (const wrong of [null, "x", 1.5, -1, true, [], {}, 2 ** 40, ""]) { const c = clone(); at(c)[key] = wrong; out.push(c); }
        visit(node, rs.properties[key], [...path, key]);
      }
      const c2 = clone(); at(c2).zzz = 1; out.push(c2);
    }
    if (rs.type === "string") {
      if (rs.maxLength) { const c = clone(); const p = path.slice(0, -1).reduce((o, k) => o[k], c); p[path.at(-1)] = "y".repeat(rs.maxLength + 1); out.push(c); const d = clone(); path.slice(0, -1).reduce((o, k) => o[k], d)[path.at(-1)] = "y".repeat(rs.maxLength); out.push(d); }
      if (rs.minLength) { const c = clone(); path.slice(0, -1).reduce((o, k) => o[k], c)[path.at(-1)] = ""; out.push(c); }
    }
    if (rs.type === "integer" && rs.minimum !== undefined) { const c = clone(); path.slice(0, -1).reduce((o, k) => o[k], c)[path.at(-1)] = rs.minimum - 1; out.push(c); }
    if (rs.type === "array" && rs.items) {
      const c = clone(); at(c).push(structuredClone(sample(rs.items, root))); out.push(c);
      const d = clone(); at(d).push("junk"); out.push(d);
      const e = clone(); at(e).push(...Array.from({ length: (rs.maxItems ?? 3) + 1 }, () => structuredClone(sample(rs.items, root)))); out.push(e);
      if (at(base).length) visit(node, rs.items, [...path, 0]);
    }
  };
  if (schema.type === "object" || schema.properties) visit(base, schema, []);
  return out;
}

test("differential: agrees with Ajv on every method of every API description in the examples", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  let compared = 0;
  let disagreements = [];
  for (const app of ["tasks"]) {
    const api = JSON.parse(readFileSync(join(resolve(here, "..", "..", "examples", app), "api.json"), "utf8"));
    for (const [method, m] of Object.entries(api.methods)) {
      for (const [kind, schema] of [["request", m.request], ["response", m.response]]) {
        const mine = new Schema(schema);
        const ref = ajv.compile(schema);
        for (const v of mutants(schema)) {
          compared++;
          const a = mine.check(v) === null;
          const b = ref(v) === true;
          if (a !== b) disagreements.push(`${method}.${kind}: ${JSON.stringify(v).slice(0, 120)} (mine ${a}, ajv ${b})`);
        }
      }
    }
  }
  assert.ok(compared > 300, `compared ${compared} cases`);
  assert.deepEqual(disagreements, []);
});

test("differential: agrees with Ajv on a corpus covering each supported keyword", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schemas = [
    { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-c]+$" },
    { type: "integer", minimum: -2, maximum: 5, multipleOf: 1 },
    { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
    { type: ["string", "null"] },
    { enum: [1, "a", null, [1], { a: 1 }] },
    { const: { a: [1, 2] } },
    { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 3, uniqueItems: true },
    { type: "object", required: ["a"], properties: { a: { type: "string" } }, additionalProperties: { type: "integer" }, minProperties: 1, maxProperties: 3 },
    { type: "object", additionalProperties: false, properties: { a: {} } },
    { type: "object", propertyNames: { pattern: "^[a-z]+$", maxLength: 3 } },
    { allOf: [{ type: "integer" }, { minimum: 0 }] },
    { anyOf: [{ type: "string", maxLength: 1 }, { type: "integer" }] },
    { oneOf: [{ type: "integer", minimum: 0 }, { type: "integer", maximum: 10 }] },
    { $defs: { n: { type: "object", properties: { c: { type: "array", items: { $ref: "#/$defs/n" } } }, additionalProperties: false } }, $ref: "#/$defs/n" },
  ];
  const values = [null, true, false, 0, 1, -2, -3, 5, 6, 0.5, 1.5, "", "a", "ab", "abc", "abcd", "abcde", "abd", "x", [], [1], [1, 1], [1, 2, 3], [1, 2, 3, 4], ["a"], {}, { a: "x" }, { a: 1 }, { a: "x", b: 2 }, { a: "x", b: "y" }, { b: 1 }, { abc: 1 }, { abcd: 1 }, { ABC: 1 }, { a: [1, 2] }, { c: [{ c: [] }] }, { c: [1] }, { c: {} }];
  let n = 0;
  for (const s of schemas) {
    const mine = new Schema(s);
    const ref = ajv.compile(s);
    for (const v of values) {
      n++;
      assert.equal(mine.check(v) === null, ref(v) === true, `${JSON.stringify(s).slice(0, 90)} vs ${JSON.stringify(v)}`);
    }
  }
  assert.ok(n > 400);
});

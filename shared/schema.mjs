// A JSON Schema interpreter for the subset Lattice API descriptions use (spec/rpc.md).
//
// Why not a general validator: the usual ones compile schemas to JavaScript with `new Function`, which a
// browser page can only allow by weakening its Content-Security-Policy. This one walks the schema instead,
// and it FAILS CLOSED: a keyword it does not implement is an error when the schema is compiled, never a
// constraint that silently stops applying. The same code validates in Node and in the browser, and the
// origin's server uses it too, so both ends of a call agree on what a valid body is.

export class SchemaError extends Error {}

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const KEYWORDS = new Set([
  "$ref", "$defs", "definitions", "type", "enum", "const",
  "properties", "required", "additionalProperties", "minProperties", "maxProperties", "propertyNames",
  "items", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "allOf", "anyOf", "oneOf",
]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/**
 * A quantified group inside a quantified group, such as (a+)+ or (x*)*: the classic way to make a regular
 * expression take exponential time. A conservative heuristic, not a proof: it refuses patterns that look
 * like that, and an author who needs one can restructure it.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;

const MAX_REF_DEPTH = 64;
const MAX_ERRORS = 10;
/** Longer strings are not matched against a `pattern`: author-supplied regular expressions can backtrack. */
const MAX_PATTERN_INPUT = 4096;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Uint8Array) return "bytes"; // not part of the JSON model: matches no type
  switch (typeof v) {
    case "string": return "string";
    case "boolean": return "boolean";
    case "number": return Number.isFinite(v) ? (Number.isInteger(v) ? "integer" : "number") : "nonfinite";
    case "object": return "object";
    default: return "other"; // bigint, undefined, function, symbol
  }
}
const matchesType = (t, actual) => t === actual || (t === "number" && actual === "integer");

/** Structural equality over the JSON model, for `enum`, `const` and `uniqueItems`. */
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

/** Resolve a local JSON Pointer reference such as "#/$defs/task". */
function resolveRef(root, ref) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) throw new SchemaError(`only local references are supported (got "${ref}")`);
  let cur = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(cur) || !Object.hasOwn(cur, key)) throw new SchemaError(`unresolved reference "${ref}"`);
    cur = cur[key];
  }
  return cur;
}

/** Check a schema for anything this interpreter will not enforce, and precompile its regular expressions. */
function prepare(schema, root, path, seen) {
  if (schema === true || schema === false) return;
  if (!isObject(schema)) throw new SchemaError(`${path}: a schema must be an object or boolean`);
  if (seen.has(schema)) return;
  seen.add(schema);
  for (const k of Object.keys(schema)) {
    if (ANNOTATIONS.has(k)) continue;
    if (!KEYWORDS.has(k)) throw new SchemaError(`${path}: unsupported keyword "${k}"`);
  }
  if ("type" in schema) {
    for (const t of Array.isArray(schema.type) ? schema.type : [schema.type]) if (!TYPES.has(t)) throw new SchemaError(`${path}: unknown type "${t}"`);
  }
  if ("pattern" in schema) {
    if (typeof schema.pattern !== "string") throw new SchemaError(`${path}: pattern must be a string`);
    if (NESTED_QUANTIFIER.test(schema.pattern)) throw new SchemaError(`${path}: pattern is refused (a repeated group inside a repeated group can take exponential time)`);
    try { schema.__re = new RegExp(schema.pattern, "u"); } catch { throw new SchemaError(`${path}: invalid pattern`); }
  }
  if ("$ref" in schema) prepare(resolveRef(root, schema.$ref), root, `${path}/$ref`, seen);
  for (const k of ["properties"]) for (const [name, s] of Object.entries(schema[k] ?? {})) prepare(s, root, `${path}/${k}/${name}`, seen);
  for (const k of ["$defs", "definitions"]) for (const [name, s] of Object.entries(schema[k] ?? {})) prepare(s, root, `${path}/${k}/${name}`, seen);
  for (const k of ["additionalProperties", "items", "propertyNames"]) if (k in schema) prepare(schema[k], root, `${path}/${k}`, seen);
  for (const k of ["allOf", "anyOf", "oneOf"]) {
    if (k in schema && !Array.isArray(schema[k])) throw new SchemaError(`${path}/${k}: must be an array`);
    (schema[k] ?? []).forEach((s, i) => prepare(s, root, `${path}/${k}/${i}`, seen));
  }
}

function check(schema, root, value, path, errors, depth) {
  if (errors.length >= MAX_ERRORS) return;
  if (schema === true) return;
  const fail = (msg) => { if (errors.length < MAX_ERRORS) errors.push(`${path || "/"}: ${msg}`); };
  if (schema === false) return fail("nothing is allowed here");
  if (depth > MAX_REF_DEPTH) return fail("schema recursion is too deep");

  if ("$ref" in schema) check(resolveRef(root, schema.$ref), root, value, path, errors, depth + 1);

  const actual = typeOf(value);
  if ("type" in schema) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(t, actual))) return fail(`must be ${allowed.join(" or ")}`);
  }
  if ("enum" in schema && !schema.enum.some((e) => same(e, value))) fail("is not one of the allowed values");
  if ("const" in schema && !same(schema.const, value)) fail("does not equal the required value");

  if (actual === "string") {
    const len = [...value].length; // code points, as JSON Schema counts them
    if ("minLength" in schema && len < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
    if ("maxLength" in schema && len > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (schema.__re) {
      if (value.length > MAX_PATTERN_INPUT) fail("is too long to match against its pattern");
      else if (!schema.__re.test(value)) fail("does not match the required pattern");
    }
  }

  if (actual === "integer" || actual === "number") {
    if ("minimum" in schema && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
    if ("maximum" in schema && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
    if ("exclusiveMinimum" in schema && value <= schema.exclusiveMinimum) fail(`must be greater than ${schema.exclusiveMinimum}`);
    if ("exclusiveMaximum" in schema && value >= schema.exclusiveMaximum) fail(`must be less than ${schema.exclusiveMaximum}`);
    if ("multipleOf" in schema) {
      const q = value / schema.multipleOf;
      if (!Number.isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9) fail(`must be a multiple of ${schema.multipleOf}`);
    }
  }

  if (actual === "array") {
    if ("minItems" in schema && value.length < schema.minItems) fail(`must have at least ${schema.minItems} items`);
    if ("maxItems" in schema && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems && value.some((a, i) => value.slice(0, i).some((b) => same(a, b)))) fail("items must be unique");
    if ("items" in schema) value.forEach((item, i) => check(schema.items, root, item, `${path}/${i}`, errors, depth + 1));
  }

  if (actual === "object") {
    const keys = Object.keys(value);
    if ("minProperties" in schema && keys.length < schema.minProperties) fail(`must have at least ${schema.minProperties} properties`);
    if ("maxProperties" in schema && keys.length > schema.maxProperties) fail(`must have at most ${schema.maxProperties} properties`);
    for (const r of schema.required ?? []) if (!Object.hasOwn(value, r)) fail(`is missing required property "${r}"`);
    const props = schema.properties ?? {};
    for (const k of keys) {
      if ("propertyNames" in schema) check(schema.propertyNames, root, k, `${path}/${k}#name`, errors, depth + 1);
      if (Object.hasOwn(props, k)) check(props[k], root, value[k], `${path}/${k}`, errors, depth + 1);
      else if ("additionalProperties" in schema) {
        if (schema.additionalProperties === false) fail(`has unexpected property "${k}"`);
        else check(schema.additionalProperties, root, value[k], `${path}/${k}`, errors, depth + 1);
      }
    }
  }

  const run = (s) => { const e = []; check(s, root, value, path, e, depth + 1); return e; };
  for (const s of schema.allOf ?? []) for (const e of run(s)) if (errors.length < MAX_ERRORS) errors.push(e);
  if (schema.anyOf && !schema.anyOf.some((s) => run(s).length === 0)) fail("does not match any of the allowed shapes");
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => run(s).length === 0).length;
    if (n !== 1) fail(n === 0 ? "does not match any of the allowed shapes" : "matches more than one of the allowed shapes");
  }
}

/** Why `value` is not made of JSON data (strings, finite numbers, booleans, null, arrays, objects), or null. */
function notJson(value, depth = 0) {
  if (depth > 64) return "is nested too deeply";
  const t = typeOf(value);
  if (t === "bytes" || t === "nonfinite" || t === "other") return `contains a value outside the JSON data model (${t === "other" ? typeof value : t})`;
  if (t === "array") for (const v of value) { const w = notJson(v, depth + 1); if (w) return w; }
  if (t === "object") for (const v of Object.values(value)) { const w = notJson(v, depth + 1); if (w) return w; }
  return null;
}

export class Schema {
  #root;
  /** Throws SchemaError if the schema uses anything this interpreter does not enforce. */
  constructor(schema) {
    // Work on a copy: preparation attaches compiled regular expressions.
    this.#root = structuredClone(schema);
    prepare(this.#root, this.#root, "#", new Set());
  }

  /** Why `value` does not satisfy the schema, as a list of "path: message" (empty when it does). */
  errors(value) {
    const outside = notJson(value);
    if (outside) return [`/: ${outside}`];
    const errors = [];
    check(this.#root, this.#root, value, "", errors, 0);
    return errors;
  }

  /** null when valid, else a single readable string. */
  check(value) {
    const e = this.errors(value);
    return e.length ? e.join("; ") : null;
  }
}

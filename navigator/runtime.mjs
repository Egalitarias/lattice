// Lattice Navigator runtime: discover -> verify -> prepare.
//
//   1. GET the URL with Accept: application/vnd.lattice.app+cbor and decode the manifest.
//   2. Validate it against the manifest schema and check it belongs to this origin.
//   3. Fetch the entry component (and the API description, if any) by content hash and verify
//      each hash before using a byte of it.
//   4. Transpile the component (jco), cached by hash. Instantiation happens in the worker.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transpile } from "@bytecodealliance/jco";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { decode } from "../shared/cbor.mjs";

export const MANIFEST_TYPE = "application/vnd.lattice.app+cbor";
const here = dirname(fileURLToPath(import.meta.url));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const loadSchema = (name) => ajv.compile(JSON.parse(readFileSync(join(here, "..", "spec", name), "utf8")));
const validateManifest = loadSchema("manifest.schema.json");
const validateApi = loadSchema("api.schema.json");

export class LoadError extends Error {}

export const hashOf = (bytes) => "sha256-" + createHash("sha256").update(bytes).digest("base64url");

const isLoopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/**
 * Fetch and verify an app. `dev` permits plain http on loopback and a manifest domain that
 * differs from the loopback address being fetched.
 */
export async function fetchApp(url, { dev = false } = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(dev && u.protocol === "http:" && isLoopback(u.hostname))) {
    throw new LoadError(`refusing ${u.protocol}//${u.host}: Lattice requires https (http is allowed on loopback with --dev)`);
  }

  const res = await fetch(u, { headers: { Accept: `${MANIFEST_TYPE}, text/html;q=0.1` }, redirect: "error" });
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (type !== MANIFEST_TYPE) {
    throw new LoadError(`${u.host} did not offer ${MANIFEST_TYPE} (got ${type || "no content type"}); it is not a Lattice app`);
  }
  let manifest;
  try {
    manifest = decode(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    throw new LoadError(`manifest is not valid CBOR: ${e.message}`);
  }
  if (!validateManifest(manifest)) {
    throw new LoadError("manifest does not match the schema:\n  " + ajv.errorsText(validateManifest.errors, { separator: "\n  " }));
  }
  if (manifest.app !== u.hostname) {
    if (!dev) throw new LoadError(`manifest is for ${manifest.app} but was served from ${u.hostname}`);
    console.warn(`navigator: --dev: accepting manifest for ${manifest.app} served from ${u.host}`);
  }

  const wasm = await fetchBlob(u, manifest.entry);

  let api = null;
  if (manifest.api) {
    const declared = new URL(manifest.api.url);
    if (declared.hostname !== manifest.app) {
      throw new LoadError(`api.url is on ${declared.hostname}, not the app's origin ${manifest.app}; cross-origin APIs are not supported yet`);
    }
    let description;
    try {
      description = JSON.parse(Buffer.from(await fetchBlob(u, manifest.api.schema)).toString("utf8"));
    } catch (e) {
      if (e instanceof LoadError) throw e;
      throw new LoadError(`API description is not valid JSON: ${e.message}`);
    }
    if (!validateApi(description)) {
      throw new LoadError("API description does not match the schema:\n  " + ajv.errorsText(validateApi.errors, { separator: "\n  " }));
    }
    // The declared URL names the app's origin; we reach it at the address we fetched the manifest from.
    api = { description, hash: manifest.api.schema, endpoint: new URL(declared.pathname, u.origin).href };
  }

  let tokenEndpoint = null;
  if (manifest.auth?.token_endpoint) {
    const declared = new URL(manifest.auth.token_endpoint);
    if (declared.hostname !== manifest.app) {
      throw new LoadError(`auth.token_endpoint is on ${declared.hostname}, not the app's origin ${manifest.app}`);
    }
    tokenEndpoint = new URL(declared.pathname, u.origin).href;
  }
  return { url: u, manifest, wasm, api, tokenEndpoint };
}

async function fetchBlob(origin, hash) {
  const res = await fetch(new URL(`/.lattice/blob/${hash}`, origin), { redirect: "error" });
  if (!res.ok) throw new LoadError(`could not fetch ${hash}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = hashOf(bytes);
  if (actual !== hash) {
    throw new LoadError(`hash mismatch: manifest says ${hash}, server sent ${actual}`);
  }
  return bytes;
}

/**
 * Transpile to JS + core wasm (cached by hash) and return the entry module path.
 * The cache is content-addressed and written atomically, so concurrent processes can share it.
 */
export async function prepareComponent({ manifest, wasm, cacheDir }) {
  const outDir = join(cacheDir, manifest.entry.replace("sha256-", ""));
  const entryJs = join(outDir, "app.js");
  if (existsSync(entryJs)) return entryJs;

  const { files } = await transpile(wasm, { name: "app", instantiation: "async", noTypescript: true });
  const tmp = `${outDir}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  for (const [name, data] of Object.entries(files)) {
    const p = join(tmp, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }
  try {
    renameSync(tmp, outDir); // all-or-nothing
  } catch {
    rmSync(tmp, { recursive: true, force: true }); // another process got there first
  }
  if (!existsSync(entryJs)) throw new LoadError("could not prepare the component");
  return entryJs;
}

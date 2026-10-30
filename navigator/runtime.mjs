// Lattice Navigator runtime: discover -> verify -> load -> instantiate.
//
//   1. GET the URL with Accept: application/vnd.lattice.app+cbor and decode the manifest.
//   2. Validate it against the manifest schema and check it belongs to this origin.
//   3. Fetch the entry component by content hash and verify the hash before using a byte of it.
//   4. Transpile it (jco) and instantiate it with ONLY the host imports the manifest allows.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transpile } from "@bytecodealliance/jco";
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { decode } from "../shared/cbor.mjs";
import { hostImports, CAPABILITY_IMPORTS } from "./host.mjs";

export const MANIFEST_TYPE = "application/vnd.lattice.app+cbor";
const here = dirname(fileURLToPath(import.meta.url));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateManifest = ajv.compile(JSON.parse(readFileSync(join(here, "..", "spec", "manifest.schema.json"), "utf8")));

export class LoadError extends Error {}

export const hashOf = (bytes) => "sha256-" + createHash("sha256").update(bytes).digest("base64url");

const isLoopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/**
 * Fetch and verify an app. `dev` permits plain http on loopback and a manifest domain that
 * differs from the loopback address being fetched.
 */
export async function fetchApp(url, { dev = false, cacheDir }) {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(dev && u.protocol === "http:" && isLoopback(u.hostname))) {
    throw new LoadError(`refusing ${u.protocol}//${u.host}: Lattice requires https (http is allowed on loopback with --dev)`);
  }

  const res = await fetch(u, { headers: { Accept: `${MANIFEST_TYPE}, text/html;q=0.1` } });
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

  const bytes = await fetchBlob(u, manifest.entry);
  mkdirSync(cacheDir, { recursive: true });
  return { url: u, manifest, wasm: bytes };
}

async function fetchBlob(origin, hash) {
  const res = await fetch(new URL(`/.lattice/blob/${hash}`, origin));
  if (!res.ok) throw new LoadError(`could not fetch component ${hash}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = hashOf(bytes);
  if (actual !== hash) {
    throw new LoadError(`component hash mismatch: manifest says ${hash}, server sent ${actual}`);
  }
  return bytes;
}

/** Transpile (cached by hash) and instantiate with sandboxed WASI and manifest-gated host imports. */
export async function instantiateApp({ manifest, wasm, origin, dataDir, cacheDir, onLog }) {
  const outDir = join(cacheDir, manifest.entry.replace("sha256-", ""));
  const entryJs = join(outDir, "app.js");
  if (!existsSync(entryJs)) {
    const { files } = await transpile(wasm, { name: "app", instantiation: "async", noTypescript: true });
    for (const [name, data] of Object.entries(files)) {
      const p = join(outDir, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    }
  }

  const { instantiate } = await import(pathToFileURL(entryJs).href);
  const getCoreModule = async (path) => WebAssembly.compile(readFileSync(join(outDir, path)));

  // The only WASI the app sees: no filesystem, no environment, no network.
  const wasi = new WASIShim({ sandbox: { preopens: {}, env: {}, args: ["app"], enableNetwork: false } }).getImportObject();

  const granted = new Set([...(manifest.capabilities?.requires ?? []), ...(manifest.capabilities?.optional ?? [])]);
  const imports = { ...wasi, ...hostImports({ granted, origin, dataDir, onLog }) };

  let instance;
  try {
    instance = await instantiate(getCoreModule, imports);
  } catch (e) {
    // A missing import means the component wants something the manifest did not grant.
    if (e instanceof TypeError) {
      throw new LoadError(
        `component could not be linked: ${e.message}. It likely imports a capability that the manifest does not request ` +
          `or that this Lattice Navigator does not implement. Implemented imports: ${Object.keys(CAPABILITY_IMPORTS).join(", ")}`
      );
    }
    throw e;
  }
  return instance.lifecycle;
}

// Lattice Navigator runtime: discover -> verify -> prepare.
//
//   1. GET the URL with Accept: application/vnd.lattice.app+cbor and decode the manifest.
//   2. Validate it against the manifest schema and check it belongs to this origin.
//   3. Fetch the entry component (and the API description, if any) by content hash and verify
//      each hash before using a byte of it.
//   4. Turning the component into runnable code is the environment's job (runtime-node.mjs, or the browser's
//      own transpile step): this file only decides what may be trusted, and does so identically everywhere.

import { decode } from "../shared/cbor.mjs";
import { hashOf, fromUtf8 } from "./bytes.mjs";
import { checkManifest, checkApiDescription } from "./validators.mjs";

export const MANIFEST_TYPE = "application/vnd.lattice.app+cbor";
export class LoadError extends Error {}

const isLoopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/**
 * Fetch and verify an app. `dev` permits plain http on loopback and a manifest domain that
 * differs from the loopback address being fetched.
 */
export async function fetchApp(url, { dev = false, strictDomain = false } = {}) {
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
  const manifestProblem = checkManifest(manifest);
  if (manifestProblem) throw new LoadError("manifest does not match the schema:\n  " + manifestProblem);
  if (manifest.app !== u.hostname) {
    // In development a Node Navigator fetches from a loopback address while the manifest names the app's domain. A browser
    // Navigator is served by the app's own origin, so there the two must always match: pass strictDomain.
    if (!dev || strictDomain) throw new LoadError(`manifest is for ${manifest.app} but was served from ${u.hostname}`);
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
      description = JSON.parse(fromUtf8(await fetchBlob(u, manifest.api.schema)));
    } catch (e) {
      if (e instanceof LoadError) throw e;
      throw new LoadError(`API description is not valid JSON: ${e.message}`);
    }
    const apiProblem = checkApiDescription(description);
    if (apiProblem) throw new LoadError("API description does not match the schema:\n  " + apiProblem);
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

  let paymentsEndpoint = null;
  if (manifest.payments?.server) {
    const declared = new URL(manifest.payments.server);
    if (declared.hostname !== manifest.app) {
      throw new LoadError(`payments.server is on ${declared.hostname}, not the app's origin ${manifest.app}`);
    }
    paymentsEndpoint = new URL(declared.pathname, u.origin).href;
  }

  // Analytics processors on the app's own origin are reached at the address we fetched from; others as declared.
  let analyticsProcessors = null;
  if (manifest.analytics?.processors?.length) {
    analyticsProcessors = manifest.analytics.processors.map((p) => {
      const declared = new URL(p.endpoint);
      const endpoint = declared.hostname === manifest.app ? new URL(declared.pathname + declared.search, u.origin).href : p.endpoint;
      return { name: p.name, endpoint, purposes: p.purposes };
    });
  }
  return { url: u, manifest, wasm, api, tokenEndpoint, paymentsEndpoint, analyticsProcessors };
}

export async function fetchBlob(origin, hash) {
  const res = await fetch(new URL(`/.lattice/blob/${hash}`, origin), { redirect: "error" });
  if (!res.ok) throw new LoadError(`could not fetch ${hash}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = await hashOf(bytes);
  if (actual !== hash) {
    throw new LoadError(`hash mismatch: manifest says ${hash}, server sent ${actual}`);
  }
  return bytes;
}

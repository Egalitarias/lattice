// Turns a hash-verified component into runnable code in the browser: transpile in a Worker (the transpiler is
// several megabytes of WebAssembly), and cache the result in IndexedDB under the component's hash so the work is
// done once per component version.

import { TRANSPILE_VERSION } from "../transpile-options.mjs";

const DB = "lattice-navigator";
const STORE = "components";

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const request = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

async function cached(key) {
  const db = await open();
  try { return await request(db.transaction(STORE).objectStore(STORE).get(key)); } finally { db.close(); }
}
async function remember(key, files) {
  const db = await open();
  try { await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(files, key)); } finally { db.close(); }
}

function transpileInWorker(wasm, workerUrl) {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerUrl, { type: "module", name: "lattice-transpile" });
    const done = (fn, v) => { w.terminate(); fn(v); };
    w.onmessage = (e) => (e.data.error ? done(reject, new Error(`could not prepare the component: ${e.data.error}`)) : done(resolve, e.data.files));
    w.onerror = (e) => done(reject, new Error(`could not prepare the component: ${e.message}`));
    const copy = wasm.slice(); // keep the caller's bytes: they were just verified
    w.postMessage({ id: 1, wasm: copy.buffer }, [copy.buffer]);
  });
}

/** `wasm` has already been verified against `manifest.entry`. Returns { "app.js": bytes, "app.core.wasm": bytes, ... }. */
export async function prepareComponent({ manifest, wasm, workerUrl }) {
  const key = `${TRANSPILE_VERSION}:${manifest.entry}`;
  try {
    const hit = await cached(key);
    if (hit && hit["app.js"]) return hit;
  } catch { /* no cache available: transpile every time */ }
  const files = await transpileInWorker(wasm, workerUrl);
  try { await remember(key, files); } catch { /* quota or a private window: fine */ }
  return files;
}

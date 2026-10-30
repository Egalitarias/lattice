// The Node entry for the component's thread. The logic is in component-runtime.mjs; this supplies what is
// specific to Node: the message port, how the transpiled module is loaded, and a sandboxed WASI.

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import { runComponent } from "./component-runtime.mjs";

const { entryJs } = workerData.component;

const ready = await runComponent({
  port: { post: (m) => parentPort.postMessage(m), onMessage: (fn) => parentPort.on("message", fn) },
  config: workerData,
  loadModule: () => import(pathToFileURL(entryJs).href),
  compile: async (path) => WebAssembly.compile(readFileSync(join(dirname(entryJs), path))),
  // The only WASI the component sees: no filesystem, no environment, no network.
  wasiImports: new WASIShim({ sandbox: { preopens: {}, env: {}, args: ["app"], enableNetwork: false } }).getImportObject(),
});
if (!ready) process.exit(0);

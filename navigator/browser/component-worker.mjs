// The browser entry for the component's thread. The logic is in component-runtime.mjs; this supplies what is
// specific to a browser Worker: the message port, loading the transpiled module, and a sandboxed WASI.
//
// The origin serves this script with `connect-src 'none'`: the component's thread cannot open a network
// connection at all. Everything it can reach is a host import.

import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";
import { runComponent } from "../component-runtime.mjs";

let handler = null;
let started = false;

self.addEventListener("message", async (e) => {
  if (started) return void handler?.(e.data);
  started = true;
  const { data } = e.data;
  const { files } = data.component;

  const ready = await runComponent({
    port: { post: (m) => self.postMessage(m), onMessage: (fn) => { handler = fn; } },
    config: data,
    // The transpiled module is code the host generated from the hash-verified component. It loads from a blob
    // URL, which this script's own CSP allows (and the page's does not).
    loadModule: () => import(URL.createObjectURL(new Blob([files["app.js"]], { type: "text/javascript" }))),
    compile: async (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`the component asked for a module it does not have: ${path}`);
      return WebAssembly.compile(files[path]);
    },
    wasiImports: new WASIShim({ sandbox: { preopens: {}, env: {}, args: ["app"], enableNetwork: false } }).getImportObject(),
  });
  if (!ready) self.close();
});

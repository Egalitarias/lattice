// Turns a component (already verified against its hash by the page) into JavaScript plus core WebAssembly
// modules. Runs in its own Worker because the transpiler is several megabytes of WebAssembly and takes a
// moment: the page stays responsive, and the result is cached by the page, keyed by the component's hash.

import { $init, generate } from "@bytecodealliance/jco-transpile/component";
import { generateOptions } from "../transpile-options.mjs";

self.onmessage = async (e) => {
  const { id, wasm } = e.data;
  try {
    await $init;
    const out = generate(new Uint8Array(wasm), generateOptions("app"));
    const files = Object.fromEntries(out.files);
    self.postMessage({ id, files }, Object.values(files).map((b) => b.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

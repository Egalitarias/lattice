// SPIKE: instantiate a transpiled component in a worker with the browser WASI shim, and block on a
// SharedArrayBuffer the way the real component worker will.
import { WASIShim } from "@bytecodealliance/preview2-shim/instantiation";

self.onmessage = async (e) => {
  const { files, sab } = e.data;
  const result = { steps: [] };
  try {
    result.crossOriginIsolated = self.crossOriginIsolated;
    result.sabAvailable = typeof SharedArrayBuffer !== "undefined";
    // Blocking: wait on a cell that the page fills in a moment later.
    const ctrl = new Int32Array(sab);
    self.postMessage({ type: "need-notify" });
    const t0 = performance.now();
    const waited = Atomics.wait(ctrl, 0, 0, 3000);
    result.atomicsWait = { outcome: waited, ms: Math.round(performance.now() - t0), value: Atomics.load(ctrl, 1) };

    const text = new TextDecoder().decode(files["app.js"]);
    result.hasComponentError = text.includes("class ComponentError");
    result.jsBytes = files["app.js"].length;
    const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    const mod = await import(url);
    const getCoreModule = async (path) => WebAssembly.compile(files[path]);
    const logs = [];
    const store = new Map();
    const imports = {
      ...new WASIShim().getImportObject(),
      "lattice:app/log": { write: (level, msg) => logs.push([level, msg]) },
      "lattice:app/storage": {
        get: (k) => store.get(k),
        set: (k, v) => void store.set(k, v),
        delete: (k) => void store.delete(k),
        listKeys: (p) => [...store.keys()].filter((k) => k.startsWith(p)),
      },
    };
    const instance = await mod.instantiate(getCoreModule, imports);
    result.steps.push("instantiated");
    const lc = instance.lifecycle;
    lc.init({ origin: "todo.localhost", locale: "en-US", colorScheme: "light", reducedMotion: false, textScale: 1, online: true, granted: [], oidcIssuers: [] });
    result.steps.push("init");
    const scene = lc.route({ handler: "Home", path: "/", params: [], query: [] });
    result.title = scene.title;
    result.nodes = scene.nodes.length;
    result.childrenType = Object.prototype.toString.call(scene.nodes[0].children);
    // An app error carries its payload.
    try { lc.route({ handler: "Nope", path: "/x", params: [], query: [] }); } catch (err) { result.errorPayload = err.payload; result.errorIsComponentError = err.constructor.name; }
    result.logs = logs;
  } catch (err) {
    result.error = String(err?.stack ?? err);
  }
  self.postMessage({ type: "done", result });
};

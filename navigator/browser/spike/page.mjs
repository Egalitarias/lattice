// SPIKE page: fetch a component, verify its hash, transpile it in a worker, run it in another.
const out = { t: {} };
async function main() {
  const res = await fetch("/todo.wasm");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const t0 = performance.now();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  out.hash = "sha256-" + btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  out.t.hash = Math.round(performance.now() - t0);

  const tw = new Worker("/dist/transpile-worker.js", { type: "module" });
  const files = await new Promise((resolve, reject) => {
    tw.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.files));
    tw.onerror = (e) => reject(new Error("transpile worker: " + e.message));
    const t1 = performance.now();
    tw.postMessage({ id: 1, wasm: bytes.buffer.slice(0) });
    out.t.start = t1;
  });
  out.t.transpile = Math.round(performance.now() - out.t.start);
  delete out.t.start;
  out.files = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length]));

  const sab = new SharedArrayBuffer(16);
  const rw = new Worker("/dist/run-worker.js", { type: "module" });
  out.run = await new Promise((resolve, reject) => {
    rw.onmessage = (e) => {
      if (e.data.type === "need-notify") {
        setTimeout(() => { const c = new Int32Array(sab); Atomics.store(c, 1, 42); Atomics.store(c, 0, 1); Atomics.notify(c, 0); }, 150);
      } else if (e.data.type === "done") resolve(e.data.result);
    };
    rw.onerror = (e) => reject(new Error("run worker: " + e.message));
    rw.postMessage({ files, sab });
  });
}
main().then(() => { window.__spike = out; }, (e) => { window.__spike = { error: String(e.stack ?? e), ...out }; });

// How a browser starts a component thread, in the shape AppHost expects: spawn(workerData) -> a handle with
// postMessage, terminate, and onMessage / onError slots. (A Web Worker has no exit event: a worker that dies
// reports an error, and the watchdog covers one that goes silent.)

export function webSpawn(workerUrl) {
  return (workerData) => {
    const w = new Worker(workerUrl, { type: "module", name: "lattice-component" });
    const handle = {
      postMessage: (m) => w.postMessage(m),
      terminate: () => w.terminate(),
      onMessage: null,
      onError: null,
      onExit: null,
    };
    w.onmessage = (e) => handle.onMessage?.(e.data);
    w.onerror = (e) => {
      e.preventDefault();
      handle.onError?.(new Error(e.message || "the component's thread failed"));
    };
    w.onmessageerror = () => handle.onError?.(new Error("the component's thread sent something unreadable"));
    w.postMessage({ type: "init", data: workerData }); // the SharedArrayBuffer and the component travel with this
    return handle;
  };
}

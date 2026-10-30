// How Node starts a component thread, in the shape AppHost expects: spawn(workerData) -> a handle with
// postMessage, terminate, and onMessage / onError / onExit slots.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const workerFile = join(dirname(fileURLToPath(import.meta.url)), "app-worker.mjs");

export function nodeSpawn(workerData) {
  const w = new Worker(workerFile, {
    workerData,
    // The component gets no environment and no stdio of its own.
    env: {},
    stdout: false,
    stderr: false,
  });
  const handle = {
    postMessage: (m) => w.postMessage(m),
    terminate: () => w.terminate(),
    onMessage: null,
    onError: null,
    onExit: null,
  };
  w.on("message", (m) => handle.onMessage?.(m));
  w.on("error", (e) => handle.onError?.(e));
  w.on("exit", () => handle.onExit?.());
  return handle;
}

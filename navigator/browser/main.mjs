// Lattice Navigator in the browser.
//
// The app's own origin serves this page to browsers (spec/browser.md). It does what the Node Navigator does, in the
// page: discover the app on this very origin, verify the component's hash, transpile it, run it in a Worker, and
// draw what it returns. Because the page IS the app's origin, RPC and the token and payment endpoints are same-origin,
// passkeys are bound to the real domain, and OIDC and payment redirects come straight back to this origin.
//
// The app's code never runs on this page: it runs in a Worker whose script is served with `connect-src 'none'`.

import { fetchApp } from "../runtime.mjs";
import { Controller, HttpError } from "../controller.mjs";
import { prepareComponent } from "./transpile.mjs";
import { webSpawn } from "./spawn-web.mjs";
import { LocalStorageKv } from "./kv-browser.mjs";
import { mountUi } from "../ui/ui-core.js";

const CALLBACKS = {
  "/_navigator/auth/callback": "auth",
  "/_navigator/payment/return": "payment-return",
  "/_navigator/payment/cancel": "payment-cancel",
};
const CHANNEL = "lattice-navigator";
const isLoopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

const appEl = document.getElementById("app");
function show(message, { alert = false } = {}) {
  const p = document.createElement("p");
  if (alert) p.setAttribute("role", "alert");
  p.textContent = message;
  appEl.replaceChildren(p);
}

// ---- A popup the identity provider or payment processor sent back here ----------------------------
// This window was opened by the app window with `noopener`, so it cannot call it. It tells it over a
// same-origin BroadcastChannel and shows the user the answer. The window that owns the pending request
// accepts the single-use `state`; any other open tab refuses it.

async function relayCallback(kind) {
  const channel = new BroadcastChannel(CHANNEL);
  const id = crypto.randomUUID();
  const search = location.search;
  history.replaceState(null, "", location.pathname); // the code and state should not linger in the address bar or history

  const answer = await new Promise((resolve) => {
    let refusal = null;
    const give = setTimeout(() => resolve(refusal), 4000);
    channel.onmessage = (e) => {
      const m = e.data;
      if (!m || m.type !== "callback-result" || m.id !== id) return;
      if (m.ok) { clearTimeout(give); resolve(m); }
      else {
        refusal ??= m;
        setTimeout(() => resolve(refusal), 800); // another tab may still accept it
      }
    };
    channel.postMessage({ type: "callback", id, kind, search });
  });
  channel.close();
  document.title = "Lattice Navigator";
  show(answer?.message ?? "Return to the app window and try again: this link only works while it is open.", { alert: !answer?.ok });
}

// ---- The app ------------------------------------------------------------------------------------

async function main() {
  const callback = CALLBACKS[location.pathname];
  if (callback) return relayCallback(callback);

  if (!self.crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the host cannot run the app safely. The site must send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy headers.");
  }
  const dev = location.protocol === "http:" && isLoopback(location.hostname);
  const log = (level, message) => console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[app ${level}] ${message}`);

  // A service worker keeps components and the host's own files across visits. The app works without it.
  navigator.serviceWorker?.register(new URL("sw.js", import.meta.url), { scope: "/" }).catch(() => {});

  show("Loading…");
  const { wasm, url: _url, ...app } = await fetchApp(`${location.origin}/`, { dev, strictDomain: true });
  const files = await prepareComponent({ manifest: app.manifest, wasm, workerUrl: new URL("transpile-worker.js", import.meta.url) });

  const controller = new Controller({
    app,
    kv: new LocalStorageKv("lattice:"),
    spawn: webSpawn(new URL("component-worker.js", import.meta.url)),
    component: { files },
    uiOrigin: () => location.origin,
    dev,
    log,
  });
  await controller.start(location.pathname + location.search);

  const listeners = new Set();
  controller.subscribe((m) => listeners.forEach((f) => f(m)));

  // Callbacks relayed by popups.
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e) => {
    const m = e.data;
    if (!m || m.type !== "callback" || typeof m.id !== "string" || typeof m.search !== "string" || m.search.length > 4096) return;
    const params = new URLSearchParams(m.search);
    let r;
    if (m.kind === "auth") r = controller.authCallback(params);
    else if (m.kind === "payment-return") r = controller.paymentCallback("return", params);
    else if (m.kind === "payment-cancel") r = controller.paymentCallback("cancel", params);
    else return;
    channel.postMessage({ type: "callback-result", id: m.id, ok: r.ok, message: r.message });
  };

  appEl.replaceChildren();
  mountUi({
    async post(endpoint, body) {
      try {
        await controller.handle(endpoint, body);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof HttpError ? e.message : "Something went wrong." };
      }
    },
    subscribe(handler) {
      listeners.add(handler);
      queueMicrotask(() => handler(controller.current())); // like the first message of the server-sent stream
      return () => listeners.delete(handler);
    },
    state: async () => controller.current(),
  });

  // Tests drive a few things the user would not (flush analytics now); never offered outside loopback development.
  if (dev) globalThis.latticeDebug = { controller };
}

main().catch((e) => {
  console.error(e);
  show(`This app could not be loaded: ${e?.message ?? e}`, { alert: true });
});

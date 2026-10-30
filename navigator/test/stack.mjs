// Shared test harness: a development IdP, a Stripe-compatible processor, the tasks origin, and Navigator,
// wired together the way they run for real, plus helpers that play the part of the user's browser.

import test from "node:test";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer } from "../../server/server.mjs";
import { startIdp } from "../../server/dev-idp.mjs";
import { startPsp } from "../../server/dev-psp.mjs";
import { startNavigator } from "../navigator.mjs";
import { RPC_TYPE } from "../../server/rpc.mjs";
import { encode, decode } from "../../shared/cbor.mjs";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
export const tasksDir = resolve(here, "..", "..", "examples", "tasks");
export const quiet = () => {};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
export const close = (server) => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); });
export const find = (n, pred) => (pred(n) ? n : n.children.map((c) => find(c, pred)).find(Boolean));
export const all = (n, pred, out = []) => (pred(n) && out.push(n), n.children.forEach((c) => all(c, pred, out)), out);
export const b64u = (b) => Buffer.from(b).toString("base64url");

// Transpiled components are content-addressed, so every test can share one cache.
export const SHARED_CACHE = join(tmpdir(), "lattice-navigator-test-cache");

// ---- A complete stack: dev IdP + tasks origin + Navigator ---------------------------------------

export async function withStack(fn, { requires, clientSecret, authTimeoutMs, watchdogMs, trustIdp = true, psp: wantPsp = false, pspOptions = {}, analyticsOptions } = {}) {
  const idp = await startIdp({ clientSecret });
  const psp = wantPsp ? await startPsp(pspOptions) : null;
  const app = await loadApp({
    appDir: tasksDir,
    oidc: trustIdp ? [{ issuer: idp.issuer, clientId: idp.clientId, clientSecret }] : [],
    dev: true,
    stripe: psp ? { secretKey: psp.secretKey, webhookSecret: psp.webhookSecret, api: { protocol: "http", host: "127.0.0.1", port: psp.port } } : null,
    log: quiet,
  });
  if (requires) app.manifest.capabilities = { requires };
  const origin = createServer(app);
  const originPort = await listen(origin);
  psp?.configure({ webhookUrl: `http://127.0.0.1:${originPort}/pay/webhook` });
  const dir = mkdtempSync(join(tmpdir(), "nav-auth-"));
  let nav;
  try {
    nav = await startNavigator({ cacheDir: SHARED_CACHE, url: `http://127.0.0.1:${originPort}/`, dev: true, port: 0, dataDir: dir, log: quiet, authTimeoutMs, watchdogMs, analyticsOptions });
  } catch (e) {
    // Navigator refused to start (for example, the component could not be linked): close what we opened.
    await close(origin);
    await idp.close();
    await psp?.close();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  const call = (path, body) =>
    fetch(`http://127.0.0.1:${nav.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Navigator": "1", Host: `tasks.localhost:${nav.port}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const state = () => fetch(`http://127.0.0.1:${nav.port}/_navigator/state`).then((r) => r.json());

  const h = {
    nav, idp, psp, app, originPort, dir, state, call,
    payments: app.impl?.payments, pro: app.impl?.pro, collector: app.impl?.collector,
    act: (source, values = {}, event = "press") => call("/_navigator/act", { source, event, values }),
    button: async (text) => find((await state()).tree, (n) => n.type === "button" && n.props.text === text),
    tasks: async () => all((await state()).tree, (n) => n.type === "checkbox").map((n) => n.props.label),
    async press(text, values) {
      const b = await h.button(text);
      assert.ok(b, `button "${text}" exists`);
      return h.act(b.id, values);
    },
    /** Resolves once a prompt of this flow is pending, as the user's window would see it. */
    async waitPrompt(flow, timeout = 5000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const p = (await state()).chrome.prompts.find((p) => p.flow === flow);
        if (p) return p;
        await sleep(25);
      }
      throw new Error(`no ${flow} prompt appeared`);
    },
    /** The user logs in at the identity provider; returns the redirect back to Navigator. */
    async userLogin(authUrl, who = "alice") {
      const page = await fetch(authUrl, { redirect: "manual" });
      const rid = /name="rid" value="([^"]+)"/.exec(await page.text())[1];
      const r = await fetch(`${idp.issuer}/authorize/decision`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ rid, user: who }), redirect: "manual",
      });
      return r.headers.get("location");
    },
    /** The browser follows the IdP's redirect to Navigator's callback. */
    callback(locationUrl, extra = "") {
      const u = new URL(locationUrl);
      return new Promise((done, fail) => {
        http.get({ host: "127.0.0.1", port: nav.port, path: u.pathname + u.search + extra, headers: { Host: u.host } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => done({ status: res.statusCode, body, headers: res.headers }));
        }).on("error", fail);
      });
    },
    /** Click "Sign in with <idp>" and complete it as `who`. */
    async signInOidc(who = "alice") {
      const pending = h.press(`Sign in with 127.0.0.1:${idp.port}`);
      const prompt = await h.waitPrompt("oidc");
      const loc = await h.userLogin(prompt.url, who);
      const cb = await h.callback(loc);
      return { res: await pending, prompt, cb };
    },
    signOut: () => call("/_navigator/signout", {}),
    /** The user acts on the processor's hosted page; returns the redirect back to Navigator (or the page itself). */
    async atProcessor(checkoutUrl, outcome = "pay") {
      const r = await fetch(checkoutUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ outcome }), redirect: "manual" });
      return { status: r.status, location: r.headers.get("location"), body: r.status === 303 ? "" : await r.text() };
    },
    /** Ask the origin directly, as some other client holding a given session token. */
    async rawRpc(method, body, token) {
      const res = await fetch(`http://127.0.0.1:${originPort}/rpc/${method}`, {
        method: "POST",
        headers: { "Content-Type": RPC_TYPE, "Lattice-Api": app.manifest.api.schema, ...(token ? { "Lattice-Session": token } : {}) },
        body: encode(body),
      });
      return { status: res.status, value: decode(new Uint8Array(await res.arrayBuffer())) };
    },
  };
  try {
    return await fn(h);
  } finally {
    await nav.close();
    await close(origin);
    await idp.close();
    await psp?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}


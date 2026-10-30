// Authentication tests: OIDC (with a development IdP) and passkeys (with a software authenticator),
// from both sides, including attacks. Requires the tasks component to be built.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { withStack, find, all, sleep, quiet, listen, close, b64u, tasksDir, SHARED_CACHE } from "./stack.mjs";
import { loadApp, createServer } from "../../server/server.mjs";
import { startIdp } from "../../server/dev-idp.mjs";
import { createAuth, defaultOriginAllowed } from "../../server/auth.mjs";
import { ApiError, RPC_TYPE } from "../../server/rpc.mjs";
import { startNavigator } from "../navigator.mjs";
import { AuthBroker, AuthFailure } from "../auth.mjs";
import { RpcClient, SessionStore, parseSetSession, applySessionHeaders } from "../rpc.mjs";
import { encode, decode } from "../../shared/cbor.mjs";
import { FakeAuthenticator } from "./fake-authenticator.mjs";



// ---- OIDC end to end ----------------------------------------------------------------------------

test("oidc: signs the user in, rotates the session, and keeps identities apart", async () => {
  await withStack(async (h) => {
    assert.deepEqual((await h.state()).chrome.session, { signedIn: false, name: null });
    const anonToken = h.nav.sessionStore.token();
    await h.press("Add", { title: "anonymous task" });
    assert.deepEqual(await h.tasks(), ["anonymous task"]);

    const { res, prompt, cb } = await h.signInOidc("alice");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(cb.status, 200);

    // What the user was shown, and what the host asked the identity provider for.
    assert.equal(prompt.app.domain, "tasks.localhost");
    assert.equal(prompt.app.name, "Lattice Tasks");
    assert.equal(prompt.issuerHost, `127.0.0.1:${h.idp.port}`);
    const q = new URL(prompt.url).searchParams;
    assert.equal(q.get("client_id"), h.idp.clientId);
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.match(q.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
    assert.match(q.get("state"), /^[A-Za-z0-9_-]{43}$/);
    assert.match(q.get("nonce"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.get("scope"), "openid profile");
    assert.equal(q.get("redirect_uri"), `${h.nav.uiOrigin}/_navigator/auth/callback`);

    // The host's chrome shows who is signed in; the app learned it from its own server.
    const s = await h.state();
    assert.deepEqual(s.chrome.session, { signedIn: true, name: "Alice Example" });
    assert.equal(find(s.tree, (n) => n.id === 30).props.text, "Signed in as Alice Example");
    assert.deepEqual(await h.tasks(), [], "a signed-in account does not inherit the anonymous tasks");

    // Session fixation: the token the host held before sign-in is not the one in use now.
    const aliceToken = h.nav.sessionStore.token();
    assert.notEqual(aliceToken, anonToken);
    assert.equal((await h.rawRpc("profile", {}, anonToken)).value.signed_in, false);
    assert.equal((await h.rawRpc("profile", {}, aliceToken)).value.name, "Alice Example");

    // Data follows the identity (iss, sub), across sign-out and sign-in.
    await h.press("Add", { title: "alice's task" });
    assert.equal((await h.signOut()).status, 200);
    assert.deepEqual((await h.state()).chrome.session, { signedIn: false, name: null });
    assert.deepEqual(await h.tasks(), [], "signed out: a fresh anonymous session sees nothing");
    assert.equal((await h.rawRpc("profile", {}, aliceToken)).value.signed_in, false, "the server revoked the old session");

    assert.equal((await h.signInOidc("alice")).res.status, 200);
    assert.deepEqual(await h.tasks(), ["alice's task"]);

    await h.signOut();
    assert.equal((await h.signInOidc("bob")).res.status, 200);
    assert.deepEqual(await h.tasks(), [], "bob is a different identity");
    assert.equal((await h.state()).chrome.session.name, "Bob Example");
  });
});

test("oidc: the callback is bound to one pending request, once", async () => {
  await withStack(async (h) => {
    const btn = `Sign in with 127.0.0.1:${h.idp.port}`;

    // A forged callback (wrong state) is refused and does not disturb the real pending sign-in.
    let pending = h.press(btn);
    let prompt = await h.waitPrompt("oidc");
    const forged = await h.callback(`${h.nav.uiOrigin}/_navigator/auth/callback?code=whatever&state=${b64u(randomBytes(32))}`);
    assert.equal(forged.status, 400);
    assert.equal((await h.state()).chrome.prompts.length, 1, "the real prompt is still pending");
    const loc = await h.userLogin(prompt.url);
    assert.equal((await h.callback(loc)).status, 200);
    assert.equal((await pending).status, 200);

    // Replaying a used callback does nothing.
    assert.equal((await h.callback(loc)).status, 400);
    await h.signOut();

    // A response naming a different issuer (RFC 9207) is rejected.
    pending = h.press(btn);
    prompt = await h.waitPrompt("oidc");
    const loc2 = await h.userLogin(prompt.url);
    // Appending a second iss is ambiguous and refused; the real sign-in stays pending.
    assert.equal((await h.callback(loc2, "&iss=" + encodeURIComponent("http://evil.example"))).status, 400);
    assert.equal((await h.state()).chrome.prompts.length, 1);
    // Replacing it is the actual mix-up attack.
    const swapped = new URL(loc2);
    swapped.searchParams.set("iss", "http://evil.example");
    assert.equal((await h.callback(swapped.href)).status, 400);
    const r = await pending;
    assert.equal(r.status, 422);
    assert.match(r.body.error, /different identity provider/);
    assert.deepEqual((await h.state()).chrome.session, { signedIn: false, name: null });

    // The user denies consent at the provider.
    pending = h.press(btn);
    prompt = await h.waitPrompt("oidc");
    const denied = await h.userLogin(prompt.url, "");
    assert.match(denied, /error=access_denied/);
    assert.equal((await h.callback(denied)).status, 400);
    assert.equal((await pending).body.error, "Sign-in was cancelled.");

    // The user presses Cancel in the host dialog.
    pending = h.press(btn);
    prompt = await h.waitPrompt("oidc");
    assert.equal((await h.call("/_navigator/auth/cancel", { id: prompt.id })).status, 200);
    assert.equal((await pending).body.error, "Sign-in was cancelled.");
    assert.equal((await h.state()).chrome.prompts.length, 0);
  });
});

test("oidc: an unanswered sign-in times out", async () => {
  await withStack(async (h) => {
    const t0 = Date.now();
    const r = await h.press(`Sign in with 127.0.0.1:${h.idp.port}`);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "Sign-in was cancelled.");
    assert.ok(Date.now() - t0 < 3000);
    assert.equal((await h.state()).chrome.prompts.length, 0);
  }, { authTimeoutMs: 300 });
});

test("oidc: the host only talks to issuers the manifest lists", async () => {
  await withStack(async (h) => {
    await assert.rejects(h.nav.auth.oidc("http://evil.example"), (e) => e instanceof AuthFailure && e.hostError.tag === "invalid-argument");
    await assert.rejects(h.nav.auth.oidc(h.idp.issuer + "/"), (e) => e instanceof AuthFailure, "not a byte-for-byte match");
  });
});

test("capabilities: oidc is refused when the manifest grants only passkeys", async () => {
  await withStack(async (h) => {
    const r = await h.press(`Sign in with 127.0.0.1:${h.idp.port}`);
    assert.equal(r.status, 422);
    assert.match(r.body.error, /Not permitted: auth\.oidc/);
    assert.equal((await h.state()).chrome.prompts.length, 0);
  }, { requires: ["net.origin", "session", "auth.passkey", "payments.request"] });
});

test("the watchdog does not kill a component that is waiting on the user", async () => {
  await withStack(async (h) => {
    const pending = h.press(`Sign in with 127.0.0.1:${h.idp.port}`);
    const prompt = await h.waitPrompt("oidc");
    await sleep(1200); // three times the watchdog while the "user" thinks
    const loc = await h.userLogin(prompt.url);
    await h.callback(loc);
    assert.equal((await pending).status, 200);
    assert.equal((await h.state()).chrome.session.signedIn, true);
  }, { watchdogMs: 400 });
});

// ---- The development IdP itself -----------------------------------------------------------------

test("dev IdP: PKCE, single-use codes, and registered redirect URIs are enforced", async () => {
  const idp = await startIdp({ clientSecret: "s3cret" });
  const redirect = "http://tasks.localhost:7070/_navigator/auth/callback";
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const authorize = async (over = {}) => {
    const q = new URLSearchParams({ response_type: "code", client_id: idp.clientId, redirect_uri: redirect, scope: "openid", state: "st", nonce: "n", code_challenge: challenge, code_challenge_method: "S256", ...over });
    return fetch(`${idp.issuer}/authorize?${q}`, { redirect: "manual" });
  };
  const code = async (over) => {
    const page = await authorize(over);
    const rid = /name="rid" value="([^"]+)"/.exec(await page.text())[1];
    const r = await fetch(`${idp.issuer}/authorize/decision`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ rid, user: "alice" }), redirect: "manual" });
    return new URL(r.headers.get("location")).searchParams.get("code");
  };
  const exchange = (c, over = {}) =>
    fetch(`${idp.issuer}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: c, redirect_uri: redirect, client_id: idp.clientId, client_secret: "s3cret", code_verifier: verifier, ...over }) });
  try {
    // Wrong verifier fails, and the code is burned even so.
    const c1 = await code();
    assert.equal((await exchange(c1, { code_verifier: b64u(randomBytes(32)) })).status, 400);
    assert.equal((await exchange(c1)).status, 400, "single use, even after a failed attempt");

    // Correct verifier works once; replay fails.
    const c2 = await code();
    const ok = await exchange(c2);
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).id_token);
    assert.equal((await exchange(c2)).status, 400);

    // Client authentication, redirect binding.
    assert.equal((await exchange(await code(), { client_secret: "wrong" })).status, 401);
    assert.equal((await exchange(await code(), { redirect_uri: "http://tasks.localhost:7070/other" })).status, 400);

    // Authorization requests that must not proceed.
    const noPkce = await authorize({ code_challenge: "", code_challenge_method: "" });
    assert.match(noPkce.headers.get("location"), /error=invalid_request/);
    const plain = await authorize({ code_challenge_method: "plain" });
    assert.match(plain.headers.get("location"), /error=invalid_request/);
    assert.equal((await authorize({ redirect_uri: "http://evil.example/_navigator/auth/callback" })).status, 400, "unregistered host: no redirect");
    assert.equal((await authorize({ redirect_uri: "http://127.0.0.1:1/other" })).status, 400, "wrong path: no redirect");
    assert.equal((await authorize({ client_id: "someone-else" })).status, 400);
  } finally { await idp.close(); }
});

// ---- Server-side ID token verification ----------------------------------------------------------

/** An identity provider that issues whatever ID token a test asks for, signed however it likes. */
async function rogueIdp() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  let issuer;
  let mint = async () => "";
  let tokenStatus = 200;
  const server = http.createServer(async (req, res) => {
    const send = (s, b) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url.endsWith("/.well-known/openid-configuration")) {
      return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks.json` });
    }
    if (req.url === "/jwks.json") return send(200, { keys: [jwk] });
    if (req.url === "/token") {
      for await (const _ of req);
      return tokenStatus === 200 ? send(200, { id_token: await mint() }) : send(tokenStatus, { error: "invalid_grant" });
    }
    send(404, {});
  });
  const port = await listen(server);
  issuer = `http://127.0.0.1:${port}`;
  const claims = (over = {}) => ({ nonce: "the-nonce", name: "Mallory", ...over });
  const sign = (c = {}, { key = privateKey, alg = "ES256", iss = issuer, aud = "c1", sub = "sub-1", exp = "5m", iat = true } = {}) => {
    let j = new SignJWT(claims(c)).setProtectedHeader({ alg, kid: "k1" }).setIssuer(iss).setAudience(aud).setExpirationTime(exp);
    if (sub !== null) j = j.setSubject(sub);
    if (iat) j = j.setIssuedAt();
    return j.sign(key);
  };
  return {
    issuer, sign, otherKey: other.privateKey,
    setMint: (fn) => { mint = fn; },
    setTokenStatus: (s) => { tokenStatus = s; },
    close: () => close(server),
  };
}

async function withRp(fn) {
  const idp = await rogueIdp();
  const logs = [];
  const auth = createAuth({ rpId: "tasks.localhost", rpName: "Tasks", oidc: [{ issuer: idp.issuer, clientId: "c1" }], allowInsecureIssuers: true, log: (m) => logs.push(m) });
  const server = http.createServer((req, res) => auth.tokenEndpoint(req, res));
  const port = await listen(server);
  const post = async (body, { headers = {}, method = "POST", raw } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/auth/token`, { method, headers: { "Content-Type": "application/json", ...headers }, body: method === "GET" ? undefined : (raw ?? JSON.stringify(body)) });
    return { status: res.status, body: await res.json(), setSession: res.headers.get("lattice-set-session"), clear: res.headers.get("lattice-clear-session") };
  };
  const good = { grant: "oidc", issuer: idp.issuer, code: "c", code_verifier: "v".repeat(43), redirect_uri: "http://tasks.localhost:7070/_navigator/auth/callback", nonce: "the-nonce" };
  try {
    return await fn({ idp, auth, post, good, logs });
  } finally { await close(server); await idp.close(); }
}

test("RP: a well-formed ID token signs the user in", async () => {
  await withRp(async ({ idp, post, good, auth }) => {
    idp.setMint(() => idp.sign());
    const r = await post(good);
    assert.equal(r.status, 200);
    const s = parseSetSession(r.setSession);
    assert.ok(s, "valid session header");
    assert.equal(s.name, "Mallory");
    assert.deepEqual(auth.identify(s.token), { subject: s.subject, name: "Mallory" });
  });
});

test("RP: forged, expired, mis-addressed and unsigned ID tokens are rejected", async () => {
  await withRp(async ({ idp, post, good, auth, logs }) => {
    const unsigned = () => {
      const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      return `${enc({ alg: "none" })}.${enc({ iss: idp.issuer, aud: "c1", sub: "x", nonce: "the-nonce", iat: now, exp: now + 300 })}.`;
    };
    const cases = {
      "signed by a key the issuer does not publish": () => idp.sign({}, { key: idp.otherKey }),
      "wrong audience": () => idp.sign({}, { aud: "some-other-client" }),
      "wrong issuer claim": () => idp.sign({}, { iss: "http://evil.example" }),
      "expired": () => idp.sign({}, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      "wrong nonce": () => idp.sign({ nonce: "someone-elses" }),
      "no nonce": () => idp.sign({ nonce: undefined }),
      "no subject": () => idp.sign({}, { sub: null }),
      "empty subject": () => idp.sign({}, { sub: "" }),
      "alg none": unsigned,
      "HS256": () => new SignJWT({ nonce: "the-nonce" }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(idp.issuer).setAudience("c1").setSubject("x").setIssuedAt().setExpirationTime("5m").sign(randomBytes(32)),
      "garbage": () => "not.a.jwt",
    };
    const before = auth.sessions.size;
    for (const [name, make] of Object.entries(cases)) {
      idp.setMint(async () => make());
      const r = await post(good);
      assert.equal(r.status, 422, name);
      assert.equal(r.body.code, "sign_in_failed", name);
      assert.equal(r.setSession, null, `${name}: no session issued`);
    }
    assert.equal(auth.sessions.size, before, "no session was created by any of them");

    // The body's nonce must match what the token carries, even for an otherwise valid token.
    idp.setMint(() => idp.sign());
    assert.equal((await post({ ...good, nonce: "different" })).status, 422);

    // The IdP refusing the code is a failed sign-in, not a crash.
    idp.setTokenStatus(400);
    assert.equal((await post(good)).status, 422);
    idp.setTokenStatus(200);

    assert.ok(logs.length >= Object.keys(cases).length, "each rejection was logged server-side");
  });
});

test("RP: the request itself is validated", async () => {
  await withRp(async ({ idp, post, good }) => {
    idp.setMint(() => idp.sign());
    assert.equal((await post({ ...good, issuer: "http://unlisted.example" })).body.code, "unknown_issuer");
    assert.equal((await post({ ...good, redirect_uri: "http://evil.example/_navigator/auth/callback" })).status, 400);
    assert.equal((await post({ ...good, redirect_uri: "http://tasks.localhost:7070/somewhere/else" })).status, 400);
    assert.equal((await post({ ...good, redirect_uri: "https://tasks.localhost.evil.com/_navigator/auth/callback" })).status, 400);
    for (const field of ["issuer", "code", "code_verifier", "redirect_uri", "nonce"]) {
      assert.equal((await post({ ...good, [field]: undefined })).status, 400, `missing ${field}`);
      assert.equal((await post({ ...good, [field]: "x".repeat(3000) })).status, 400, `oversize ${field}`);
    }
    assert.equal((await post({ grant: "password", username: "a", password: "b" })).status, 400);
    assert.equal((await post({}, { headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await post(null, { raw: "{not json" })).status, 400);
    assert.equal((await post(null, { raw: "[1,2]" })).status, 400);
    assert.equal((await post(null, { method: "GET" })).status, 405);
  });
});

test("RP: revoke ends a session and tells the host to drop it", async () => {
  await withRp(async ({ idp, post, good, auth }) => {
    idp.setMint(() => idp.sign());
    const s = parseSetSession((await post(good)).setSession);
    assert.ok(auth.identify(s.token));
    const r = await post({ grant: "revoke" }, { headers: { "Lattice-Session": s.token } });
    assert.equal(r.status, 200);
    assert.equal(r.clear, "1");
    assert.equal(auth.identify(s.token), null);
  });
});

// ---- Session headers ----------------------------------------------------------------------------

test("host: Lattice-Set-Session is validated strictly", () => {
  const now = 1_700_000_000;
  const hdr = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const good = { token: "A".repeat(43), subject: "u_1", name: "Ann", expires: now + 3600 };
  assert.deepEqual(parseSetSession(hdr(good), now), good);
  assert.ok(parseSetSession(hdr({ ...good, name: undefined }), now), "name is optional");
  for (const [why, bad] of Object.entries({
    "short token": { ...good, token: "short" },
    "token with a bad character": { ...good, token: "A".repeat(42) + "!" },
    "oversize token": { ...good, token: "A".repeat(129) },
    "no subject": { ...good, subject: undefined },
    "empty subject": { ...good, subject: "" },
    "oversize subject": { ...good, subject: "s".repeat(257) },
    "name too long": { ...good, name: "n".repeat(81) },
    "name not a string": { ...good, name: 5 },
    "already expired": { ...good, expires: now - 1 },
    "expires now": { ...good, expires: now },
    "too far ahead": { ...good, expires: now + 31 * 24 * 3600 },
    "fractional expiry": { ...good, expires: now + 10.5 },
    "string expiry": { ...good, expires: String(now + 10) },
  })) assert.equal(parseSetSession(hdr(bad), now), null, why);
  assert.equal(parseSetSession("%%% not base64 %%%", now), null);
  assert.equal(parseSetSession(Buffer.from("not json").toString("base64url"), now), null);
  assert.equal(parseSetSession(Buffer.from("[]").toString("base64url"), now), null);
  assert.equal(parseSetSession("x".repeat(3000), now), null);
  assert.equal(parseSetSession(undefined, now), null);
});

test("host: a signed-in session expires into a fresh anonymous one", () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-exp-"));
  try {
    let t = 1_700_000_000_000;
    const store = new SessionStore(dir, "x.example", { now: () => t });
    const anon = store.token();
    store.set({ token: "B".repeat(43), subject: "u", name: "U", expires: t / 1000 + 60 });
    assert.equal(store.token(), "B".repeat(43));
    assert.equal(store.info().signedIn, true);
    t += 61_000;
    const after = store.token();
    assert.notEqual(after, "B".repeat(43));
    assert.notEqual(after, anon);
    assert.deepEqual(store.info(), { signedIn: false, subject: undefined, name: undefined, expiresAt: undefined });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("host: session headers on RPC responses are applied only when valid, on success, and with the capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nav-hdr-"));
  const api = JSON.parse((await import("node:fs")).readFileSync(join(tasksDir, "api.json"), "utf8"));
  const sessionFor = (token) => Buffer.from(JSON.stringify({ token, subject: "u_9", name: "Z", expires: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  let reply;
  const server = http.createServer(async (req, res) => { for await (const _ of req); reply(res); });
  const port = await listen(server);
  const mk = (session) => new RpcClient({ endpoint: `http://127.0.0.1:${port}/rpc`, description: api, apiHash: "sha256-" + "A".repeat(43), session });
  try {
    const store = new SessionStore(dir, "x.example");
    const before = store.token();
    const ok = (res, headers) => { const b = Buffer.from(encode({ signed_in: false, name: "", pro: false })); res.writeHead(200, { "Content-Type": RPC_TYPE, ...headers }); res.end(b); };

    reply = (res) => ok(res, { "Lattice-Set-Session": sessionFor("C".repeat(43)) });
    const r = await mk(store).call("profile", encode({}));
    assert.equal(r.ok, true);
    assert.deepEqual(decode(r.bytes), { signed_in: false, name: "", pro: false }, "the app gets the body only; no trace of the header");
    assert.equal(store.token(), "C".repeat(43));
    assert.equal(store.info().subject, "u_9");

    // Malformed session header: ignored, but the call itself still succeeds.
    reply = (res) => ok(res, { "Lattice-Set-Session": "garbage" });
    assert.equal((await mk(store).call("profile", encode({}))).ok, true);
    assert.equal(store.token(), "C".repeat(43));

    // On an error response: ignored.
    reply = (res) => { const b = Buffer.from(encode({ code: "unauthorized", message: "no" })); res.writeHead(401, { "Content-Type": "application/vnd.lattice.rpc-error+cbor", "Lattice-Set-Session": sessionFor("D".repeat(43)) }); res.end(b); };
    assert.equal((await mk(store).call("profile", encode({}))).error.tag, "application");
    assert.equal(store.token(), "C".repeat(43));

    // On a response that violates the API description: ignored (it never reaches the app either).
    reply = (res) => { const b = Buffer.from(encode({ wrong: 1 })); res.writeHead(200, { "Content-Type": RPC_TYPE, "Lattice-Set-Session": sessionFor("E".repeat(43)) }); res.end(b); };
    assert.equal((await mk(store).call("profile", encode({}))).error.tag, "transport");
    assert.equal(store.token(), "C".repeat(43));

    // Without the session capability the host has no store, so nothing changes.
    reply = (res) => ok(res, { "Lattice-Set-Session": sessionFor("F".repeat(43)) });
    assert.equal((await mk(null).call("profile", encode({}))).ok, true);
    assert.equal(store.token(), "C".repeat(43));

    // Clear drops back to a fresh anonymous session.
    reply = (res) => ok(res, { "Lattice-Clear-Session": "1" });
    await mk(store).call("profile", encode({}));
    assert.equal(store.info().signedIn, false);
    assert.notEqual(store.token(), "C".repeat(43));
    assert.notEqual(store.token(), before);

    // And the pure helper agrees.
    assert.equal(applySessionHeaders(null, new Headers({ "lattice-clear-session": "1" })), false);
  } finally { await close(server); rmSync(dir, { recursive: true, force: true }); }
});

// ---- Passkeys: the server, against a software authenticator --------------------------------------

function passkeyHarness({ now } = {}) {
  const logs = [];
  const auth = createAuth({ rpId: "tasks.localhost", rpName: "Tasks", now, log: (m) => logs.push(m) });
  const origin = "http://tasks.localhost:7070";
  const sessions = [];
  const ctx = { setSession: (s) => sessions.push(s) };
  const register = async (authn, name = "Ann", over) => {
    const { options } = await auth.passkey.registerBegin({ name });
    return { options: JSON.parse(options), run: (resp) => auth.passkey.registerFinish({ response: JSON.stringify(resp) }, ctx) };
  };
  return { auth, origin, ctx, sessions, logs, register, authn: () => new FakeAuthenticator({ origin, rpId: "tasks.localhost" }) };
}
const failsWith = (code) => (e) => e instanceof ApiError && e.code === code;

test("passkeys: registration and login verify against a real authenticator", async () => {
  const h = passkeyHarness();
  const a = h.authn();

  const reg = await h.register(a, "Ann");
  assert.equal(reg.options.rp.id, "tasks.localhost");
  assert.equal(reg.options.authenticatorSelection.residentKey, "required");
  assert.equal((await reg.run(a.create(reg.options))).name, "Ann");
  assert.equal(h.sessions.length, 1);
  const subject = h.sessions[0].subject;
  assert.deepEqual(h.auth.identify(h.sessions[0].token), { subject, name: "Ann" });

  const { options } = await h.auth.passkey.loginBegin();
  const out = await h.auth.passkey.loginFinish({ response: JSON.stringify(a.get(JSON.parse(options))) }, h.ctx);
  assert.equal(out.name, "Ann");
  assert.equal(h.sessions[1].subject, subject, "the same account");
  assert.notEqual(h.sessions[1].token, h.sessions[0].token, "a new session each time");
});

test("passkeys: registration attacks fail", async () => {
  const h = passkeyHarness();
  const a = h.authn();
  const bad = failsWith("passkey_failed");

  // Replay: the challenge is consumed by the first use.
  let reg = await h.register(a);
  const resp = a.create(reg.options);
  await reg.run(resp);
  await assert.rejects(reg.run(resp), bad);

  // Wrong origin (a phishing site relaying the options).
  reg = await h.register(a);
  await assert.rejects(reg.run(a.create(reg.options, { origin: "http://evil.example" })), bad);
  reg = await h.register(a);
  await assert.rejects(reg.run(a.create(reg.options, { origin: "http://tasks.localhost.evil.com" })), bad);
  reg = await h.register(a);
  await assert.rejects(reg.run(a.create(reg.options, { origin: "http://evil.tasks.localhost" })), bad);

  // Credential made for a different relying party.
  reg = await h.register(a);
  await assert.rejects(reg.run(a.create(reg.options, { rpId: "evil.example" })), bad);

  // A challenge the server never issued, and one issued for login.
  reg = await h.register(a);
  await assert.rejects(reg.run(a.create(reg.options, { challenge: b64u(randomBytes(32)) })), bad);
  const login = JSON.parse((await h.auth.passkey.loginBegin()).options);
  reg = await h.register(a);
  await assert.rejects(reg.run(a.create({ challenge: login.challenge })), bad, "a login challenge cannot complete a registration");

  // Malformed input is a request error, not a crash.
  for (const garbage of ["not json", "{}", JSON.stringify({ response: {} }), JSON.stringify({ response: { clientDataJSON: "!!" } })]) {
    await assert.rejects(h.auth.passkey.registerFinish({ response: garbage }, h.ctx), failsWith("invalid_request"));
  }
  await assert.rejects(h.auth.passkey.registerFinish({ response: "x".repeat(70_000) }, h.ctx), failsWith("invalid_request"));

  assert.equal(h.sessions.length, 1, "only the replay's first, legitimate use issued a session");
});

test("passkeys: login attacks fail", async () => {
  const h = passkeyHarness();
  const a = h.authn();
  const bad = failsWith("passkey_failed");
  const reg = await h.register(a);
  await reg.run(a.create(reg.options));
  const login = async (over, authn = a) => {
    const options = JSON.parse((await h.auth.passkey.loginBegin()).options);
    return h.auth.passkey.loginFinish({ response: JSON.stringify(authn.get(options, over)) }, h.ctx);
  };

  await login({ counter: 5 }); // fine
  await assert.rejects(login({ counter: 5 }), bad, "a counter that does not advance is a cloned authenticator");
  await assert.rejects(login({ counter: 4 }), bad, "a counter that goes backwards too");
  await login({ counter: 6 }); // and it still works afterwards

  await assert.rejects(login({ origin: "http://evil.example" }), bad);
  await assert.rejects(login({ rpId: "evil.example" }), bad);
  await assert.rejects(login({ challenge: b64u(randomBytes(32)) }), bad);

  // A signature from a different key, and an unknown credential.
  const stranger = h.authn();
  await assert.rejects(login({ key: stranger.privateKey }), bad, "signed with the wrong private key");
  await assert.rejects(login({ credentialId: randomBytes(16) }), bad, "unknown credential id");

  // A used challenge cannot be reused for another login.
  const options = JSON.parse((await h.auth.passkey.loginBegin()).options);
  const first = JSON.stringify(a.get(options, { counter: 20 }));
  await h.auth.passkey.loginFinish({ response: first }, h.ctx);
  await assert.rejects(h.auth.passkey.loginFinish({ response: JSON.stringify(a.get(options, { counter: 21 })) }, h.ctx), bad);
});

test("passkeys: challenges expire, and account names are validated", async () => {
  let t = 1_700_000_000_000;
  const h = passkeyHarness({ now: () => t });
  const a = h.authn();
  const reg = await h.register(a);
  const resp = a.create(reg.options);
  t += 5 * 60 * 1000 + 1;
  await assert.rejects(reg.run(resp), failsWith("passkey_failed"));

  for (const name of ["", "   ", "x".repeat(81)]) {
    await assert.rejects(h.auth.passkey.registerBegin({ name }), failsWith("invalid_name"));
  }
});

test("passkeys: acceptable origins are exactly the app's domain", () => {
  const ok = defaultOriginAllowed("tasks.localhost");
  assert.equal(ok("http://tasks.localhost:7070"), true);
  assert.equal(ok("https://tasks.localhost"), true);
  for (const bad of ["http://evil.tasks.localhost", "http://tasks.localhost.evil.com", "http://localhost:7070", "ftp://tasks.localhost", "tasks.localhost", ""]) {
    assert.equal(ok(bad), false, bad);
  }
  const prod = defaultOriginAllowed("shop.example.com");
  assert.equal(prod("https://shop.example.com"), true);
  assert.equal(prod("http://shop.example.com"), false, "plain http only for *.localhost development names");
});

// ---- Passkeys: Navigator end to end, with the window played by a software authenticator ----------

test("passkeys: the whole flow through Navigator, including sign-out from the host chrome", async () => {
  await withStack(async (h) => {
    const authn = new FakeAuthenticator({ origin: h.nav.uiOrigin, rpId: "tasks.localhost" });
    const answer = async (flow, fn) => {
      const prompt = await h.waitPrompt(flow);
      // The dialog is composed by the host from manifest data only.
      assert.equal(prompt.app.domain, "tasks.localhost");
      assert.equal(prompt.app.name, "Lattice Tasks");
      const result = fn(prompt.options);
      return h.call("/_navigator/auth/result", { id: prompt.id, ok: true, response: JSON.stringify(result) });
    };

    // Create an account.
    let pending = h.press("Create passkey", { account_name: "Dana" });
    assert.equal((await answer("passkey-create", (o) => authn.create(o))).status, 200);
    assert.equal((await pending).status, 200);
    assert.deepEqual((await h.state()).chrome.session, { signedIn: true, name: "Dana" });
    await h.press("Add", { title: "dana's task" });

    // Sign out from the host's own chrome; the app is told and updates itself.
    assert.equal((await h.signOut()).status, 200);
    const out = await h.state();
    assert.deepEqual(out.chrome.session, { signedIn: false, name: null });
    assert.equal(find(out.tree, (n) => n.id === 30).props.text.startsWith("You are not signed in"), true);
    assert.deepEqual(await h.tasks(), []);

    // Sign back in with the passkey.
    pending = h.press("Sign in with a passkey");
    assert.equal((await answer("passkey-assert", (o) => authn.get(o))).status, 200);
    assert.equal((await pending).status, 200);
    assert.deepEqual((await h.state()).chrome.session, { signedIn: true, name: "Dana" });
    assert.deepEqual(await h.tasks(), ["dana's task"]);

    // A response from an authenticator bound to another site does not sign anyone in.
    await h.signOut();
    const phisher = new FakeAuthenticator({ origin: "http://evil.example", rpId: "evil.example" });
    pending = h.press("Create passkey", { account_name: "Mallory" });
    await answer("passkey-create", (o) => phisher.create(o, { origin: "http://evil.example", rpId: "evil.example" }));
    const r = await pending;
    assert.equal(r.status, 422);
    assert.deepEqual((await h.state()).chrome.session, { signedIn: false, name: null });

    // Cancelling the ceremony in the window.
    pending = h.press("Sign in with a passkey");
    const prompt = await h.waitPrompt("passkey-assert");
    await h.call("/_navigator/auth/result", { id: prompt.id, ok: false, error: "NotAllowedError" });
    assert.equal((await pending).body.error, "Sign-in was cancelled.");
  });
});

// ---- Passkeys: what the host accepts from the app ------------------------------------------------

function broker({ uiOrigin = "http://tasks.localhost:7070", timeoutMs = 300 } = {}) {
  const msgs = [];
  const manifest = { app: "tasks.localhost", name: "Lattice Tasks", auth: { providers: [{ type: "passkey" }] } };
  const b = new AuthBroker({ manifest, tokenEndpoint: null, session: { token: () => "t", rotate() {}, info: () => ({}) }, uiOrigin: () => uiOrigin, broadcast: (m) => msgs.push(m), dev: true, timeoutMs });
  const opts = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o));
  return { b, msgs, opts };
}
const hostError = (tag) => (e) => e instanceof AuthFailure && e.hostError.tag === tag;

test("host: passkey options from the app are checked before the user is asked", async () => {
  const { b, msgs, opts } = broker();
  const creation = (over = {}) => ({ challenge: "abc", rp: { id: "tasks.localhost", name: "Tasks" }, user: { id: "dQ", name: "n", displayName: "n" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], ...over });

  for (const [why, o] of Object.entries({
    "relying party is another site": creation({ rp: { id: "evil.example", name: "x" } }),
    "relying party is a parent domain": creation({ rp: { id: "localhost", name: "x" } }),
    "no relying party": creation({ rp: undefined }),
    "no challenge": creation({ challenge: undefined }),
    "challenge is not a string": creation({ challenge: 5 }),
  })) {
    await assert.rejects(b.passkey("create", opts(o)), hostError("invalid-argument"), why);
  }
  await assert.rejects(b.passkey("create", opts("not json")), hostError("invalid-argument"));
  await assert.rejects(b.passkey("create", opts("[]")), hostError("invalid-argument"));
  await assert.rejects(b.passkey("create", Buffer.alloc(20_000)), hostError("invalid-argument"));
  await assert.rejects(b.passkey("assert", opts({ challenge: "abc", rpId: "evil.example" })), hostError("invalid-argument"));
  assert.equal(msgs.length, 0, "the user was never prompted for any of those");

  // A request without rpId gets the app's domain; extensions are stripped.
  let p = b.passkey("assert", opts({ challenge: "abc", extensions: { credProps: true, prf: { eval: {} } } }));
  const prompt = msgs.at(-1).prompt;
  assert.equal(prompt.options.rpId, "tasks.localhost");
  assert.equal("extensions" in prompt.options, false);
  assert.equal(prompt.flow, "passkey-assert");
  b.cancel(prompt.id);
  await assert.rejects(p, hostError("cancelled"));

  p = b.passkey("create", opts(creation({ extensions: { credProps: true } })));
  assert.equal("extensions" in msgs.at(-1).prompt.options, false);
  b.cancel(msgs.at(-1).prompt.id);
  await assert.rejects(p, hostError("cancelled"));
});

test("host: passkey results from the window are validated", async () => {
  const { b, msgs, opts } = broker();
  const o = { challenge: "abc", rp: { id: "tasks.localhost", name: "T" }, user: { id: "dQ", name: "n", displayName: "n" } };
  const run = async (body) => {
    const p = b.passkey("create", opts(o));
    const id = msgs.at(-1).prompt.id;
    b.finishPasskey(id, body);
    return p;
  };
  const good = JSON.stringify({ id: "x", type: "public-key", response: {} });
  assert.equal(Buffer.from(await run({ ok: true, response: good })).toString(), good);
  await assert.rejects(run({ ok: true, response: "not json" }), hostError("invalid-argument"));
  await assert.rejects(run({ ok: true, response: JSON.stringify({ id: "x", type: "password" }) }), hostError("invalid-argument"));
  await assert.rejects(run({ ok: true, response: JSON.stringify({ type: "public-key" }) }), hostError("invalid-argument"));
  await assert.rejects(run({ ok: true, response: "x".repeat(70_000) }), hostError("invalid-argument"));
  await assert.rejects(run({ ok: true }), hostError("invalid-argument"));
  await assert.rejects(run({ ok: false, error: "NotAllowedError" }), hostError("cancelled"));
  await assert.rejects(run({ ok: false, error: "NotSupportedError" }), hostError("unavailable"));
  await assert.rejects(run(null), hostError("unavailable"));

  // Only a pending passkey prompt can be answered, and only once.
  assert.equal(b.finishPasskey("no-such-id", { ok: true, response: good }), false);
  const p = b.passkey("create", opts(o));
  const id = msgs.at(-1).prompt.id;
  assert.equal(b.finishPasskey(id, { ok: true, response: good }), true);
  assert.equal(b.finishPasskey(id, { ok: true, response: good }), false);
  await p;
});

test("host: passkeys are unavailable when the window is not on the app's domain", async () => {
  const { b, opts } = broker({ uiOrigin: "http://127.0.0.1:7070" });
  await assert.rejects(
    b.passkey("assert", opts({ challenge: "abc" })),
    (e) => e instanceof AuthFailure && e.hostError.tag === "unavailable" && /tasks\.localhost/.test(e.hostError.val)
  );
});

test("host: passkey prompts time out", async () => {
  const { b, msgs, opts } = broker({ timeoutMs: 100 });
  await assert.rejects(b.passkey("assert", opts({ challenge: "abc" })), hostError("cancelled"));
  assert.equal(msgs.at(-1).kind, "prompt-end");
  assert.equal(b.list().length, 0);
});

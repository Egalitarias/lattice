// Server side of Lattice authentication (spec/auth.md).
//
// createAuth() gives an origin:
//   - passkey handlers (registerBegin/Finish, loginBegin/Finish) to expose as RPC methods
//   - an HTTP handler for the manifest's auth.token_endpoint (grants: oidc, revoke)
//   - identify(token) to find out who a session token belongs to
//
// Sessions, users and challenges are in memory. A real origin would persist them.

import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { ApiError, sessionHeader } from "./rpc.mjs";

const CALLBACK_PATH = "/_navigator/auth/callback";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_JSON = 64 * 1024;
const ID_TOKEN_ALGS = ["RS256", "ES256", "EdDSA"]; // never "none", never HMAC

const isLoopbackHost = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/** Origins acceptable for passkeys: https://<rpId>, or http on a *.localhost development name. */
export function defaultOriginAllowed(rpId) {
  return (origin) => {
    let u;
    try { u = new URL(origin); } catch { return false; }
    if (u.hostname !== rpId) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
  };
}

const newToken = () => randomBytes(32).toString("base64url");

export function createAuth({
  rpId,
  rpName,
  originAllowed = defaultOriginAllowed(rpId),
  oidc = [], // [{ issuer, clientId, clientSecret? }]
  allowInsecureIssuers = false, // development only: permit http://localhost IdPs
  sessionTtlSec = 3600,
  now = () => Date.now(),
  log = console.error,
}) {
  const sessions = new Map(); // token -> { subject, name, expires (unix s) }
  const users = new Map(); // subject -> { name, credentials: [...], oidcKey? }
  const oidcIndex = new Map(); // `${iss}\n${sub}` -> subject
  const challenges = new Map(); // challenge -> { kind, name?, expires (ms) }
  const providers = new Map(oidc.map((p) => [p.issuer, p]));
  const discovery = new Map(); // issuer -> { doc, jwks }

  // ---- Sessions -------------------------------------------------------------------------------

  function issueSession(subject, name) {
    const expires = Math.floor(now() / 1000) + sessionTtlSec;
    const token = newToken();
    sessions.set(token, { subject, name, expires });
    return { token, subject, name, expires };
  }

  /** Who a session token belongs to, or null (anonymous, unknown, revoked, or expired). */
  function identify(token) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (s.expires <= Math.floor(now() / 1000)) {
      sessions.delete(token);
      return null;
    }
    return { subject: s.subject, name: s.name };
  }

  // ---- Challenges: single-use, bound to a kind, expiring --------------------------------------

  function putChallenge(challenge, data) {
    for (const [k, v] of challenges) if (v.expires < now()) challenges.delete(k);
    challenges.set(challenge, { ...data, expires: now() + CHALLENGE_TTL_MS });
  }
  function takeChallenge(challenge, kind) {
    const c = challenges.get(challenge);
    challenges.delete(challenge); // consumed whether or not verification succeeds
    return c && c.kind === kind && c.expires >= now() ? c : null;
  }

  // ---- Passkeys -------------------------------------------------------------------------------

  const failed = () => new ApiError("passkey_failed", "That passkey could not be verified.");

  function parseResponse(text) {
    if (typeof text !== "string" || text.length > MAX_JSON) throw new ApiError("invalid_request", "bad response");
    let response, clientData;
    try {
      response = JSON.parse(text);
      clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8"));
    } catch {
      throw new ApiError("invalid_request", "bad response");
    }
    if (typeof clientData.challenge !== "string" || typeof clientData.origin !== "string") {
      throw new ApiError("invalid_request", "bad response");
    }
    return { response, clientData };
  }

  const passkey = {
    async registerBegin({ name }) {
      const display = String(name).trim();
      if (!display || display.length > 80) throw new ApiError("invalid_name", "Choose a name between 1 and 80 characters.");
      const options = await generateRegistrationOptions({
        rpName,
        rpID: rpId,
        userName: display,
        userID: randomBytes(16),
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      putChallenge(options.challenge, { kind: "register", name: display });
      return { options: JSON.stringify(options) };
    },

    async registerFinish({ response: text }, ctx) {
      const { response, clientData } = parseResponse(text);
      const pending = takeChallenge(clientData.challenge, "register");
      if (!pending || !originAllowed(clientData.origin)) throw failed();
      let result;
      try {
        result = await verifyRegistrationResponse({
          response,
          expectedChallenge: clientData.challenge,
          expectedOrigin: clientData.origin,
          expectedRPID: rpId,
          requireUserVerification: false,
        });
      } catch (e) {
        log(`passkey registration rejected: ${e.message}`);
        throw failed();
      }
      if (!result.verified) throw failed();
      const { credential } = result.registrationInfo;
      const subject = "u_" + randomBytes(12).toString("base64url");
      users.set(subject, { name: pending.name, credentials: [{ ...credential }] });
      ctx.setSession(issueSession(subject, pending.name));
      return { name: pending.name };
    },

    async loginBegin() {
      const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: "preferred", allowCredentials: [] });
      putChallenge(options.challenge, { kind: "login" });
      return { options: JSON.stringify(options) };
    },

    async loginFinish({ response: text }, ctx) {
      const { response, clientData } = parseResponse(text);
      const pending = takeChallenge(clientData.challenge, "login");
      if (!pending || !originAllowed(clientData.origin)) throw failed();

      let owner, cred;
      for (const [subject, u] of users) {
        const c = u.credentials.find((c) => c.id === response.id);
        if (c) { owner = { subject, user: u }; cred = c; break; }
      }
      if (!cred) throw failed();

      let result;
      try {
        result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: clientData.challenge,
          expectedOrigin: clientData.origin,
          expectedRPID: rpId,
          credential: cred,
          requireUserVerification: false,
        });
      } catch (e) {
        log(`passkey assertion rejected: ${e.message}`);
        throw failed();
      }
      if (!result.verified) throw failed();
      cred.counter = result.authenticationInfo.newCounter;
      ctx.setSession(issueSession(owner.subject, owner.user.name));
      return { name: owner.user.name };
    },
  };

  // ---- OIDC -----------------------------------------------------------------------------------

  const issuerUrlOk = (u) => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" || (allowInsecureIssuers && url.protocol === "http:" && isLoopbackHost(url.hostname));
    } catch { return false; }
  };

  async function fetchJson(url) {
    if (!issuerUrlOk(url)) throw new Error(`refusing to fetch ${url}`);
    const res = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 256 * 1024) throw new Error(`${url}: response too large`);
    return JSON.parse(text);
  }

  async function discover(issuer) {
    const hit = discovery.get(issuer);
    if (hit) return hit;
    const doc = await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (doc.issuer !== issuer) throw new Error("discovery document names a different issuer");
    if (!issuerUrlOk(doc.token_endpoint) || !issuerUrlOk(doc.jwks_uri)) throw new Error("discovery document has unusable endpoints");
    const entry = { doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: 5000 }) };
    discovery.set(issuer, entry);
    return entry;
  }

  async function oidcSignIn(body, res) {
    const { issuer, code, code_verifier: verifier, redirect_uri: redirectUri, nonce } = body;
    for (const v of [issuer, code, verifier, redirectUri, nonce]) {
      if (typeof v !== "string" || !v || v.length > 2048) return reply(res, 400, { code: "invalid_request", message: "missing or malformed field" });
    }
    const provider = providers.get(issuer); // the body only selects among issuers we already trust
    if (!provider) return reply(res, 400, { code: "unknown_issuer", message: "That identity provider is not accepted here." });

    let ru;
    try { ru = new URL(redirectUri); } catch { return reply(res, 400, { code: "invalid_request", message: "bad redirect_uri" }); }
    if (ru.pathname !== CALLBACK_PATH || !originAllowed(ru.origin)) {
      return reply(res, 400, { code: "invalid_request", message: "redirect_uri is not acceptable" });
    }

    let claims;
    try {
      const { doc, jwks } = await discover(issuer);
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: provider.clientId,
        code_verifier: verifier,
      });
      if (provider.clientSecret) form.set("client_secret", provider.clientSecret);
      const tr = await fetch(doc.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      const tokens = await tr.json().catch(() => ({}));
      if (!tr.ok || typeof tokens.id_token !== "string") throw new Error(`token endpoint refused the code (${tr.status} ${tokens.error ?? ""})`);

      const verified = await jwtVerify(tokens.id_token, jwks, {
        issuer,
        audience: provider.clientId,
        algorithms: ID_TOKEN_ALGS,
        clockTolerance: 5,
        requiredClaims: ["sub", "exp", "iat"],
      });
      claims = verified.payload;
      if (typeof claims.nonce !== "string" || claims.nonce !== nonce) throw new Error("nonce mismatch");
      if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new Error("bad sub");
    } catch (e) {
      log(`oidc sign-in rejected for ${issuer}: ${e.message}`);
      return reply(res, 422, { code: "sign_in_failed", message: "Sign-in could not be verified." });
    }

    const key = `${issuer}\n${claims.sub}`; // identity is (iss, sub), never an email address
    let subject = oidcIndex.get(key);
    const name = String(claims.name ?? claims.preferred_username ?? claims.email ?? "Account").slice(0, 80);
    if (!subject) {
      subject = "u_" + randomBytes(12).toString("base64url");
      oidcIndex.set(key, subject);
      users.set(subject, { name, credentials: [], oidcKey: key });
    }
    const session = issueSession(subject, users.get(subject).name);
    reply(res, 200, {}, { "Lattice-Set-Session": sessionHeader(session) });
  }

  function reply(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store", ...headers });
    res.end(text);
  }

  /** HTTP handler for the manifest's auth.token_endpoint. */
  async function tokenEndpoint(req, res) {
    try {
      if (req.method !== "POST") return reply(res, 405, { code: "invalid_request", message: "POST only" });
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
        return reply(res, 415, { code: "invalid_request", message: "expected application/json" });
      }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_JSON) return reply(res, 413, { code: "invalid_request", message: "request too large" });
        chunks.push(c);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reply(res, 400, { code: "invalid_request", message: "bad JSON" }); }
      if (!body || typeof body !== "object") return reply(res, 400, { code: "invalid_request", message: "bad JSON" });

      if (body.grant === "oidc") return await oidcSignIn(body, res);
      if (body.grant === "revoke") {
        const token = req.headers["lattice-session"];
        if (typeof token === "string") sessions.delete(token);
        return reply(res, 200, {}, { "Lattice-Clear-Session": "1" });
      }
      reply(res, 400, { code: "invalid_request", message: "unknown grant" });
    } catch (e) {
      log(`token endpoint: ${e.stack ?? e}`);
      reply(res, 500, { code: "internal", message: "internal error" });
    }
  }

  return { identify, passkey, tokenEndpoint, sessions, users, issueSession };
}

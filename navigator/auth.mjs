// The host's side of authentication (spec/auth.md).
//
// The app asks; the broker decides what the user is shown, builds every URL and option set that
// matters itself, waits for the user, and installs the session the server issues. Nothing here
// trusts a value that came from the component beyond what the manifest already allows.

import { b64uEncode, fromUtf8, randomToken, sha256, utf8, uuid } from "./bytes.mjs";
import { applySessionHeaders } from "./rpc.mjs";
import { Prompts, HostFailure, fail, DEFAULT_TIMEOUT_MS } from "./prompts.mjs";

const MAX_OPTIONS = 16 * 1024;
const MAX_RESPONSE = 64 * 1024;
const isLoopbackHost = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/** A failure the app may see: carries a WIT `host-error` value. */
export const AuthFailure = HostFailure;
const rand = () => randomToken(32);

export class AuthBroker {
  /**
   * @param manifest      the verified manifest
   * @param tokenEndpoint absolute URL (already mapped to the address the manifest was fetched from) or null
   * @param session       SessionStore
   * @param uiOrigin      () => origin the user's browser is on, e.g. http://tasks.localhost:7070
   * @param prompts       shared Prompts (or pass `broadcast` and one is made)
   */
  constructor({ manifest, tokenEndpoint, session, uiOrigin, prompts, broadcast, dev = false, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = (...args) => fetch(...args) }) {
    const app = { name: manifest.name ?? manifest.app, domain: manifest.app };
    Object.assign(this, { manifest, tokenEndpoint, session, uiOrigin, dev, fetchImpl });
    this.prompts = prompts ?? new Prompts({ broadcast, app, timeoutMs });
  }

  /** Public view of the pending interactions, for a window that connects mid-flow. */
  list() {
    return this.prompts.list();
  }

  /** The user pressed Cancel in the host dialog. */
  cancel(id) {
    return this.prompts.cancel(id);
  }

  dispose() {
    this.prompts.dispose();
  }

  // ---- OIDC ----------------------------------------------------------------------------------

  #urlOk(u) {
    try {
      const url = new URL(u);
      return url.protocol === "https:" || (this.dev && url.protocol === "http:" && isLoopbackHost(url.hostname));
    } catch {
      return false;
    }
  }

  async #discover(issuer) {
    if (!this.#urlOk(issuer)) throw fail("invalid-argument", "the issuer must be an https URL");
    let doc;
    try {
      const res = await this.fetchImpl(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > 256 * 1024) throw new Error("response too large");
      doc = JSON.parse(text);
    } catch (e) {
      throw fail("unavailable", `could not reach the identity provider: ${e.message}`);
    }
    if (doc.issuer !== issuer) throw fail("invalid-argument", "the identity provider names a different issuer");
    if (!this.#urlOk(doc.authorization_endpoint)) throw fail("invalid-argument", "the identity provider's authorization endpoint is not acceptable");
    if (Array.isArray(doc.code_challenge_methods_supported) && !doc.code_challenge_methods_supported.includes("S256")) {
      throw fail("unavailable", "the identity provider does not support PKCE (S256)");
    }
    return doc;
  }

  async oidc(issuer) {
    const provider = this.manifest.auth?.providers?.find((p) => p.type === "oidc" && p.issuer === issuer);
    if (!provider) throw fail("invalid-argument", "that issuer is not declared in the app's manifest");
    if (!this.tokenEndpoint) throw fail("unavailable", "the app declares no auth.token_endpoint");

    const cfg = await this.#discover(issuer);
    const state = rand();
    const nonce = rand();
    const verifier = rand(); // 43 characters of base64url: within RFC 7636's 43-128
    const challenge = b64uEncode(await sha256(utf8(verifier)));
    const redirectUri = `${this.uiOrigin()}/_navigator/auth/callback`;

    const url = new URL(cfg.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: provider.client_id,
      redirect_uri: redirectUri,
      scope: (provider.scopes?.length ? provider.scopes : ["openid"]).join(" "),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })) url.searchParams.set(k, v);

    const code = await this.prompts.ask({ flow: "oidc", issuerHost: new URL(issuer).host, url: url.href }, { state, issuer });

    let res;
    try {
      res = await this.fetchImpl(this.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Lattice-Session": this.session.token(), "Lattice-Request-Id": uuid() },
        body: JSON.stringify({ grant: "oidc", issuer, code, code_verifier: verifier, redirect_uri: redirectUri, nonce }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw fail("unavailable", `could not reach the app's server: ${e.message}`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw fail("invalid-argument", String(body.message ?? `sign-in was refused (${res.status})`).slice(0, 200));
    }
    if (!applySessionHeaders(this.session, res.headers)) throw fail("internal", "the server did not issue a usable session");
    return this.session.info();
  }

  /**
   * The browser was redirected back to us by the identity provider. Returns what to tell the user.
   * An unknown `state` is rejected without touching any pending request.
   */
  callback(params) {
    // A repeated parameter is ambiguous (parameter pollution): refuse it without touching any pending request.
    for (const name of ["state", "code", "iss", "error"]) {
      if (params.getAll(name).length > 1) return { ok: false, message: "This sign-in link is not valid. Return to the app and try again." };
    }
    const state = params.get("state");
    const entry = this.prompts.byState("oidc", state);
    if (!entry) return { ok: false, message: "This sign-in link is not valid or has expired. Return to the app and try again." };
    const id = entry.prompt.id;

    const iss = params.get("iss"); // RFC 9207: reject a response from a different issuer
    if (iss && iss !== entry.issuer) {
      this.prompts.settle(id, "reject", fail("invalid-argument", "the response came from a different identity provider"));
      return { ok: false, message: "Sign-in failed." };
    }
    if (params.get("error")) {
      this.prompts.settle(id, "reject", fail("cancelled"));
      return { ok: false, message: "Sign-in was cancelled." };
    }
    const code = params.get("code");
    if (!code || code.length > 2048) {
      this.prompts.settle(id, "reject", fail("invalid-argument", "the identity provider returned no code"));
      return { ok: false, message: "Sign-in failed." };
    }
    this.prompts.settle(id, "resolve", code);
    return { ok: true, message: "Sign-in complete. You can close this tab and return to the app." };
  }

  // ---- Passkeys ------------------------------------------------------------------------------

  /** `flow` is "create" or "assert"; `optionsBytes` is the app's UTF-8 JSON. Returns UTF-8 JSON bytes. */
  async passkey(flow, optionsBytes) {
    const domain = this.manifest.app;
    if (new URL(this.uiOrigin()).hostname !== domain) {
      throw fail("unavailable", `passkeys need this window to be served from ${domain}; open http://${domain}:<port>/ instead`);
    }
    if (optionsBytes.length > MAX_OPTIONS) throw fail("invalid-argument", "options too large");
    let options;
    try {
      options = JSON.parse(fromUtf8(optionsBytes));
    } catch {
      throw fail("invalid-argument", "options are not valid JSON");
    }
    if (!options || typeof options !== "object" || typeof options.challenge !== "string") throw fail("invalid-argument", "options have no challenge");

    // The relying party is the app's domain. It is checked, never taken on trust and never defaulted
    // to something else, so the app cannot ask the user to sign in as another site.
    if (flow === "create") {
      if (options.rp?.id !== domain) throw fail("invalid-argument", `rp.id must be ${domain}`);
    } else if (options.rpId !== undefined && options.rpId !== domain) {
      throw fail("invalid-argument", `rpId must be ${domain}`);
    }
    if (flow === "assert") options.rpId = domain;
    delete options.extensions; // the app does not get to enable authenticator extensions

    const response = await this.prompts.ask({ flow: flow === "create" ? "passkey-create" : "passkey-assert", options });
    return utf8(response);
  }

  /** The window finished (or failed) a passkey ceremony. */
  finishPasskey(id, body) {
    const entry = this.prompts.get(id);
    if (!entry || !entry.prompt.flow.startsWith("passkey")) return false;
    if (!body || body.ok !== true) {
      const name = String(body?.error ?? "");
      return this.prompts.settle(id, "reject", name === "NotAllowedError" || name === "AbortError" ? fail("cancelled") : fail("unavailable", name.slice(0, 120) || "the passkey operation failed"));
    }
    let valid = typeof body.response === "string" && body.response.length <= MAX_RESPONSE;
    if (valid) {
      try {
        const r = JSON.parse(body.response);
        valid = r && r.type === "public-key" && typeof r.id === "string";
      } catch {
        valid = false;
      }
    }
    if (!valid) return this.prompts.settle(id, "reject", fail("invalid-argument", "the passkey response was malformed"));
    return this.prompts.settle(id, "resolve", body.response);
  }

  // ---- Sign out ------------------------------------------------------------------------------

  async signOut() {
    if (this.tokenEndpoint) {
      try {
        await this.fetchImpl(this.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Lattice-Session": this.session.token(), "Lattice-Request-Id": uuid() },
          body: JSON.stringify({ grant: "revoke" }),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        /* best effort: the local session is dropped regardless */
      }
    }
    this.session.rotate();
  }
}

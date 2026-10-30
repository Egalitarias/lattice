// A minimal OpenID Connect provider for DEVELOPMENT AND TESTS ONLY.
//
// It implements enough of the standard to exercise Lattice's OIDC flow without third-party
// credentials: discovery, JWKS, the authorization-code flow with mandatory PKCE (S256), single-use
// codes, and signed ID tokens. It has two hard-coded users and no real authentication.
//
//   node dev-idp.mjs [--port 9000] [--client-id lattice-dev] [--client-secret s3cret]

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const CALLBACK_PATH = "/_navigator/auth/callback";
const isLoopbackHost = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

export const USERS = {
  alice: { sub: "alice-1001", name: "Alice Example", email: "alice@example.test", preferred_username: "alice" },
  bob: { sub: "bob-2002", name: "Bob Example", email: "bob@example.test", preferred_username: "bob" },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const b64u = (buf) => Buffer.from(buf).toString("base64url");

export async function startIdp({ port = 0, clientId = "lattice-dev", clientSecret, codeTtlMs = 60_000, now = () => Date.now() } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "dev-1", alg: "ES256", use: "sig" };
  const requests = new Map(); // rid -> authorization request awaiting the user's decision
  const codes = new Map(); // code -> issued authorization code
  let issuer;

  const redirectAllowed = (uri) => {
    try {
      const u = new URL(uri);
      return u.protocol === "http:" && isLoopbackHost(u.hostname) && u.pathname === CALLBACK_PATH && !u.search && !u.hash;
    } catch { return false; }
  };

  const send = (res, status, body, type = "application/json", headers = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const page = (res, status, html) =>
    send(res, status, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev identity provider</title><body style="font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem">${html}`, "text/html; charset=utf-8", {
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *",
      "X-Frame-Options": "DENY",
    });

  async function readForm(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 16 * 1024) throw new Error("too large");
      chunks.push(c);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, issuer ?? "http://localhost");

      if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return send(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks.json`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile", "email"],
          token_endpoint_auth_methods_supported: clientSecret ? ["client_secret_post"] : ["none"],
        });
      }
      if (req.method === "GET" && url.pathname === "/jwks.json") return send(res, 200, { keys: [jwk] });

      if (req.method === "GET" && url.pathname === "/authorize") {
        const q = url.searchParams;
        const redirectUri = q.get("redirect_uri") ?? "";
        // Errors before the redirect URI is trusted must not redirect.
        if (q.get("client_id") !== clientId) return page(res, 400, "<h1>Unknown client</h1>");
        if (!redirectAllowed(redirectUri)) return page(res, 400, "<h1>Redirect URI not allowed</h1>");
        const fail = (error) => {
          const back = new URL(redirectUri);
          back.searchParams.set("error", error);
          if (q.get("state")) back.searchParams.set("state", q.get("state"));
          back.searchParams.set("iss", issuer);
          send(res, 302, "", "text/plain", { Location: back.href });
        };
        if (q.get("response_type") !== "code") return fail("unsupported_response_type");
        if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256") return fail("invalid_request");
        if (!(q.get("scope") ?? "").split(" ").includes("openid")) return fail("invalid_scope");
        const rid = b64u(randomBytes(18));
        requests.set(rid, {
          redirectUri,
          state: q.get("state"),
          nonce: q.get("nonce"),
          challenge: q.get("code_challenge"),
          expires: now() + 10 * 60_000,
        });
        const buttons = Object.entries(USERS)
          .map(([id, u]) => `<p><button name="user" value="${esc(id)}">Continue as ${esc(u.name)}</button></p>`)
          .join("");
        return page(res, 200, `<h1>Dev identity provider</h1><p>Client <code>${esc(clientId)}</code> wants to sign you in. This is a development server with no passwords.</p>
          <form method="post" action="/authorize/decision"><input type="hidden" name="rid" value="${esc(rid)}">${buttons}<p><button name="user" value="">Deny</button></p></form>`);
      }

      if (req.method === "POST" && url.pathname === "/authorize/decision") {
        const f = await readForm(req);
        const r = requests.get(f.get("rid"));
        requests.delete(f.get("rid"));
        if (!r || r.expires < now()) return page(res, 400, "<h1>This sign-in request expired</h1>");
        const back = new URL(r.redirectUri);
        if (r.state) back.searchParams.set("state", r.state);
        back.searchParams.set("iss", issuer);
        const user = USERS[f.get("user")];
        if (!user) back.searchParams.set("error", "access_denied");
        else {
          const code = b64u(randomBytes(24));
          codes.set(code, { user, redirectUri: r.redirectUri, nonce: r.nonce, challenge: r.challenge, expires: now() + codeTtlMs });
          back.searchParams.set("code", code);
        }
        return send(res, 302, "", "text/plain", { Location: back.href });
      }

      if (req.method === "POST" && url.pathname === "/token") {
        const f = await readForm(req);
        const bad = (error, status = 400) => send(res, status, { error });
        if (f.get("grant_type") !== "authorization_code") return bad("unsupported_grant_type");
        if (f.get("client_id") !== clientId) return bad("invalid_client", 401);
        if (clientSecret && f.get("client_secret") !== clientSecret) return bad("invalid_client", 401);
        const code = codes.get(f.get("code"));
        codes.delete(f.get("code")); // single use, even when the rest of the request is wrong
        if (!code || code.expires < now()) return bad("invalid_grant");
        if (f.get("redirect_uri") !== code.redirectUri) return bad("invalid_grant");
        const verifier = f.get("code_verifier") ?? "";
        if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return bad("invalid_grant");
        if (b64u(createHash("sha256").update(verifier).digest()) !== code.challenge) return bad("invalid_grant");

        const claims = { name: code.user.name, email: code.user.email, preferred_username: code.user.preferred_username };
        if (code.nonce) claims.nonce = code.nonce;
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: "ES256", kid: "dev-1" })
          .setIssuer(issuer)
          .setSubject(code.user.sub)
          .setAudience(clientId)
          .setIssuedAt(Math.floor(now() / 1000))
          .setExpirationTime(Math.floor(now() / 1000) + 300)
          .sign(privateKey);
        return send(res, 200, { access_token: b64u(randomBytes(16)), token_type: "Bearer", expires_in: 300, id_token: idToken });
      }

      send(res, 404, { error: "not_found" });
    } catch (e) {
      send(res, 500, { error: "server_error" });
    }
  });

  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  const actual = server.address().port;
  issuer = `http://127.0.0.1:${actual}`;
  return {
    issuer,
    clientId,
    clientSecret,
    port: actual,
    close: () => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
  const idp = await startIdp({ port: Number(opt("--port", 9000)), clientId: opt("--client-id", "lattice-dev"), clientSecret: opt("--client-secret") });
  console.log(`dev identity provider (NOT FOR PRODUCTION): ${idp.issuer}`);
  console.log(`  client_id ${idp.clientId}${idp.clientSecret ? " (client_secret required)" : " (public client, PKCE)"}`);
  console.log(`  users: ${Object.keys(USERS).join(", ")}`);
}

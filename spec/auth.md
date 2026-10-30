# Lattice authentication (draft 0.1)

Sign-in in Lattice has two rules that the web does not enforce:

1. **The app never handles credentials or session tokens.** The host runs the ceremony, in UI the app cannot draw
   or intercept, and holds the resulting session. The app learns only *that* the user is signed in.
2. **The origin's server is the only authority.** The host proves nothing by itself; the server verifies every
   assertion and decides who the user is.

## Sessions

A session is an opaque token the host stores per origin and sends as `Lattice-Session` on RPC calls (see `rpc.md`).
Before sign-in it is an **anonymous** token the host generated. Signing in **replaces** it with a token the server
issued (so a token fixed before login is never promoted).

### Changing the host's session: `Lattice-Set-Session`

An origin changes the host's session by adding a response header on a **`200` response** from its RPC endpoint or its
`auth.token_endpoint`:

```
Lattice-Set-Session: <base64url of this JSON, UTF-8>
  { "token": "<opaque, 32-128 chars of [A-Za-z0-9_-]>",
    "subject": "<stable user id, 1-256 chars>",
    "name": "<display name, optional, at most 80 chars>",
    "expires": <unix seconds, in the future, at most 30 days ahead> }

Lattice-Clear-Session: 1          # drop the session; the host falls back to a fresh anonymous token
```

The host **consumes and strips** these headers: the app's component never sees them, the token, or the response
header. Headers on non-`200` responses, or with any field outside the limits above, are ignored. When the session
expires the host discards it and uses a fresh anonymous token.

`session.current()` returns `{signed-in, subject, expires-at}`. `name` is for the host's own chrome and is not
exposed to the component; an app that wants to show a name asks its server.

### `auth.token_endpoint`

An HTTPS URL on the app's origin (manifest `auth.token_endpoint`). The host `POST`s JSON with
`Content-Type: application/json` and the current `Lattice-Session`:

| `grant` | extra fields | success |
|---|---|---|
| `oidc` | `issuer`, `code`, `code_verifier`, `redirect_uri`, `nonce` | `200`, `Lattice-Set-Session` |
| `revoke` | none | `200`; the server invalidates the token |

Failure is a non-`200` with JSON `{ "code": "...", "message": "..." }`. The host maps any such failure to
`host-error.invalid-argument(message)` for the app.

## OIDC (`auth.oidc`)

The host is a **public client using the authorization-code flow with PKCE (S256)**; the origin's server is the one
that finishes the exchange and verifies the result. This is the loopback-redirect pattern of RFC 8252.

```
App ── auth.sign-in-oidc(issuer) ──► Host
Host: 1. issuer must be listed in manifest auth.providers (type oidc), else invalid-argument
      2. discovery: GET {issuer}/.well-known/openid-configuration; its "issuer" must equal the requested one
      3. generate state, nonce, PKCE verifier; build the authorization URL
      4. draw the sign-in dialog:  "Sign in to <app> (<domain>) with <issuer host>?"   [Continue] [Cancel]
      5. on Continue, open the authorization URL in a new window (noopener)
User ◄──► IdP (any web page; authenticates, consents)
IdP ──► redirect to  {host-ui-origin}/_navigator/auth/callback?code=...&state=...
Host: 6. state must match a pending request; otherwise the callback is rejected
      7. POST token_endpoint { grant: "oidc", issuer, code, code_verifier, redirect_uri, nonce }
Server: 8. exchange the code at the IdP token endpoint (with the verifier, and a client secret if it has one)
        9. verify the ID token (see below), find or create the user, issue a session
       10. 200 + Lattice-Set-Session
Host: 11. store the session; return session.info to the app
```

**What the server must verify on the ID token** (all of them, every time):

- signature, against the issuer's JWKS, with an allow-list of algorithms that excludes `none` and symmetric algorithms
- `iss` equals the configured issuer; `aud` contains the client id
- `exp` and `iat` are valid (small clock skew only)
- `nonce` equals the `nonce` the host sent
- the issuer is one the server is configured to trust; a body-supplied issuer is only a *selector* among them
- `redirect_uri` is on the app's own origin at `/_navigator/auth/callback`

Users are keyed by `(iss, sub)`, never by email.

A callback that repeats a parameter (`state`, `code`, `iss`, `error`) is refused outright rather than guessing which value
is meant, and an `iss` that does not match the issuer is refused (RFC 9207).

**What the host guarantees:** the authorization URL is built by the host from the manifest and discovery, so the app
cannot choose where the user is sent; the dialog text comes from the host and manifest only; `state` binds a callback
to exactly one pending request, which is single-use and expires after 5 minutes.

## Passkeys (`auth.passkey`)

WebAuthn, with the app's **domain as the relying-party ID**. The app asks its server for options over RPC, hands them
to the host, and sends the host's result back to its server.

```
App ── rpc: passkey_*_begin ──► Server            returns options (JSON text) and remembers the challenge
App ── auth.passkey-create / passkey-assert(options) ──► Host
Host: 1. parse; reject unless the relying-party ID is exactly the app's domain (it is never taken from the app)
      2. remove extensions; draw the dialog: "Create a passkey for <domain>?" / "Sign in to <domain> with a passkey?"
      3. on Continue, run navigator.credentials.create/get in the host's own UI; the browser binds the origin
      4. return the JSON-encoded credential to the app
App ── rpc: passkey_*_finish(response) ──► Server   verifies, issues a session, replies with Lattice-Set-Session
```

**What the server must verify:** the challenge is one it issued, unused and unexpired; the `origin` in the client data
is acceptable for the domain (`https://<domain>` in production); the relying-party ID hash matches; the signature
verifies against a stored public key; the signature counter does not go backwards (when the authenticator uses one);
user presence. The challenge is consumed whether or not verification succeeds.

The method names (`passkey_register_begin`, ...) are the app's own API, not part of the protocol: the contract is the
host's `auth.passkey-create/assert` and the server's use of `Lattice-Set-Session`.

## Prototype constraint: where the UI is served

A browser enforces that a WebAuthn relying-party ID be a suffix of the page's origin. The prototype Navigator serves
its UI at `http://<app domain>:<port>` when the domain ends in `.localhost` (browsers resolve those to loopback), so
the origin and the relying-party ID are both the app's domain. For any other domain the prototype serves the UI at
`127.0.0.1`, passkeys report `unavailable`, and OIDC still works. A native Navigator would use the platform's
passkey API with the app's domain directly.

## Not specified yet

- Account recovery, multiple credentials per account, and linking OIDC and passkey identities.
- Step-up authentication and per-action re-authentication.
- Sign-in without a user-visible dialog (silent / FedCM-style account picking).
- `auth.oidc` with a confidential client held by the host.

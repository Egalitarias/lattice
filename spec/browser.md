# Browser Navigator (draft 0.1)

Lattice Navigator can run entirely in a web browser, served by the app's own origin. A browser that visits
`https://example.com/` sends `Accept: text/html`; an origin that has the browser Navigator installed answers with a
small bootstrap page that loads the host from `/.lattice/navigator/`. Lattice clients that ask for
`application/vnd.lattice.app+cbor` still get the manifest at the same URL.

## What runs where

1. The page fetches the manifest from its own origin, validates it, and requires `manifest.app` to equal
   `location.hostname` (no development exception).
2. It fetches the entry component, verifies its SHA-256 with WebCrypto, and transpiles it to JavaScript plus
   core WebAssembly in a Worker (jco-transpile). The result is cached in IndexedDB under
   `<transpile version>:<component hash>`, so a given component is transpiled once per browser.
3. The transpiled component runs in a second Worker that blocks on a `SharedArrayBuffer` while the host answers its
   imports, exactly as the Node worker does. The host draws the scene with the same renderer as the Node Navigator.
4. RPC, token, payment and analytics endpoints are same-origin. Passkeys use the real domain as relying party, and
   OIDC and payment redirects return to the app's origin. Those return URLs (`/_navigator/auth/callback`,
   `/_navigator/payment/return|cancel`) serve the same bootstrap page, which relays the query over a same-origin
   `BroadcastChannel` to the window that owns the pending request and clears it from the address bar.

## Required headers

| Resource | Headers |
|---|---|
| Page | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, CSP `script-src 'self'` (no eval, no inline), `worker-src 'self'`, `frame-ancestors 'none'`, `form-action 'none'`, `base-uri 'none'` |
| `component-worker.js` | CSP `default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'none'`: the app's code cannot open any network connection |
| `transpile-worker.js` | CSP `script-src 'self' 'wasm-unsafe-eval'` |
| `sw.js` | `Service-Worker-Allowed: /` |

Cross-origin isolation is required for the blocking host call. A page without it shows an explanation instead of
running. It also means cross-origin subresources (images, an identity provider's discovery document) must send CORS
or CORP headers.

## Service worker

Caches `/.lattice/blob/<hash>` (content-addressed, so never stale) and the host's own files. It never caches the
manifest, RPC, authentication, payment or analytics traffic. The app works without it, and offline loads work after a visit.

## Trust trade-off

The host code is delivered by the same origin whose app it runs. This mode protects users from a compromised
component or dependency (it is hash-verified and confined to a network-less Worker) but **not** from a malicious
origin, which could serve a modified host. The native Navigator, installed independently of the origin, is the
stronger boundary. Apps should treat the two as different trust levels.

## Live updates

Topics (spec/rpc.md) use the browser's own `WebTransport` when the manifest offers `api.stream`, otherwise a streaming
`fetch`. Both are allowed by the page's `connect-src 'self' https:`; WebTransport needs a UDP path to the origin.

## Limits

Non-loopback use needs TLS, as with any passkey or payment flow. Component storage uses `localStorage` (about 5 MB).
Serve it with `node server/server.mjs` after `npm run build:browser` in `navigator/`
(`--no-navigator` to disable, `--navigator-dist <dir>` to choose a build).

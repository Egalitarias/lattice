# Lattice

An application platform for the internet that does not use HTML, CSS or JavaScript.
Lattice keeps what the web got right (DNS, TLS, domains, URLs, origin security, HTTP caching)
and replaces the application layer with typed, compiled, semantic parts.

**Lattice Navigator** (the "Navigator" for short) is the host/client that runs Lattice apps.

> Status: draft spec 0.1 plus a working prototype (origin server, Lattice Navigator host, typed RPC, sign-in with OIDC and passkeys, hosted-checkout payments, privacy-controlled analytics, two reference apps).
> Not production software: see "Prototype limits" below.

## Principles

- Domains and HTTPS are the foundation. Origin = security boundary.
- Apps are WASM components in any language; no privileged language.
- UI is a typed, semantic scene tree. Roles and labels are required (accessibility by construction).
- No ambient authority. Apps receive explicit, revocable capability handles.
- No third-party script injection. Dependencies are declared and hash-pinned.
- Humans and agents share one surface: every app exposes an action schema.
- Incremental adoption: servers fall back to HTML via `Accept` negotiation.

## Layer stack

| Layer | Web today | Lattice |
|---|---|---|
| Naming and trust | DNS + TLS + origin | unchanged |
| Transport | HTTP/1-3 | unchanged, plus WebTransport |
| Discovery | URL returns HTML | URL returns an App Manifest |
| Code | JavaScript | WASM components |
| UI | DOM + CSS | typed semantic scene tree + constraint layout |
| Data | fetch + JSON | typed binary RPC |
| Permissions | ad-hoc prompts | origin-bound capability handles |
| Automation | scraping | action schema |

## Request flow

```
GET https://shop.example.com/orders/42
Accept: application/vnd.lattice.app+cbor, text/html;q=0.1
```

1. Server returns the manifest (or HTML as legacy fallback).
2. Lattice Navigator fetches the WASM bundle by content hash (immutable, cached).
3. Bundle runs sandboxed, routes the URL, renders the scene tree.
4. Further navigation needs only data calls.

## Standard capability set (draft)

```
auth.oidc  auth.passkey  session
payments.request  payments.mandate
ads.slot
analytics.event  experiments
notifications  share  files.pick  contacts.pick
identity.age_over  consent
navigate.external  embed.<provider>
```

Payments and ads are host-rendered: apps never see card data and cannot inject ad code.
Stripe integrates via hosted Checkout first, then a host payment handler.

## Naming

- **Lattice**: the protocol/spec and bundle format (`.lattice`, `application/vnd.lattice.app+cbor`)
- **Lattice Navigator**: the host/client application, called the Navigator in code and prose after first mention

## Try it

Needs Node 22+ and Rust with the `wasm32-wasip2` target (`rustup target add wasm32-wasip2`).
Two reference apps: `examples/todo` (state on the device, `storage` capability) and `examples/tasks`
(state on the server, typed RPC).

```
# 1. build a reference app into a WASM component (use examples/todo instead for the local-storage one)
cd examples/tasks && cargo build --release --target wasm32-wasip2 && cd ../..

# 2. start an origin that serves it
cd server && npm install && node server.mjs --app ../examples/tasks --port 8080

# 3. in another terminal, start Lattice Navigator pointed at it, then open the printed URL
cd navigator && npm install && node navigator.mjs http://127.0.0.1:8080/ --dev
```

To try sign-in with the `tasks` app, also start the development identity provider and tell the server to trust it:

```
cd server && node dev-idp.mjs --port 9000 --client-id lattice-tasks                      # NOT for production
cd server && node server.mjs --app ../examples/tasks --port 8080 --dev \
    --oidc http://127.0.0.1:9000,lattice-tasks
cd navigator && node navigator.mjs http://127.0.0.1:8080/ --dev
# open http://tasks.localhost:7070/  (the app's own domain, which a browser accepts as the passkey relying party)
```

You get "Create passkey", "Sign in with a passkey", and "Sign in with 127.0.0.1:9000" in the app. The dialogs and the strip at the
top ("tasks.localhost · Signed in as ...") are drawn by Navigator, not by the app.

To try payments (signed-in users can "Upgrade to Pro" for $4.00), add a processor. The bundled one is a stand-in that speaks
Stripe's API, so the server uses the real `stripe` library against it:

```
cd server && node dev-psp.mjs --port 9200 --webhook-url http://127.0.0.1:8080/pay/webhook      # NOT a real processor
cd server && node server.mjs --app ../examples/tasks --port 8080 --dev \
    --oidc http://127.0.0.1:9000,lattice-tasks \
    --stripe-key sk_test_dev --stripe-webhook-secret whsec_dev --stripe-api http://127.0.0.1:9200
```

Analytics: the `tasks` app declares a first-party processor and a catalog of events. By default only error reports may
leave (level "errors only"); open the Privacy control in the strip at the top to choose Off / Errors only / Anonymous / Full,
see who receives what, and read the events that were actually sent. `GET /events/summary` on the server shows what its
collector has received.

With real Stripe, use your own test-mode keys and drop `--stripe-api`; point a webhook endpoint at `https://<your domain>/pay/webhook`.
**That has not been tried**: nothing here has run against the live Stripe service.

What happens: Lattice Navigator asks the origin for `application/vnd.lattice.app+cbor`, validates the manifest, downloads the
component by content hash and refuses it if the bytes differ, runs it with only the host imports the manifest grants
(`tasks`: `log` and `rpc`), and renders the scene tree it returns. For `tasks`, every call the component makes to
its server is validated against the app's API description in both directions (see `spec/rpc.md`). Browsers asking for HTML get a plain fallback page.

Tests:

```
cd spec && npm install && npm run validate        # schemas, fixtures, WIT parses, WIT/schema agree
cd navigator && npm test                                # 109 end-to-end tests with the real components
cd navigator && node test/browser-check.mjs http://127.0.0.1:7070/   # drives Edge/Chrome through the UI
cd navigator && node test/auth-browser-check.mjs                      # sign-in in Edge/Chrome with a virtual authenticator
cd navigator && node test/payments-browser-check.mjs                  # a full purchase in Edge/Chrome
cd navigator && node test/analytics-browser-check.mjs                 # the Privacy control in Edge/Chrome
```

### Browser mode

```
cd navigator && npm run build:browser        # once
cd server && node server.mjs --app ../examples/tasks --port 8080 --dev
# open http://tasks.localhost:8080/ in a browser: no separate Navigator process
```

Check it with `node test/browser-mode-check.mjs`, or run the other browser checks with `--browser-mode`.

## Prototype limits

- Two hosts exist: the Node Navigator (component in a worker thread, UI in a local page) and the browser Navigator
  (served by the app's own origin, component transpiled to JS in a Worker; see `spec/browser.md`). The browser one
  removes the `*.localhost`-only limits below for passkeys and payments (non-loopback use needs TLS), but trusts the
  origin that serves it; its component storage is `localStorage`.
- Implemented host imports: `log`, `storage`, `rpc` (request/response only). The rest of `spec/wit/capabilities.wit`
  is specified, not implemented.
- Auth: OIDC and passkeys work end to end, but accounts and sessions live in the origin's memory, there is no account
  recovery or credential management, and the only identity provider tried is the bundled development one (it is
  standards-shaped but not a real provider). Passkeys need Navigator's page served from the app's domain, so in this
  prototype they work for `*.localhost` names; OIDC works for any domain. See `spec/auth.md`.
- Payments: hosted checkout only (the processor draws the card form on its own domain). The server code uses the
  official `stripe` library but has only been run against the bundled stand-in, which mirrors Stripe's documentation.
  There is no host-drawn card or wallet sheet, no recurring payments, refunds or receipts, and orders are in memory.
  A double payment (two checkout sessions for one order both paid) is detected and logged but not refunded.
  The server only accepts return addresses on the app's own domain, and Navigator serves its page there only for
  `*.localhost` names, so (like passkeys) payments work for `.localhost` apps in this prototype.
  See `spec/payments.md`.
- Analytics: product events, host timings and error reports, with four user-set levels, a declared event catalog,
  redaction and a transparency panel (`spec/analytics.md`). The collector in the example keeps events in memory.
  Not specified: experiments / A/B assignment, session replay, consent flows, per-purpose levels, retention. Redaction
  catches values the user typed into sensitive inputs and common personal-data patterns in error text; it cannot catch
  data the app has transformed. The processor's server necessarily sees the user's IP address.
- RPC: no streaming, no cross-origin APIs, JSON data model only (see `spec/rpc.md`). The prototype origin keeps
  state in memory.
- Plain `http` is accepted only on loopback with `--dev`; the dev flag also accepts a manifest domain that
  differs from the address fetched.
- Renderer gaps: `layer` constraints, `canvas`, `media` with hashed sources, `ad-slot` and `embed` are placeholders.
- Rust apps built for `wasm32-wasip2` import libc-level WASI; Lattice Navigator provides a sandboxed shim with no filesystem,
  environment or network.
- One user, one app instance per Lattice Navigator process.

## Roadmap

1. [x] Spec: manifest schema, scene-tree schema, capability catalog, WIT component interface
2. [x] Prototype server with `Accept` negotiation and hash-verified components
3. [x] Lattice Navigator (Node host + semantic browser UI), reference todo app, end-to-end and browser tests
4. [x] Typed RPC (`rpc` import), API descriptions, and a server-backed app
5. [ ] Browser-only Lattice Navigator (service worker + transpiled WASM)
6. [x] Auth: OIDC and passkeys, host-drawn sign-in, session upgrade
6b. [x] Payments: hosted checkout (Stripe), signed webhooks, server-priced orders
6c. [x] Analytics and error reporting: declared catalog, user levels, redaction, transparency
6d. [ ] A host-drawn payment sheet, experiments
7. [ ] A 2D multiplayer world (WebTransport + canvas)

## License

Copyright 2026 Gary Davies. Licensed under the [Apache License, Version 2.0](LICENSE). Unless you state otherwise,
any contribution you submit for inclusion is licensed under the same terms, with no additional conditions.

As stated in Section 6 of the License, it does not grant permission to use the names "Lattice" or "Lattice Navigator" as trademarks.

## Open problems

Discoverability/SEO, text and IME in a non-DOM renderer, WASM startup size,
developer experience, anti-cheat, and governance of the spec.

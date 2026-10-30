# Lattice

An application platform for the internet that does not use HTML, CSS or JavaScript.
Lattice keeps what the web got right (DNS, TLS, domains, URLs, origin security, HTTP caching)
and replaces the application layer with typed, compiled, semantic parts.

**Lattice Navigator** (the "Navigator" for short) is the host/client that runs Lattice apps.

> Status: draft spec 0.1 plus a working prototype (origin server, Lattice Navigator host, typed RPC, sign-in with OIDC and passkeys, two reference apps).
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

What happens: Lattice Navigator asks the origin for `application/vnd.lattice.app+cbor`, validates the manifest, downloads the
component by content hash and refuses it if the bytes differ, runs it with only the host imports the manifest grants
(`tasks`: `log` and `rpc`), and renders the scene tree it returns. For `tasks`, every call the component makes to
its server is validated against the app's API description in both directions (see `spec/rpc.md`). Browsers asking for HTML get a plain fallback page.

Tests:

```
cd spec && npm install && npm run validate        # schemas, fixtures, WIT parses, WIT/schema agree
cd navigator && npm test                                # 58 end-to-end tests with the real components
cd navigator && node test/browser-check.mjs http://127.0.0.1:7070/   # drives Edge/Chrome through the UI
cd navigator && node test/auth-browser-check.mjs                      # sign-in in Edge/Chrome with a virtual authenticator
```

## Prototype limits

- Lattice Navigator runs the component in a Node worker thread and shows the UI in a local browser page. A browser-only Lattice Navigator (service
  worker plus transpiled WASM) is not built yet.
- Implemented host imports: `log`, `storage`, `rpc` (request/response only). The rest of `spec/wit/capabilities.wit`
  is specified, not implemented.
- Auth: OIDC and passkeys work end to end, but accounts and sessions live in the origin's memory, there is no account
  recovery or credential management, and the only identity provider tried is the bundled development one (it is
  standards-shaped but not a real provider). Passkeys need Navigator's page served from the app's domain, so in this
  prototype they work for `*.localhost` names; OIDC works for any domain. See `spec/auth.md`.
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
6b. [ ] Payments (Stripe Checkout), then analytics
7. [ ] A 2D multiplayer world (WebTransport + canvas)

## License

Copyright 2026 Gary Davies. Licensed under the [Apache License, Version 2.0](LICENSE). Unless you state otherwise,
any contribution you submit for inclusion is licensed under the same terms, with no additional conditions.

As stated in Section 6 of the License, it does not grant permission to use the names "Lattice" or "Lattice Navigator" as trademarks.

## Open problems

Discoverability/SEO, text and IME in a non-DOM renderer, WASM startup size,
developer experience, anti-cheat, and governance of the spec.

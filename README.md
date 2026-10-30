# Lattice

An application platform for the internet that does not use HTML, CSS or JavaScript.
Lattice keeps what the web got right (DNS, TLS, domains, URLs, origin security, HTTP caching)
and replaces the application layer with typed, compiled, semantic parts.

**Lattice Navigator** is the host/client that runs Lattice apps.

> Status: draft spec 0.1 plus a working prototype (origin server, Lattice Navigator host, one reference app).
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
- **Lattice Navigator**: the host/client application

## Try it

Needs Node 22+ and Rust with the `wasm32-wasip2` target (`rustup target add wasm32-wasip2`).

```
# 1. build the reference app (a todo list) into a WASM component
cd examples/todo && cargo build --release --target wasm32-wasip2 && cd ../..

# 2. start an origin that serves it
cd server && npm install && node server.mjs --port 8080

# 3. in another terminal, start Lattice Navigator pointed at it, then open the printed URL
cd navigator && npm install && node navigator.mjs http://127.0.0.1:8080/ --dev
```

What happens: Lattice Navigator asks the origin for `application/vnd.lattice.app+cbor`, validates the manifest, downloads the
component by content hash and refuses it if the bytes differ, runs it with only the host imports the manifest grants
(here: `log` and `storage`), and renders the scene tree it returns. Browsers asking for HTML get a plain fallback page.

Tests:

```
cd spec && npm install && npm run validate        # schemas, fixtures, WIT parses, WIT/schema agree
cd navigator && npm test                                # 13 end-to-end tests with the real component
cd navigator && node test/browser-check.mjs http://127.0.0.1:7070/   # drives Edge/Chrome through the UI
```

## Prototype limits

- Lattice Navigator runs the component in Node and shows the UI in a local browser page. A browser-only Lattice Navigator (service
  worker plus transpiled WASM) is not built yet.
- Implemented host imports: `log`, `storage`. The rest of `spec/wit/capabilities.wit` is specified, not implemented.
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
4. [ ] Typed RPC (`rpc` import) and a stateful server-backed app
5. [ ] Browser-only Lattice Navigator (service worker + transpiled WASM)
6. [ ] Auth (OIDC + passkeys), then payments (Stripe Checkout), then analytics
7. [ ] A 2D multiplayer world (WebTransport + canvas)

## Open problems

Discoverability/SEO, text and IME in a non-DOM renderer, WASM startup size,
developer experience, anti-cheat, and governance of the spec.

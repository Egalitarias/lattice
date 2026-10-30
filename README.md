# Lattice

An application platform for the internet that does not use HTML, CSS or JavaScript.
Lattice keeps what the web got right (DNS, TLS, domains, URLs, origin security, HTTP caching)
and replaces the application layer with typed, compiled, semantic parts.

**Lattice Navigator** is the host/client that runs Lattice apps.

> Status: concept / pre-spec. Nothing here is implemented yet.

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

## Roadmap

1. Spec: manifest schema, scene-tree schema, capability catalog
2. Prototype server with `Accept` negotiation and sample manifest
3. Lattice Navigator browser polyfill (service worker + WASM + canvas/ARIA layer)
4. Reference apps: todo/CRM, then a 2D multiplayer world
5. Auth (OIDC + passkeys), then payments (Stripe Checkout), then analytics

## Open problems

Discoverability/SEO, text and IME in a non-DOM renderer, WASM startup size,
developer experience, anti-cheat, and governance of the spec.

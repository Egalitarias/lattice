# Lattice Specification (draft 0.1)

| Document | Purpose |
|---|---|
| [`manifest.schema.json`](manifest.schema.json) | App manifest: identity, entry component, routes, API, capabilities, actions, auth, payments, analytics, legal |
| [`scene.schema.json`](scene.schema.json) | Scene tree: the UI an app hands to Lattice Navigator |
| [`capabilities.md`](capabilities.md) | Capability catalog and rules |
| [`api.schema.json`](api.schema.json), [`rpc.md`](rpc.md) | Typed RPC: the API description format and the wire protocol |
| [`wit/`](wit/README.md) | Component interface (WIT): how an app and Lattice Navigator talk, and capabilities as imports |

## Conventions

- **Authoring format:** JSON, validated with JSON Schema 2020-12.
- **Wire format:** deterministic CBOR (RFC 8949 section 4.2) of the same data model.
  Media type: `application/vnd.lattice.app+cbor` (manifest). Scene trees are exchanged between
  app and host in-process, and may be sent by servers as `application/vnd.lattice.scene+cbor`.
- **Hashes:** `sha256-` followed by the unpadded base64url SHA-256 digest (43 characters).
  Content fetched by hash is verified before use and cached immutably.
- **Blobs:** content-addressed files (the entry component, assets) are fetched from `/.lattice/blob/{hash}` on the
  manifest's origin and verified against `{hash}` before use. Servers send them `immutable`.
- **Origin binding:** `manifest.app` must equal the host the manifest was fetched from over TLS.
- **Discovery:** content negotiation on the page URL (`Accept: application/vnd.lattice.app+cbor`),
  with optional `/.well-known/lattice.json` and DNS `HTTPS` record hints.
- **Legacy fallback:** servers that do not offer the media type return HTML; `manifest.fallback.html`
  lets Lattice-aware tools find the legacy page.

## Design rules the schemas enforce

1. No code in the tree. Behaviour is a named action (`actionRef`), never evaluated text.
2. No raw styling. Spacing, tone and size come from tokens the host resolves against user settings.
3. Accessibility is structural: interactive nodes require `label`, images require `alt`,
   canvases require `label` and `description`, landmarks require `label`.
4. Third-party code is declared (`dependencies`, hash-pinned) and bounded by capabilities.
5. Money and ads are host-rendered (`payments.*`, `AdSlot`), so the app cannot read or spoof them.

## Validating

```
cd spec
npm install
npm run validate
```

Validates every `manifest.json`, `scene*.json` and `api.json` under `../examples` against its schema, checks that the
negative fixtures in `tests/invalid/` are rejected, that `wit/scene.wit` and the scene schema agree on node types, and
that both WIT worlds parse.

## Status and next documents

- [x] Typed RPC: API description and wire protocol, see `rpc.md`
- [x] Host <-> app component interface (WIT), see `wit/`
- [ ] Payment handler interface and token format
- [ ] Ad network interface and measurement report format
- [ ] Conformance test suite

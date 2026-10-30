# Lattice Capability Catalog (draft 0.1)

A capability is a named, origin-bound handle that the host grants to an app. Apps have no ambient
authority: anything not listed in the manifest's `capabilities.requires` or `capabilities.optional`
is unavailable. Names here are the exact strings accepted by `manifest.schema.json`.

**Rendering column**
- *host UI*: the host draws the interface; the app never sees the content.
- *data*: a typed call returning data to the app.
- *sandboxed*: runs as a declared, hash-pinned component with the capabilities listed.

**Prompt column**: when the user is asked.
- *none*: granted automatically; shown in host settings.
- *on use*: prompt at first use, remembered per origin, revocable.
- *each time*: prompt on every invocation.

## Core

| Capability | Purpose | Rendering | Prompt |
|---|---|---|---|
| `net.origin` | Typed RPC (`rpc.md`) to the app's own origin, at the manifest `api` endpoint | data | none |
| `net.realtime` | WebTransport streams and datagrams to declared endpoints | data | none |
| `storage.local` | Origin-partitioned key-value and blob storage on the device | data | none |
| `storage.sync` | `storage.local` replicated across the user's devices (end-to-end encrypted) | data | on use |
| `gpu.surface` | Handle to a GPU surface for `Canvas` nodes | host UI | none |

## Identity and session

| Capability | Purpose | Rendering | Prompt |
|---|---|---|---|
| `session` | Host-managed, origin-bound session token sent as `Lattice-Session` on RPC calls. Not readable by app code. Anonymous until an `auth.*` flow signs the user in | data | none |
| `auth.passkey` | Create/assert a WebAuthn credential whose relying party is exactly the app's domain (`auth.md`) | host UI | each time |
| `auth.oidc` | OIDC authorization-code + PKCE flow against an issuer listed in the manifest (Google, Apple, GitHub, enterprise IdPs). The app never receives the code or any token; the origin's server verifies the ID token and issues the session (`auth.md`) | host UI | each time |
| `identity.age_over` | Yes/no proof the user is over N, via verifiable credential. App never sees a birthdate | host UI | each time |
| `contacts.pick` | User chooses specific contacts to share. App receives only chosen entries | host UI | each time |
| `consent` | Records versioned consent (terms, marketing, data processing) with a receipt | host UI | each time |

## Money and monetisation

| Capability | Purpose | Rendering | Prompt |
|---|---|---|---|
| `payments.request` | Ask the user to pay for a server-created order via a processor's hosted checkout. The app names the order; the host gets the price and URL from the server and draws the sheet. Returns a receipt, which is not proof of payment (`payments.md`) | host UI | each time |
| `payments.mandate` | Recurring-payment consent, visible and revocable in host settings | host UI | each time |
| `ads.slot` | Allows `AdSlot` nodes to be filled by the host | host UI | none (user sets global ad level) |
| `analytics.event` | Record events from the manifest's declared catalog and report errors. The host validates, redacts, applies the user's level, and is the only sender (`analytics.md`) | data | none (user sets the level) |
| `experiments` | Variant assignment and exposure logging | data | none |

## Device and platform

| Capability | Purpose | Rendering | Prompt |
|---|---|---|---|
| `notifications` | Push notifications via the OS channel | host UI | on use |
| `share` | Invoke the OS share sheet | host UI | each time |
| `files.pick` | User chooses files; app receives read handles (and optional direct-to-storage upload URLs) | host UI | each time |
| `navigate.external` | Open a cross-origin URL in an isolated system view (e.g. hosted checkout) | host UI | on use |
| `camera` | Camera stream | host UI | on use |
| `microphone` | Microphone stream | host UI | on use |
| `location` | Coarse or precise location | data | on use |

## Extensions

| Pattern | Purpose |
|---|---|
| `embed.<provider>` | Permits an `Embed` node for that provider (e.g. `embed.maps`, `embed.chat`). The provider component must appear in `dependencies`, hash-pinned |
| `x-<vendor>[.<name>]` | Vendor extension. Hosts that do not recognise it treat it as unavailable |

## Rules

1. **Requires vs optional.** A host that cannot grant a `requires` capability refuses to run the app
   and shows why. Missing `optional` capabilities must degrade gracefully.
2. **Dependencies are bounded.** A dependency may use only the capabilities in its own
   `capabilities` list, and that list must be a subset of the app's.
3. **Financial and destructive actions.** Any `actions[]` entry with `effect: financial` or
   `effect: destructive` is forced to `requires_human_confirmation: true`. Agents cannot override.
4. **Sensitive fields.** `Input.sensitive: true` fields are excluded from `analytics.event`,
   crash reports, and any session-replay projection.
5. **Revocation.** Revoking a capability takes effect immediately; in-flight calls fail with
   `capability_revoked`.
6. **Unknown names.** A host rejects a manifest containing a capability string matching none of
   the catalog, `embed.*`, or `x-*` forms (enforced by the schema).

## Open questions

- Granularity of `location` (separate `location.coarse`).
- Whether `storage.sync` belongs in core or as a host-provided component.
- A host-drawn card or wallet sheet and the token it would produce (see `payments.md`, which specifies hosted checkout only).

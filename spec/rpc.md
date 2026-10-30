# Lattice RPC (draft 0.1)

How an app's component talks to its origin's server. The component sees one function,
`rpc.call(method, request-bytes) -> response-bytes` (see `wit/capabilities.wit`); the host does the rest.

## Contract

The manifest's `api.schema` is the hash of an **API description** (`api.schema.json`): per method, a JSON
Schema for the request, a JSON Schema for the response, an `effect` class, and the application error codes
the method may return. The description is fetched from `/.lattice/blob/{hash}` and verified like any other blob.

The contract is enforced at both ends, by both parties:

| Where | Check | On failure |
|---|---|---|
| Host, before sending | request matches the method's schema | `host.invalid-argument`; nothing is sent |
| Server, on receipt | request matches the method's schema | `400 invalid_request` |
| Server, before replying | its own response matches the schema | `500 internal` (a server bug) |
| Host, on receipt | response matches the schema | `transport("response violates the API description")`; the app never sees it |

## Wire protocol

```
POST {api.url}/{method}
Content-Type: application/vnd.lattice.rpc+cbor
Accept:       application/vnd.lattice.rpc+cbor
Lattice-Api:  sha256-...          hash of the API description the client is using
Lattice-Request-Id: <uuid>        client-generated; for tracing and idempotency
Lattice-Session: <opaque>         only when the manifest requests the `session` capability

<CBOR request body>
```

- `api.url` must be on the app's own origin in v0.1 (`net.origin`). Cross-origin API endpoints are not yet specified.
- `{method}` matches `^[a-z][a-z0-9_]*$` and exists in the API description.
- Bodies are limited to 1 MiB. Hosts apply a 10 s timeout.
- The session token is host-held and bound to the origin. The app can neither read nor set it.
- `Lattice-Api`: if the server does not recognise the hash it replies `412 api_mismatch` so the client can reload.

### Success

`200`, `Content-Type: application/vnd.lattice.rpc+cbor`, body is the CBOR response.

A `200` response may also carry `Lattice-Set-Session` or `Lattice-Clear-Session` to change the host's session
(sign-in, sign-out; see `auth.md`). The host consumes these headers; they are never visible to the app.

### Errors

Any status of 400 or above, `Content-Type: application/vnd.lattice.rpc-error+cbor`, body:

```
{ "code": "task_not_found", "message": "No such task.", "details": { ... } }   // details optional
```

Standard codes (valid for every method, no declaration needed):

| code | status | meaning |
|---|---|---|
| `invalid_request` | 400 | request does not match the schema |
| `unauthorized` | 401 | no valid session; the app may start sign-in |
| `forbidden` | 403 | signed in but not allowed |
| `not_found` | 404 | unknown method or resource |
| `api_mismatch` | 412 | client's API description is not known to the server |
| `rate_limited` | 429 | back off |
| `internal` | 500 | server fault |

Application codes are declared per method and use status `409` or `422`. A code that is neither standard nor
declared for that method is treated as a protocol violation (`transport`), not passed to the app.

### What the app receives

| Situation | `rpc-error` |
|---|---|
| Server returned a declared or standard error | `application { code, message, details }` |
| Request rejected locally, unknown method, bad CBOR | `host(invalid-argument)` |
| Capability not granted | the import is not linked at all, so the component fails to instantiate |
| Timeout, connection failure, oversize or malformed response, schema or protocol violation | `transport(message)` |

## Not specified yet

- Streaming and server push (`rpc.subscribe`, WebTransport).
- Cross-origin API endpoints and their capability.
- Byte strings and non-string keys in bodies (the validated data model is JSON).
- Compression, request batching, and pagination conventions.

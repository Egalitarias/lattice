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

## Topics (server push)

An API description may declare `topics`. Each is a named stream of messages from the server, every message matching
the topic's `message` schema. The app calls `rpc.subscribe(topic)` (capability `net.realtime`) and receives
`host-event.stream-message { topic, payload }` through `on-event`; `rpc.unsubscribe(topic)` stops it.

Two transports carry the same frames; a host uses WebTransport when the manifest offers it and falls back to
streaming HTTPS when it cannot connect (blocked UDP, no QUIC, a failed handshake), retrying WebTransport after a minute.

**Wire, streaming HTTPS:** `GET {api.url}/_topics/{topic}` with the same `Lattice-Api` and `Lattice-Session`
headers as a call. A `200` has `Content-Type: application/x-ndjson`; the body is one JSON object per line,
`{"seq": <integer>, "payload": <message>}`, with an empty line as a heartbeat (about every 15 s). Errors before the
stream starts use the RPC error body. Only the JSON data model is carried, as for calls.

**Wire, WebTransport (`api.stream`):** the manifest's `api.stream` is an `https://` URL on the app's own domain.
The client opens one WebTransport session (HTTP/3 over QUIC) and one bidirectional stream per subscription. It
writes a single line `{"topic": "...", "api": "<description hash>", "session": "<token>"}` (at most 4 KiB, and the
session token travels in the encrypted stream rather than a URL), and keeps its side of the stream open: closing it
ends the subscription. The server replies on the same stream with the frames above, or, if it refuses, with one line
`{"error": {"code": "...", "message": "..."}}` (the RPC error codes) and closes. Codes other than `rate_limited` and
`internal` are final; the client does not retry them. One session multiplexes every topic, so a slow topic cannot
stall another, and a server may cap streams per session (the prototype allows 32) and sessions in total.

The certificate must chain to a trusted root. For development only, a host on a loopback origin honours
`api.stream_cert_hash`, the SHA-256 of a self-signed certificate valid for at most 14 days (the limit browsers
enforce for pinned certificates); every other host ignores it. A pinned connection whose certificate does not match
fails, and the host falls back to HTTPS.

**Host duties.** The host refuses topics the description does not declare, allows at most 8 subscriptions per app,
validates each message (dropping and counting any that fail), caps a line at 1 MiB, re-connects with exponential
back-off (1 s to 30 s) and does not retry after a `4xx` other than `408`/`429`. It delivers messages to the app one
at a time, in order, and when the app falls behind drops the oldest beyond 64 queued: push is for state, not for
commands. After a reconnect the server sends whatever snapshot it chooses first, so a message may be repeated and
the app must treat messages as state, not as events to be counted.

**Server duties.** Authorise by session before the stream starts (an `ApiError` becomes the error response),
validate every published message against the schema, and drop a subscriber that cannot keep up (more than 256 KiB
queued). A message goes only to subscribers allowed to see it.

## Not specified yet

- WebTransport datagrams (unreliable, unordered updates for fast-moving state), resumable streams, per-topic
  parameters, and sending from the client over a stream (calls remain RPC).
- Cross-origin API endpoints and their capability.
- Byte strings and non-string keys in bodies (the validated data model is JSON).
- Compression, request batching, and pagination conventions.

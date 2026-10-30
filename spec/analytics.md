# Lattice analytics and error reporting (draft 0.1)

Businesses need to know what their app does in the field. The web's answer is a third-party script that runs inside the
page with access to everything on it. Lattice has no third-party scripts, so it gives analytics four properties instead:

1. **The host is the only sender.** The app records events; Navigator decides whether, what, and to whom anything leaves the
   device. An app cannot choose a destination, add one at runtime, or learn whether an event was sent.
2. **Everything that can be sent is declared.** The manifest lists the processors that may receive events and the exact
   catalog of events and typed properties the app may emit. Anything else is dropped before it is queued.
3. **The user sets the level.** Four levels, a default that sends no product analytics, and a window onto exactly what
   was sent.
4. **No identifiers by default.** Events carry no session token, user id or persistent id unless the user chose the top level.

## Levels

The level is a per-profile setting the user changes in Navigator's own chrome. It is not an app setting and the app cannot read it.

| Level | Sends | Identifier | Timestamps |
|---|---|---|---|
| `off` | nothing | none | |
| `errors` (**default**) | error reports | none | rounded to the minute |
| `anonymous` | errors, host timings, product events | none | rounded to the minute |
| `full` | the same | a random per-origin `client` id the user can reset | exact seconds |

Levels are cumulative. Lowering the level immediately discards queued events that the new level would not send.

## Declaring what can be sent

```json
"analytics": {
  "processors": [
    { "name": "First party", "endpoint": "https://shop.example.com/events", "purposes": ["product", "performance", "errors"] },
    { "name": "Error tracker", "endpoint": "https://errors.example-tracker.com/ingest", "purposes": ["errors"] }
  ],
  "events": [
    { "name": "task_added",  "description": "A task was added", "props": { "tasks": { "type": "integer" } } },
    { "name": "signed_in",   "props": { "method": { "type": "string", "enum": ["passkey", "oidc"] } } }
  ]
}
```

- A **processor** receives only events whose kind matches one of its `purposes`: `product` (events the app emits),
  `performance` (timings the host measures), `errors` (failures). A kind with no processor is never sent anywhere.
- A processor on another origin is allowed and is shown to the user by name and host. It receives events exactly as a
  first-party one does, and never receives the session token.
- The **catalog** is the whole vocabulary of `analytics.emit`. Property types are `string`, `integer`, `number` and
  `boolean`; strings are at most 64 characters unless the declaration allows up to 200, and prefer an `enum`.
  Property values must not be personal data. The catalog exists so that an auditor, and the user, can read what an app may
  say.

## What the host does with an event

For `analytics.emit(name, props)`, in order, and dropping the event whole at the first failure:

1. the name is in the catalog and a processor is declared for `product`
2. every property is declared, has the declared type, and fits its limits (at most 20 properties)
3. the user's level is `anonymous` or `full`
4. the event is within the rate limit (60 product events a minute; excess is dropped, not queued)
5. string values are redacted (below), and the event joins a bounded queue (500 events; the oldest is dropped first)

A dropped event is counted and shown to the user and to a developer running Navigator with diagnostics on. It is never
reported to the app, so analytics code cannot change app behaviour.

## What the host measures itself

These need no `analytics.event` capability and no catalog entry, but still need a processor declared for the purpose:

| Kind | Name | Properties |
|---|---|---|
| performance | `host.route` | `handler` (the manifest route handler name, never the raw path), `ms` |
| performance | `host.action` | `action` (the action name), `ms` |
| error | `app.internal` | `detail` (scrubbed) |
| error | `app.reported` | `name`, `detail` (scrubbed), from `analytics.report-error` |
| error | `host.crash` | `detail` (the component stopped responding or crashed, and was restarted) |
| error | `host.invalid_scene` | `detail` (the app returned a scene or update the host rejected) |

`ms` is rounded to 10 ms. Paths, query strings, form values and the contents of the scene are never included.
Performance events are limited to 30 a minute and error events to 20 a minute, so a failure loop cannot flood a processor.

## Redaction

Navigator remembers, for ten minutes and only in memory, the values the user submitted into any input marked
`sensitive` in the scene (at most 20, four characters or longer). Any string headed for a processor that contains one
of them is replaced by `[redacted]`. This catches an app that copies a sensitive field into an event or an error message;
it cannot catch data the app has transformed.

Error `detail` text is also scrubbed regardless of source: email addresses become `[email]`, runs of nine or more digits
(possibly separated by spaces or dashes) become `[number]`, and tokens of 32 or more URL-safe characters become `[token]`.
It is then cut to 200 characters.

## Delivery

Batches of up to 20 events are sent every five seconds. Each batch is a `POST` to the processor's endpoint:

```
Content-Type: application/vnd.lattice.events+json

{ "v": 1,
  "app":   { "domain": "shop.example.com", "version": "1.4.2", "build": "sha256-..." },
  "level": "anonymous",
  "client": "c_...",                       // only at level "full"
  "sent_at": 1730000040,
  "events": [ { "kind": "product", "name": "task_added", "t": 1730000040, "props": { "tasks": 3 } } ] }
```

- No cookies, no credentials and no `Lattice-Session` header are sent, to first- or third-party endpoints.
- Redirects are refused. The body is at most 64 KiB. A processor that fails or does not answer within five seconds gets
  the batch retried after 1, 4 and 16 seconds and then dropped; a slow or broken processor never affects the app.
- The endpoint's IP address necessarily sees the user's IP address. Lattice cannot hide that; a processor that must not
  have it should be reached through the origin's own server.

## What the user sees

Navigator's chrome has a Privacy control for the app on screen: the level selector; each processor with its name, host and
purposes; counts of what was sent, dropped, or held back by the level; and the last events actually sent with their
properties. At `full`, a button resets the client id.

## Not specified yet

- Experiments and A/B assignment (`experiments`), and the exposure events they would imply
- Session replay or heatmaps (the scene tree makes a privacy-preserving version possible; none is specified)
- Consent flows tied to `consent`, and per-purpose levels
- Server-side retention and deletion of what processors received
- Sampling, and an event schema for non-scalar values

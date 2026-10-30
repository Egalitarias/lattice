# Lattice component interface (WIT)

Package `lattice:app@0.1.0`. This is the contract between an app component and Lattice Navigator.

| File | Contents |
|---|---|
| [`types.wit`](types.wit) | `scalar`, `args`, `host-error`, `app-error` |
| [`scene.wit`](scene.wit) | The scene tree as a typed arena, plus `update` patches |
| [`capabilities.wit`](capabilities.wit) | Host-provided interfaces (`rpc`, `storage`, `payments`, ...) |
| [`app.wit`](app.wit) | `lifecycle` (what the app exports), `world app`, and the `embed` world |

## Model

The app owns its state; the host owns the display. The host calls in, the app answers.

```
Navigator                                    App component
 │  init(launch)                  ───────────►  set up
 │  route({handler, path, params}) ──────────►  returns a whole `scene`
 │  user presses a Button
 │  dispatch({action, args, values}) ────────►  returns `update` (patch ops + focus)
 │  stream push / offline / revoked
 │  on-event(host-event)          ───────────►  returns `update`
 │                                  ◄────────── app calls imports: rpc.call, payments.request, ...
```

- Calls into the app are serialised. A call may issue host imports, which may take a long time
  (a payment sheet); the host does not deliver another call until the first returns.
- Every user-visible change is a `scene` or an `update`. There is no escape hatch to the display.
- An agent invokes a manifest `actions[]` entry through the same `dispatch` export, with
  `source = none`. The app cannot tell, and need not care, whether a person or an agent called.

## Capabilities are imports

A capability in the manifest corresponds to a WIT import. Lattice Navigator links only the imports the manifest
requested and the user allowed, so a component that imports `payments` without
`payments.request` fails to instantiate, and an app cannot call what it was not granted.

| Capability | WIT import |
|---|---|
| `net.origin`, `net.realtime` | `rpc` |
| `storage.local`, `storage.sync` | `storage` |
| `session` | `session` |
| `auth.oidc`, `auth.passkey` | `auth` |
| `payments.request`, `payments.mandate` | `payments` |
| `analytics.event` | `analytics` |
| `notifications` | `notifications` |
| `consent` | `consent` |
| `navigate.external` | `navigation.open-external` |
| `ads.slot`, `gpu.surface`, `embed.*` | no import; enforced on the scene (`ad-slot`, `canvas.surface`, `embed` nodes) |
| `experiments`, `share`, `files.pick`, `contacts.pick`, `identity.age_over`, `camera`, `microphone`, `location` | not yet specified (see below) |

Revocation: when a user revokes a capability, the host sends `host-event.capability-revoked` and
subsequent calls return `host-error.capability-revoked`.

## Relationship to `scene.schema.json`

Two encodings of one model:

| | JSON Schema | WIT |
|---|---|---|
| Used for | Authoring, fixtures, servers that send a scene over HTTPS | In-process app <-> host |
| Tree shape | Nested | Flat arena with `node-id` references (WIT has no recursive types) |
| Required labels | `required` + `if/then` | Required fields in the body record |
| `List` node | `List` | `item-list` (`list` is reserved in WIT) |

`npm run validate` checks that both define the same 20 node types. A future conformance suite
will round-trip scenes between the two forms.

## Interaction rules

- A `button` inside a `form` dispatches its own `on-press` action with the values of every named
  field in that form (`action-call.values`). Pressing Enter in a text field dispatches the form's `on-submit`.
- A control's `on-change` receives only that control's value, keyed by its `name`.
- The UI layer never sends action names or arguments. It reports "node N, event E, values V"; the host looks up the
  action reference it received from the app and rejects values for fields outside the node's form.
- Re-sending a node with `set-node` re-asserts its props, including an input's `value` (this is how an app clears a
  field). Nodes the app does not touch keep their user-edited state.

## Scene rules the host enforces

Violations reject the call with `app-error.invalid`:

- Each `node-id` appears at most once; nodes reachable from `root` form a tree; no dangling ids.
- Leaf bodies have no children.
- `image.alt` is non-empty unless `decorative` is true.
- `heading.level` is 1-6; `table` rows have exactly one cell per column.
- Every `action-ref.action` names an action the component handles. Unknown names are an error
  at dispatch time, never code.
- `ad-slot`, `embed` and `canvas.surface` use only capabilities the manifest requested.

## Not specified yet

- Async. WIT 0.2 functions are synchronous, so a host call such as `rpc.call` blocks the app's turn. Lattice Navigator runs each
  component on its own thread and blocks it on a shared buffer while the main thread does the I/O, so the host
  stays responsive and a hung component can be killed. Move to WASI 0.3 native async when stable; the interfaces
  are written so that change is mechanical.
- `gpu.surface`: the `canvas` node carries a surface name, but the drawing API (likely wasi-gfx) is open.
- `share`, `files.pick`, `contacts.pick`, `identity.age_over`, `camera`, `microphone`, `location`, `experiments`.
- State snapshot and restore across suspend.
- A size limit on `scene` and `update` per call, and a rate limit on updates.

## Working with it

```
cd spec
npm install
npm run validate        # schemas, fixtures, WIT/schema agreement, and WIT parse of both worlds
```

`npm run wit` generates TypeScript declarations into `spec/.wit-out/` (git-ignored). Rust bindings
come from `wit-bindgen` against this directory.

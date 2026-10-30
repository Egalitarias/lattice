# Lattice experiments (draft 0.1)

A/B testing on the web is done by a third-party script that fingerprints the visitor to keep them in one arm. Lattice
gives it the same four properties as analytics (`analytics.md`):

1. **The host assigns.** The manifest declares experiments; the host picks the variant, not the app and not a server.
2. **No identifier.** Assignment is a weighted draw from the system's secure random source, made once and stored in the
   user's profile for that app. It uses no account, session token or analytics id, so it cannot be linked across apps.
3. **The user can leave.** The host's own chrome has an *Experiments* panel that lists each experiment and the
   user's variant, and lets them stop taking part. A user who has opted out is in the first listed variant (the
   **control**) of every experiment and no exposure is recorded. Their earlier assignments are kept for if they return.
4. **The app learns only its own variant.** It cannot enumerate other users' arms, change its own, or learn whether the
   user opted out (the control is also what a user who never opted out may get).

## Declaring

```json
"capabilities": { "requires": ["experiments", "..."] },
"experiments": [
  { "name": "upgrade_pitch",
    "description": "Whether a one-line pitch is shown above the Upgrade button.",
    "variants": [ { "name": "control", "weight": 50 }, { "name": "benefit", "weight": 50 } ] }
]
```

At most 10 experiments of 2 to 6 variants each; weights are integers from 1 to 100 and need not sum to anything. The
first variant is the control. Names and descriptions are shown to the user.

## Using

`experiments.lookup(name)` returns the user's variant (`invalid-argument` for an experiment the manifest does not
declare). Looking it up is cheap and may be repeated. If the manifest later removes a variant the user was in, the
host draws again.

## Exposure

The first lookup of each experiment in a run is an *exposure*. The host records it itself as a product event
`host.experiment { experiment, variant }`; the app does not emit it and it needs no catalog entry. Like any product
event it is sent only to processors declared for `product`, only at the `anonymous` or `full` level, rate-limited and
redacted (`analytics.md`). At `anonymous` that gives aggregate exposure counts per variant; joining exposure to later
conversion needs the `full` level's client id, or the app can put the variant in its own declared events (it knows it).
Nothing is sent at `errors` or `off`, though the assignment is still made, locally, so the app behaves consistently.

## What this does not do

No targeting (by country, account or behaviour), no holdouts across apps, no server-side assignment, no mutual
exclusion between experiments, and no statistics. A returning user on a new device or profile is a new draw.

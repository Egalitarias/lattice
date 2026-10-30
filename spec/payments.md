# Lattice payments (draft 0.1)

Two rules that the web does not enforce:

1. **The app never handles payment details and never states the price.** It names an order. The host learns what
   the order is, and what the user will be charged, directly from the app's own server, and draws the payment
   sheet itself.
2. **A browser redirect proves nothing.** The user arriving back from a payment page tells the host and the app
   that the user *finished*, not that they *paid*. Only the origin's server, acting on a verified message from the
   payment processor, decides that.

This version specifies two handlers: **hosted checkout** (`stripe`; the processor draws the card form on its own domain)
and a **card sheet** (`stripe-card`; the host draws the form, see "Card sheet" below). A wallet sheet (Apple Pay,
Google Pay, the browser's Payment Request API) is not yet specified.

## Parties

| Party | Does |
|---|---|
| **App component** | Creates an order with its own server (RPC), then calls `payments.request(order-ref)` |
| **Host (Navigator)** | Gets the order summary and checkout URL from the server, shows the user a sheet, opens the processor's page, waits for the user to come back |
| **Origin server** | Owns orders and the processor secret key; creates the processor session; fulfils on verified webhooks |
| **Processor** (e.g. Stripe) | Takes the payment on its own domain; tells the server what happened, signed |

## Manifest

```json
"capabilities": { "requires": ["payments.request", "..."] },
"payments": {
  "handlers": ["stripe"],
  "merchant": { "domain": "shop.example.com" },
  "server": "https://shop.example.com/pay"
}
```

`payments.server` must be on the app's origin. `handlers` names the processors the app may use; the host has a fixed
registry of what each is allowed to be (below).

## Flow

```
App ── rpc: create_order(...) ──► Server            builds the order itself, from its own prices; returns order-ref
App ── payments.request(order-ref) ──► Host
Host: 1. POST {payments.server}/sessions  { order_ref, return_url, cancel_url }   (with the session; see below)
Server: 2. the order must belong to the signed-in user and be unpaid
        3. create the processor session for the order's real amount; reply with the checkout URL and a summary
Host: 4. validate the reply (below); draw the sheet from the summary:  "Pay $4.00 to <app> (<domain>)?"  [Continue] [Cancel]
      5. on Continue, open the checkout URL in a new window (noopener)
User ◄──► Processor (enters card details on the processor's domain; the app and the host never see them)
Processor ──► redirect to return_url or cancel_url, bound to this request by `state`
Host: 6. return -> resolve payments.request with a receipt;  cancel -> host-error.cancelled
Processor ──► Server: signed webhook (independent of the redirect, and possibly before or after it)
Server: 7. verify the signature, find the order, check amount and currency, mark it paid, fulfil
App ── rpc: order_status(order-ref) ──► Server      the app asks the server whether it was paid
```

A receipt means **the user came back**. It is not evidence of payment. An app must ask its server, which may answer
"pending" for a short while if the webhook has not arrived yet.

### `POST {payments.server}/sessions` (host to server)

`Content-Type: application/json` and the current `Lattice-Session`. Body:

```
{ "order_ref": "ord_...", "return_url": "http://.../_navigator/payment/return?state=...",
  "cancel_url": "http://.../_navigator/payment/cancel?state=..." }
```

The server must refuse unless: the session belongs to a signed-in user (`401`), the order belongs to that user
(`404`, not `403`, so order refs cannot be probed), the order is not already paid (`409 already_paid`), and both URLs are on
the app's own origin at `/_navigator/payment/return` and `/_navigator/payment/cancel`.

Success, `200`:

```
{ "handler": "stripe", "url": "https://checkout.stripe.com/c/pay/...", "reference": "cs_test_...",
  "summary": { "currency": "USD", "total_minor": 400,
               "items": [ { "label": "Lattice Tasks Pro", "amount_minor": 400, "quantity": 1 } ] } }
```

Failure is a non-`200` with JSON `{ "code", "message" }`; the host shows the app a `host-error.invalid-argument(message)`.

### What the host checks in that reply

The reply comes from the app's server, so it is the app's claim, but it is the *server's* claim over TLS to the
domain, not the component's. The host still insists on all of:

- `handler` is in the manifest's `payments.handlers`, and is one the host knows
- `url` is `https` on a host the handler is allowed to use (`stripe` -> `checkout.stripe.com`; in development only,
  `http` on loopback). It is never a URL the component supplied
- `summary.currency` is three upper-case letters; every `amount_minor` is a non-negative integer; `quantity` is
  1 to 1000; there are at most 50 items with labels of at most 100 characters; and `total_minor` **equals the sum of
  `amount_minor * quantity`**. A total that disagrees with its own lines is rejected
- the reply is under 64 KiB

The sheet is drawn only from the validated summary. Nothing the component said appears in it, except that it chose
which order to ask about.

### `state`

Like OIDC's `state`: 256 random bits per request, single use, expiring after 10 minutes, and the only thing that binds a
return to a pending request. A forged, repeated or replayed return is refused without disturbing any pending request,
as is a request that repeats a parameter.

## Card sheet (`stripe-card`)

The user stays in Navigator's own dialog. The host draws the card form, sends the card straight to the processor to be
turned into a token, and asks the app's server to charge the order with that token. The app component never sees the
card, a token, or any of this.

```
Host ── POST {payments.server}/sessions  { order_ref, return_url, cancel_url, "methods": ["card_sheet"] } ──► Server
Server: as before, then creates a PaymentIntent for the order's real amount (metadata.order_id = the order)
        reply:  { "handler": "stripe-card", "reference": "pi_...", "publishable_key": "pk_...", "api": "https://api.stripe.com",
                  "summary": { ... } }
Host: validates (below), draws "Pay $4.00 to <app>?" and a card form (number, expiry, security code)
User submits ──► Host checks the form locally (length, Luhn, expiry), then
Host ── POST {api}/v1/payment_methods  (Bearer publishable key; the card) ──────────────────────────► Processor ──► pm_...
Host ── POST {payments.server}/confirm  { order_ref, reference, payment_method } ──────────────────► Server
Server: owner and intent must match the order (404 otherwise); confirms the intent with its secret key
        reply: 200 { "status": "succeeded" | "processing" | "requires_action" }   or   402 { code, message } for a declined card
Processor ──► Server: signed webhook  payment_intent.succeeded   (the only thing that marks the order paid)
```

The host sends `methods: ["card_sheet"]` only if the manifest lists `stripe-card` under `payments.handlers` **and** declares
`payments.merchant.stripe_publishable_key`. A server that does not offer the sheet ignores `methods` and answers with a
hosted checkout, which the host handles as before.

### What the host checks in the reply

- `publishable_key` **equals the key in the manifest**. The server cannot send the user's card to another merchant's account.
- `api` is the processor's address and nothing else (no path, query or credentials): `https://api.stripe.com`, or in
  development only, `http` on loopback.
- `reference` looks like a PaymentIntent id (`pi_...`), and the summary passes the same checks as for hosted checkout.

### Where the card goes

Typed into the host's dialog, held in memory for one request, sent over TLS to the processor's tokenising endpoint, and
discarded. It is not given to the component, the app's server, analytics (the host remembers the number and code for
ten minutes to redact them from any error text), or logs, and the dialog is emptied when it closes. In the Node
Navigator it crosses the local loopback connection between the Navigator's window and the Navigator process, which is
protected like every other request there (a custom header and an `Origin` check). Messages from the processor that are
shown to the user are shortened and have long digit runs replaced.

Up to five attempts are allowed per sheet; a declined card keeps the sheet open for another card.

### 3-D Secure in the sheet

The bank's page opens in its own window, as hosted checkout does, so no processor script runs in the host and no client
secret reaches it.

```
Host ── POST {payments.server}/confirm  { order_ref, reference, payment_method, return_url } ──────► Server
Server: checks return_url as /sessions does; confirms the intent with payment_method and return_url
        reply: 200 { "status": "requires_action", "action_url": "<next_action.redirect_to_url.url>" }
Host: validates action_url; stops taking cards; the sheet says "Your bank needs to verify this payment"  [Continue to your bank] [Cancel]
User clicks ──► Host opens action_url in a new window (noopener)
User ◄──► Bank
Processor ──► redirect to return_url?state=...&payment_intent=pi_...&redirect_status=...
Host: state and payment_intent must match the waiting sheet, then
      redirect_status=failed -> back to the form with an explanation, for another card;  otherwise resolve payments.request
Processor ──► Server: signed webhook  payment_intent.succeeded   (still the only thing that marks the order paid)
```

- **The second click is deliberate.** Browsers block a window opened after waiting on the network, so it must come from a click.
- **`action_url`** comes from the app's server, so it is checked like a checkout URL: `https` on a host in the handler's
  registry entry (`stripe-card` -> `hooks.stripe.com`, to be confirmed against Stripe's test mode), or in development only,
  `http` on loopback; no credentials; at most 2048 characters. A `requires_action` reply with no usable `action_url`
  (another `next_action` type) ends the payment with today's explanation.
- **`state` is new for each confirm**, so a stale "failed" link cannot disturb a later attempt on the same sheet. Repeated
  `state`, `payment_intent` or `redirect_status` parameters are refused. A failed verification counts towards the five attempts.
- **`redirect_status` only decides what to show.** As with every return, the receipt means the user came back, not that they paid.
- **Cancelling is not proof of non-payment.** The user can cancel while the bank is still finishing, so the app may see
  `cancelled` for an order that a later webhook marks paid. Apps must ask their server, as they already must. A retry after
  a failed verification confirms the same intent, so it cannot charge twice. Buying again after cancelling makes a new intent,
  so if the bank then completes the old one the order is paid twice; that is detected and logged, not refunded, as with
  two checkout sessions.
- **The sheet's fields are emptied** as soon as verification starts; another card is typed afresh.
- **The stand-in** gains `return_url` on confirm, `next_action.redirect_to_url`, and a page with "complete" and "fail" buttons
  that sends the webhook and redirects, so the existing test card (`4000 0025 0000 3155`) exercises the whole flow.

The return lands where any other payment return does, so the prototype's `.localhost` constraint and the "Honest limits"
below still apply. An iframe in the dialog was rejected: many banks refuse to be framed, and the user could not check
the page's address.

### Server duties

On `/confirm`: require a signed-in user (`401`), the order owned by that user and unpaid (`404` / `409`), and an intent
that the server itself created for **that order** (`404` otherwise). Confirm with the secret key. Treat the `status` in the
reply as a hint only. On the webhook `payment_intent.succeeded`: verify the signature, find the order through the intent's
metadata, require that the intent is one the server made for the order, that `amount` and `amount_received` equal the
order's total and the currency matches, and that the status is `succeeded`; then fulfil once. `payment_intent.payment_failed`
never undoes a payment.

### Honest limits

Handling raw card numbers in a client is something most processors restrict: Stripe, for example, requires approval before
an account may send card numbers to its API directly, and prefers Elements or the Payment Request API for that reason. This
handler is a working design against a stand-in that mirrors the documented shapes; it has not been run against a live
processor. Using it in production means the *host* (Navigator) is in scope for the processor's card-data rules, which is
a decision for whoever ships a Navigator, not for an app.

## Webhooks and fulfilment (server)

The processor calls the server directly. The server must:

1. **Verify the signature** over the *raw* request body, with a timestamp tolerance (Stripe: `Stripe-Signature`, five
   minutes). Anything else is refused with `400` and has no effect.
2. Treat only events it understands, and ignore (acknowledge with `200`) the rest, since a non-`2xx` makes the
   processor retry.
3. Find the order by the reference it stored when it created the session, and check that the **processor session
   matches the order's**, and that **amount and currency equal the order's**. A mismatch is logged and does not
   fulfil.
4. Require the processor's own "paid" state. A completed checkout whose payment is not yet paid (asynchronous
   methods) waits for the later success event.
5. Be **idempotent**: processors deliver more than once. A repeated event does nothing a second time. `paid` is terminal;
   a later `expired` or `failed` event does not undo it.
6. Fulfil exactly once, for the order's owner, **only from this path**.

## Idempotency of session creation

Creating the processor session carries an idempotency key derived from the order, so a retried `sessions` call
returns the same checkout rather than a second one.

## Handler registry

| Handler | Checkout host | Webhook |
|---|---|---|
| `stripe` | `checkout.stripe.com` | `Stripe-Signature` (HMAC-SHA256, `t=` timestamp, `v1=` signature) |
| `stripe-card` | none: the host draws the form and the card goes to `api.stripe.com` | as above |

## Prototype constraint: where the return lands

The server accepts return and cancel addresses only on the app's own domain (the second check on `return_url` above). The
prototype Navigator serves its page at `http://<app domain>:<port>` only when the domain ends in `.localhost`
(the same constraint as passkeys, `auth.md`), so in this prototype payments work for `.localhost` apps. A native
Navigator would claim the app's domain and has no such limit.

## Not specified yet

- A wallet sheet, and the tokens it would produce (`payments.request` does not return one)
- Recurring payments and mandates (`payments.mandate`)
- Refunds, disputes, and receipts shown by the host
- Currency display rules beyond the ISO code; tax and shipping (the server includes them in the order)

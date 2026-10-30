# Lattice payments (draft 0.1)

Two rules that the web does not enforce:

1. **The app never handles payment details and never states the price.** It names an order. The host learns what
   the order is, and what the user will be charged, directly from the app's own server, and draws the payment
   sheet itself.
2. **A browser redirect proves nothing.** The user arriving back from a payment page tells the host and the app
   that the user *finished*, not that they *paid*. Only the origin's server, acting on a verified message from the
   payment processor, decides that.

This version specifies the **hosted checkout** handler (the processor draws the card form on its own domain). A
host-drawn card or wallet sheet is a separate handler, not yet specified.

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

## Prototype constraint: where the return lands

The server accepts return and cancel addresses only on the app's own domain (the second check on `return_url` above). The
prototype Navigator serves its page at `http://<app domain>:<port>` only when the domain ends in `.localhost`
(the same constraint as passkeys, `auth.md`), so in this prototype payments work for `.localhost` apps. A native
Navigator would claim the app's domain and has no such limit.

## Not specified yet

- A host-drawn sheet with cards or wallets, and the tokens it would produce (`payments.request` does not return one)
- Recurring payments and mandates (`payments.mandate`)
- Refunds, disputes, and receipts shown by the host
- Currency display rules beyond the ISO code; tax and shipping (the server includes them in the order)

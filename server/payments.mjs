// Server side of Lattice payments (spec/payments.md), using Stripe Checkout.
//
// createPayments() gives an origin:
//   - orders it creates itself, from its own prices (never from the client)
//   - sessionsEndpoint: the host calls this to get a checkout URL (or, for a host-drawn card sheet, a PaymentIntent) and the order summary
//   - confirmEndpoint:  the host calls this with a tokenised card (card sheet only); the server confirms the intent
//   - webhookEndpoint:  Stripe calls this; the ONLY place an order becomes paid
//   - onPaid(fn):       fulfilment hook, called once per order
//
// Orders are in memory. A real origin would persist them.

import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { ApiError } from "./rpc.mjs";

const RETURN_PATH = "/_navigator/payment/return";
const CANCEL_PATH = "/_navigator/payment/cancel";
const MAX_JSON = 16 * 1024;
const MAX_WEBHOOK = 256 * 1024;
const SEEN_EVENTS = 5000;
const MAX_OPEN_ORDERS = 20; // unpaid orders one account may hold, so orders cannot be used to fill memory

export function createPayments({
  originAllowed, // (origin) => boolean: where the host's UI may be reached
  secretKey,
  webhookSecret,
  publishableKey, // offer the host-drawn card sheet (needs processorApi too); the manifest must declare the same key
  processorApi, // base URL of the processor's API that the host may call with the publishable key, e.g. https://api.stripe.com
  api, // optional { host, port, protocol } to point the Stripe client at a stand-in (development)
  identify, // (sessionToken) => { subject } | null
  now = () => Date.now(),
  log = console.error,
}) {
  const stripe = new Stripe(secretKey, { ...(api ?? {}), maxNetworkRetries: 0, timeout: 10_000 });
  const orders = new Map(); // id -> order
  const seenEvents = new Set();
  const paidHooks = [];

  // ---- Orders ---------------------------------------------------------------------------------

  /** Create an order from the server's own line items. Amounts are integer minor units. */
  function createOrder({ owner, currency, items }) {
    if (!owner) throw new ApiError("unauthorized", "Sign in to buy.");
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency must be an ISO 4217 code");
    let open = 0;
    for (const o of orders.values()) if (o.owner === owner && o.status !== "paid") open++;
    if (open >= MAX_OPEN_ORDERS) throw new ApiError("rate_limited", "Too many unpaid orders. Finish or wait for an existing one first.");
    if (!items.length || items.length > 50) throw new Error("bad item count");
    let total = 0;
    for (const i of items) {
      if (!Number.isInteger(i.amount_minor) || i.amount_minor < 0 || !Number.isInteger(i.quantity) || i.quantity < 1) throw new Error("bad line item");
      total += i.amount_minor * i.quantity;
    }
    const order = {
      id: "ord_" + randomBytes(12).toString("base64url"),
      owner, currency, items: items.map((i) => ({ ...i })), total_minor: total,
      status: "created", // created -> pending (session made) -> paid | failed | expired
      sessionIds: [], intentIds: [], paidSessionId: null, attempts: 0, createdAt: now(), paidAt: null,
    };
    orders.set(order.id, order);
    return order;
  }

  /** An order, only for its owner. Anyone else gets "not found", so references cannot be probed. */
  const getOwned = (id, owner) => {
    const o = typeof id === "string" ? orders.get(id) : undefined;
    return o && owner && o.owner === owner ? o : null;
  };

  // ---- Host-facing: create a checkout session -------------------------------------------------

  function reply(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
    res.end(text);
  }
  const refuse = (res, status, code, message) => reply(res, status, { code, message });

  async function readBody(req, max) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) return null;
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  /** The host's own URLs: on the app's origin, at the fixed paths, carrying only `state`. */
  function hostUrlOk(value, path) {
    let u;
    try { u = new URL(value); } catch { return false; }
    if (u.pathname !== path || !originAllowed(u.origin) || u.hash) return false;
    const keys = [...u.searchParams.keys()];
    return keys.length === 1 && keys[0] === "state" && /^[A-Za-z0-9_-]{16,128}$/.test(u.searchParams.get("state"));
  }

  async function sessionsEndpoint(req, res) {
    try {
      if (req.method !== "POST") return refuse(res, 405, "invalid_request", "POST only");
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return refuse(res, 415, "invalid_request", "expected application/json");
      const raw = await readBody(req, MAX_JSON);
      if (!raw) return refuse(res, 413, "invalid_request", "request too large");
      let b;
      try { b = JSON.parse(raw.toString("utf8")); } catch { return refuse(res, 400, "invalid_request", "bad JSON"); }
      if (!b || typeof b !== "object" || Array.isArray(b)) return refuse(res, 400, "invalid_request", "bad JSON");

      const who = identify(req.headers["lattice-session"]);
      if (!who) return refuse(res, 401, "unauthorized", "Sign in to pay.");
      if (typeof b.order_ref !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.order_ref)) return refuse(res, 400, "invalid_request", "bad order_ref");
      if (!hostUrlOk(b.return_url, RETURN_PATH) || !hostUrlOk(b.cancel_url, CANCEL_PATH)) return refuse(res, 400, "invalid_request", "return_url and cancel_url must be the host's own");

      const order = getOwned(b.order_ref, who.subject);
      if (!order) return refuse(res, 404, "not_found", "No such order.");
      if (order.status === "paid") return refuse(res, 409, "already_paid", "That order has already been paid.");

      // The amount comes from the order we hold, never from the request.
      order.attempts++;

      // The host offers to draw the card form itself, and we are set up for it.
      if (Array.isArray(b.methods) && b.methods.includes("card_sheet") && publishableKey && processorApi) {
        let intent;
        try {
          intent = await stripe.paymentIntents.create(
            { amount: order.total_minor, currency: order.currency.toLowerCase(), payment_method_types: ["card"], metadata: { order_id: order.id } },
            { idempotencyKey: `lattice-pi-${order.id}-${new URL(b.return_url).searchParams.get("state")}` }
          );
        } catch (e) {
          log(`payments: could not create a payment intent for ${order.id}: ${e.message}`);
          return refuse(res, 502, "processor_unavailable", "The payment processor could not be reached. Please try again.");
        }
        if (intent.amount !== order.total_minor || intent.currency !== order.currency.toLowerCase()) {
          log(`payments: intent for ${order.id} disagrees with the order (${intent.amount} ${intent.currency})`);
          return refuse(res, 502, "processor_unavailable", "The payment processor returned an unexpected amount.");
        }
        if (!order.intentIds.includes(intent.id)) order.intentIds.push(intent.id);
        if (order.status === "created") order.status = "pending";
        return reply(res, 200, {
          handler: "stripe-card",
          reference: intent.id,
          publishable_key: publishableKey,
          api: processorApi,
          summary: { currency: order.currency, total_minor: order.total_minor, items: order.items.map(({ label, amount_minor, quantity }) => ({ label, amount_minor, quantity })) },
        });
      }

      let session;
      try {
        session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            client_reference_id: order.id,
            metadata: { order_id: order.id },
            success_url: b.return_url,
            cancel_url: b.cancel_url,
            line_items: order.items.map((i) => ({
              quantity: i.quantity,
              price_data: { currency: order.currency.toLowerCase(), unit_amount: i.amount_minor, product_data: { name: i.label } },
            })),
          },
          // Stable per (order, return state): a retried call returns the same checkout, not a second one.
          { idempotencyKey: `lattice-${order.id}-${new URL(b.return_url).searchParams.get("state")}` }
        );
      } catch (e) {
        log(`payments: could not create a checkout session for ${order.id}: ${e.message}`);
        return refuse(res, 502, "processor_unavailable", "The payment processor could not be reached. Please try again.");
      }
      if (session.amount_total !== order.total_minor || session.currency !== order.currency.toLowerCase()) {
        log(`payments: processor session for ${order.id} disagrees with the order (${session.amount_total} ${session.currency})`);
        return refuse(res, 502, "processor_unavailable", "The payment processor returned an unexpected amount.");
      }
      // Every session we ever made for this order stays acceptable: the user may pay on an earlier one.
      if (!order.sessionIds.includes(session.id)) order.sessionIds.push(session.id);
      if (order.status === "created") order.status = "pending";

      reply(res, 200, {
        handler: "stripe",
        url: session.url,
        reference: session.id,
        summary: { currency: order.currency, total_minor: order.total_minor, items: order.items.map(({ label, amount_minor, quantity }) => ({ label, amount_minor, quantity })) },
      });
    } catch (e) {
      log(`payments sessions: ${e.stack ?? e}`);
      refuse(res, 500, "internal", "internal error");
    }
  }

  // ---- Host-facing: confirm an intent with a tokenised card -----------------------------------

  async function confirmEndpoint(req, res) {
    try {
      if (req.method !== "POST") return refuse(res, 405, "invalid_request", "POST only");
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return refuse(res, 415, "invalid_request", "expected application/json");
      const raw = await readBody(req, MAX_JSON);
      if (!raw) return refuse(res, 413, "invalid_request", "request too large");
      let b;
      try { b = JSON.parse(raw.toString("utf8")); } catch { return refuse(res, 400, "invalid_request", "bad JSON"); }
      if (!b || typeof b !== "object" || Array.isArray(b)) return refuse(res, 400, "invalid_request", "bad JSON");

      const who = identify(req.headers["lattice-session"]);
      if (!who) return refuse(res, 401, "unauthorized", "Sign in to pay.");
      if (typeof b.order_ref !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.order_ref)) return refuse(res, 400, "invalid_request", "bad order_ref");
      if (typeof b.reference !== "string" || !/^pi_[A-Za-z0-9_]{1,64}$/.test(b.reference)) return refuse(res, 400, "invalid_request", "bad reference");
      if (typeof b.payment_method !== "string" || !/^pm_[A-Za-z0-9_]{1,64}$/.test(b.payment_method)) return refuse(res, 400, "invalid_request", "bad payment_method");
      if (b.return_url !== undefined && !hostUrlOk(b.return_url, RETURN_PATH)) return refuse(res, 400, "invalid_request", "return_url must be the host's own");

      const order = getOwned(b.order_ref, who.subject);
      if (!order) return refuse(res, 404, "not_found", "No such order.");
      if (order.status === "paid") return refuse(res, 409, "already_paid", "That order has already been paid.");
      // Only an intent we made for this order, which the owner is asking about.
      if (!order.intentIds.includes(b.reference)) return refuse(res, 404, "not_found", "No such payment.");

      let intent;
      try {
        // With a return_url, a card that needs 3-D Secure comes back with the address of the bank's page to send the user to.
        intent = await stripe.paymentIntents.confirm(b.reference, { payment_method: b.payment_method, ...(b.return_url ? { return_url: b.return_url } : {}) });
      } catch (e) {
        if (e?.type === "StripeCardError" || e?.rawType === "card_error") {
          return refuse(res, 402, e.code ?? "card_declined", String(e.message ?? "Your card was declined.").slice(0, 200));
        }
        log(`payments: could not confirm ${b.reference} for ${order.id}: ${e.message}`);
        return refuse(res, 502, "processor_unavailable", "The payment processor could not be reached. Please try again.");
      }
      // What the host is told is a hint: the webhook decides whether the order is paid.
      const status = ["succeeded", "processing", "requires_action"].includes(intent.status) ? intent.status : "failed";
      const actionUrl = status === "requires_action" && intent.next_action?.type === "redirect_to_url" ? intent.next_action.redirect_to_url?.url : undefined;
      reply(res, 200, { status, ...(actionUrl ? { action_url: actionUrl } : {}) });
    } catch (e) {
      log(`payments confirm: ${e.stack ?? e}`);
      refuse(res, 500, "internal", "internal error");
    }
  }

  // ---- Processor-facing: the webhook ----------------------------------------------------------

  const ack = (res, status = 200, body = { received: true }) => reply(res, status, body);

  async function webhookEndpoint(req, res) {
    try {
      if (req.method !== "POST") return ack(res, 405, { error: "POST only" });
      const raw = await readBody(req, MAX_WEBHOOK);
      if (!raw) return ack(res, 413, { error: "too large" });
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") return ack(res, 400, { error: "missing signature" });

      let event;
      try {
        // Over the exact bytes received, with Stripe's five-minute timestamp tolerance.
        event = stripe.webhooks.constructEvent(raw, signature, webhookSecret, 300);
      } catch (e) {
        log(`payments webhook: rejected (${e.message})`);
        return ack(res, 400, { error: "bad signature" });
      }

      // The library rejects events that are too old. Refuse ones dated too far ahead as well: the
      // signature covers the timestamp, so only the signer could make one, but accepting it would stretch
      // the replay window to however far ahead it is dated.
      const stamped = Number(/(?:^|,)t=(\d+)/.exec(signature)?.[1]);
      if (!Number.isFinite(stamped) || stamped > Math.floor(now() / 1000) + 300) {
        log("payments webhook: rejected (timestamp is in the future)");
        return ack(res, 400, { error: "bad signature" });
      }

      // Processors deliver at least once. A repeated event does nothing a second time.
      if (seenEvents.has(event.id)) return ack(res);
      seenEvents.add(event.id);
      if (seenEvents.size > SEEN_EVENTS) seenEvents.delete(seenEvents.values().next().value);

      const session = event.data?.object;
      const order = session && typeof session.client_reference_id === "string" ? orders.get(session.client_reference_id) : null;

      // A card paid through the host's own sheet: a PaymentIntent, found through the order id we put in its metadata.
      if (event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed") {
        const intent = session;
        const io = typeof intent?.metadata?.order_id === "string" ? orders.get(intent.metadata.order_id) : null;
        if (!io) { log(`payments webhook: ${event.type} for an unknown order`); return ack(res); }
        if (!io.intentIds.includes(intent.id)) { log(`payments webhook: intent ${intent.id} is not one of ${io.id}'s`); return ack(res); }
        if (event.type === "payment_intent.payment_failed") {
          if (io.status !== "paid") io.status = "failed"; // `paid` is terminal
          return ack(res);
        }
        if (intent.amount !== io.total_minor || intent.amount_received !== io.total_minor || String(intent.currency).toLowerCase() !== io.currency.toLowerCase()) {
          log(`payments webhook: amount mismatch on ${io.id}: ${intent.amount_received}/${intent.amount} ${intent.currency} vs ${io.total_minor} ${io.currency}`);
          return ack(res);
        }
        if (intent.status !== "succeeded") return ack(res);
        if (io.status === "paid") {
          if (intent.id !== io.paidSessionId) log(`payments: ${io.id} was paid twice (${io.paidSessionId} and ${intent.id}); one needs a refund`);
          return ack(res);
        }
        io.status = "paid";
        io.paidSessionId = intent.id;
        io.paidAt = now();
        for (const fn of paidHooks) {
          try { await fn({ ...io }); } catch (e) { log(`payments: fulfilment hook failed for ${io.id}: ${e.message}`); }
        }
        return ack(res);
      }

      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          if (!order) { log(`payments webhook: ${event.type} for an unknown order`); return ack(res); }
          // It must be a session we made for this order, for exactly what we asked.
          if (!order.sessionIds.includes(session.id)) { log(`payments webhook: session ${session.id} is not one of ${order.id}'s`); return ack(res); }
          if (session.amount_total !== order.total_minor || String(session.currency).toLowerCase() !== order.currency.toLowerCase()) {
            log(`payments webhook: amount mismatch on ${order.id}: ${session.amount_total} ${session.currency} vs ${order.total_minor} ${order.currency}`);
            return ack(res);
          }
          // Not yet paid (asynchronous methods): wait for the later success event.
          if (session.payment_status !== "paid") return ack(res);
          if (order.status === "paid") {
            if (session.id !== order.paidSessionId) log(`payments: ${order.id} was paid twice (sessions ${order.paidSessionId} and ${session.id}); one needs a refund`);
            return ack(res);
          }
          order.status = "paid";
          order.paidSessionId = session.id;
          order.paidAt = now();
          for (const fn of paidHooks) {
            try { await fn({ ...order }); } catch (e) { log(`payments: fulfilment hook failed for ${order.id}: ${e.message}`); }
          }
          return ack(res);
        }
        case "checkout.session.async_payment_failed":
        case "checkout.session.expired":
          // `paid` is terminal: a late failure or expiry never undoes it.
          if (order && order.sessionIds.includes(session.id) && order.status !== "paid") order.status = event.type.endsWith("expired") ? "expired" : "failed";
          return ack(res);
        default:
          return ack(res); // not an event we use; acknowledge so the processor does not retry
      }
    } catch (e) {
      log(`payments webhook: ${e.stack ?? e}`);
      ack(res, 500, { error: "internal" });
    }
  }

  return { createOrder, getOwned, sessionsEndpoint, confirmEndpoint, webhookEndpoint, onPaid: (fn) => void paidHooks.push(fn), orders, stripe };
}

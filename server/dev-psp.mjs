// A Stripe-compatible payment processor for DEVELOPMENT AND TESTS ONLY.
//
// It implements the part of Stripe's API that Lattice's hosted-checkout flow uses, with Stripe's request
// and response shapes and its webhook signature scheme, so the real `stripe` library (and so the real
// adapter in payments.mjs) runs against it unchanged:
//
//   POST /v1/checkout/sessions        create a Checkout Session (form-encoded, Bearer secret key)
//   GET  /v1/checkout/sessions/:id    retrieve it
//   POST /v1/payment_methods          tokenise a card (form-encoded, Bearer PUBLISHABLE key, CORS enabled): what a host-drawn
//                                     card sheet calls. Test cards: 4242 4242 4242 4242 pays, 4000 0000 0000 0002 is declined,
//                                     4000 0025 0000 3155 asks for extra authentication
//   POST /v1/payment_intents          create an intent (secret key)
//   POST /v1/payment_intents/:id/confirm   confirm it with a payment method (secret key)
//   GET  /authenticate/:id            the bank's verification page for an intent (3-D Secure)
//   POST /authenticate/:id            its buttons: complete | fail
//   GET  /c/pay/:id                   the hosted payment page (it is a web page: processors are legacy sites)
//   POST /c/pay/:id                   the page's buttons: pay | decline | cancel
//
// On payment it sends a signed `checkout.session.completed` webhook to the configured URL, then redirects the
// user to success_url, in that order unless told to delay the webhook. No money moves.
//
// This mirrors Stripe's documentation. It has not been checked against the live service.
//
//   node dev-psp.mjs [--port 9200] [--webhook-url http://127.0.0.1:8080/pay/webhook] [--webhook-secret whsec_dev]

import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rid = (n = 24) => randomBytes(n).toString("base64url").replace(/[-_]/g, "x").slice(0, n);

/** `a[b][0][c]=1` -> { a: { b: [ { c: "1" } ] } } */
export function nest(params) {
  const root = {};
  for (const [key, value] of params) {
    const path = key.replace(/\]/g, "").split("[");
    let cur = root;
    path.forEach((p, i) => {
      const last = i === path.length - 1;
      const next = path[i + 1];
      if (last) cur[p] = value;
      else cur = cur[p] ??= /^\d+$/.test(next) ? [] : {};
    });
  }
  return root;
}

/** Stripe's webhook signature header: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<payload>"> */
export function signStripe(payload, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

export const DEV_PUBLISHABLE_KEY = "pk_test_latticedev";

const luhn = (n) => {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

export async function startPsp({ port = 0, secretKey = "sk_test_dev", publishableKey = DEV_PUBLISHABLE_KEY, webhookSecret = "whsec_dev", webhookUrl = null, webhookDelayMs = 0, now = () => Date.now() } = {}) {
  const sessions = new Map();
  const intents = new Map();
  const methods = new Map(); // pm_ id -> { behaviour, brand, last4 }  (the number itself is never kept)
  const idempotency = new Map(); // key -> { fingerprint, sessionId }
  const state = { webhookUrl, webhookSecret, webhookDelayMs, pending: [], delivered: [] };
  let base;

  const json = (res, status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Access-Control-Allow-Origin": "*", ...headers });
    res.end(text);
  };
  const stripeError = (res, status, type, message, extra = {}) => json(res, status, { error: { type, message, ...extra } });
  const page = (res, status, html) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action *", "X-Frame-Options": "DENY" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev checkout</title><body style="font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem">${html}`);
  };
  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 256 * 1024) throw new Error("too large"); chunks.push(c); }
    return Buffer.concat(chunks).toString("utf8");
  }

  const event = (type, session) => ({
    id: `evt_${rid()}`, object: "event", api_version: "2025-01-01", created: Math.floor(now() / 1000),
    type, livemode: false, pending_webhooks: 1, data: { object: session },
  });

  /** POST an event to the webhook URL, signed. Overrides let tests send bad or stale ones. */
  async function deliver(ev, { secret = state.webhookSecret, timestamp, tamper, omitSignature, url = state.webhookUrl } = {}) {
    if (!url) return { skipped: true };
    let payload = JSON.stringify(ev);
    const header = signStripe(payload, secret, timestamp ?? Math.floor(now() / 1000));
    if (tamper) payload = tamper(payload);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(omitSignature ? {} : { "Stripe-Signature": header }) },
      body: payload,
    });
    const out = { status: res.status, event: ev };
    state.delivered.push(out);
    return out;
  }

  const sessionView = ({ _items, ...s }) => ({ ...s });

  /** Send an event when the configured delay says to. */
  async function announce(ev) {
    if (state.webhookDelayMs === 0) await deliver(ev).catch(() => {});
    else if (Number.isFinite(state.webhookDelayMs)) setTimeout(() => deliver(ev).catch(() => {}), state.webhookDelayMs);
    else state.pending.push(ev); // held until the test releases it
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");

      // ---- The API (authenticated) ---------------------------------------------------------------
      if (url.pathname.startsWith("/v1/")) {
        // A browser calling the tokenisation endpoint from the app's page is cross-origin: allow it, for that endpoint only.
        if (req.method === "OPTIONS" && url.pathname === "/v1/payment_methods") {
          return void res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST", "Access-Control-Max-Age": "600" }).end();
        }
        const auth = req.headers.authorization ?? "";

        // Tokenising a card is the one call a publishable key may make. It never accepts the secret key's other powers.
        if (req.method === "POST" && url.pathname === "/v1/payment_methods") {
          if (auth !== `Bearer ${publishableKey}`) return stripeError(res, 401, "invalid_request_error", "Invalid API Key provided.");
          const p = nest(new URLSearchParams(await body(req)));
          const bad = (m, param) => stripeError(res, 400, "invalid_request_error", m, { param });
          if (p.type !== "card" || !p.card) return bad("Only type=card is supported by the dev processor.", "type");
          // A wallet's token, as Stripe's test tokens: tok_visa pays, tok_chargeDeclined is declined, tok_threeDSecureRequired asks for verification.
          if (p.card.token !== undefined) {
            const behaviour = { tok_visa: "pay", tok_chargeDeclined: "decline", tok_threeDSecureRequired: "authenticate" }[p.card.token];
            if (!behaviour) return stripeError(res, 400, "invalid_request_error", `No such token: '${p.card.token}'`, { param: "card[token]" });
            const id = `pm_${rid(24)}`;
            methods.set(id, { behaviour, last4: "4242" });
            return json(res, 200, { id, object: "payment_method", type: "card", livemode: false, card: { brand: "visa", last4: "4242", wallet: { type: "google_pay" } } });
          }
          const number = String(p.card.number ?? "").replace(/[ -]/g, "");
          if (!/^\d{12,19}$/.test(number) || !luhn(number)) return stripeError(res, 402, "card_error", "Your card number is incorrect.", { code: "incorrect_number", param: "number" });
          const month = Number(p.card.exp_month), year = Number(p.card.exp_year);
          const nowD = new Date(now());
          if (!Number.isInteger(month) || month < 1 || month > 12) return stripeError(res, 402, "card_error", "Your card's expiration month is invalid.", { code: "invalid_expiry_month", param: "exp_month" });
          if (!Number.isInteger(year) || year < nowD.getUTCFullYear() || (year === nowD.getUTCFullYear() && month < nowD.getUTCMonth() + 1)) return stripeError(res, 402, "card_error", "Your card has expired.", { code: "expired_card", param: "exp_year" });
          if (!/^\d{3,4}$/.test(String(p.card.cvc ?? ""))) return stripeError(res, 402, "card_error", "Your card's security code is invalid.", { code: "invalid_cvc", param: "cvc" });
          const id = `pm_${rid(24)}`;
          const behaviour = number === "4000000000000002" ? "decline" : number === "4000002500003155" ? "authenticate" : "pay";
          methods.set(id, { behaviour, last4: number.slice(-4) });
          return json(res, 200, { id, object: "payment_method", type: "card", livemode: false, card: { brand: "visa", last4: number.slice(-4), exp_month: month, exp_year: year } });
        }

        if (auth !== `Bearer ${secretKey}`) return stripeError(res, 401, "invalid_request_error", "Invalid API Key provided.");

        if (req.method === "POST" && url.pathname === "/v1/payment_intents") {
          const raw = await body(req);
          const p = nest(new URLSearchParams(raw));
          const amount = Number(p.amount);
          if (!Number.isInteger(amount) || amount < 1) return stripeError(res, 400, "invalid_request_error", "Invalid positive integer", { param: "amount" });
          if (!/^[a-z]{3}$/.test(p.currency ?? "")) return stripeError(res, 400, "invalid_request_error", "Invalid currency.", { param: "currency" });
          const key = req.headers["idempotency-key"];
          if (key && idempotency.has(key)) {
            const prior = idempotency.get(key);
            if (prior.fingerprint !== raw) return stripeError(res, 400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
            return json(res, 200, intents.get(prior.sessionId));
          }
          const id = `pi_${rid(24)}`;
          const intent = { id, object: "payment_intent", amount, amount_received: 0, currency: p.currency, status: "requires_payment_method", metadata: p.metadata ?? {}, payment_method: null, client_secret: `${id}_secret_${rid(16)}`, livemode: false, created: Math.floor(now() / 1000) };
          intents.set(id, intent);
          if (key) idempotency.set(key, { fingerprint: raw, sessionId: id });
          return json(res, 200, intent);
        }

        const pi = url.pathname.match(/^\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)(\/confirm)?$/);
        if (pi) {
          const intent = intents.get(pi[1]);
          if (!intent) return stripeError(res, 404, "invalid_request_error", `No such payment_intent: '${pi[1]}'`);
          if (req.method === "GET" && !pi[2]) return json(res, 200, intent);
          if (req.method === "POST" && pi[2]) {
            const p = nest(new URLSearchParams(await body(req)));
            if (intent.status === "succeeded") return stripeError(res, 400, "invalid_request_error", "This PaymentIntent has already succeeded.", { code: "payment_intent_unexpected_state" });
            const pm = methods.get(p.payment_method);
            if (!pm) return stripeError(res, 400, "invalid_request_error", `No such PaymentMethod: '${p.payment_method}'`, { param: "payment_method" });
            intent.payment_method = p.payment_method;
            if (pm.behaviour === "decline") {
              intent.status = "requires_payment_method";
              return stripeError(res, 402, "card_error", "Your card was declined.", { code: "card_declined", decline_code: "generic_decline", payment_intent: { id: intent.id } });
            }
            if (pm.behaviour === "authenticate") {
              intent.status = "requires_action";
              intent.next_action = p.return_url
                ? { type: "redirect_to_url", redirect_to_url: { url: `${base}/authenticate/${intent.id}`, return_url: p.return_url } }
                : { type: "use_stripe_sdk" };
              return json(res, 200, intent);
            }
            intent.status = "succeeded";
            intent.amount_received = intent.amount;
            await announce(event("payment_intent.succeeded", { ...intent }));
            return json(res, 200, intent);
          }
        }

        if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
          const raw = await body(req);
          const p = nest(new URLSearchParams(raw));
          const bad = (m, param) => stripeError(res, 400, "invalid_request_error", m, { param });
          if (p.mode !== "payment") return bad("Only mode=payment is supported by the dev processor.", "mode");
          if (!/^https?:\/\//.test(p.success_url ?? "")) return bad("Not a valid URL", "success_url");
          if (p.cancel_url && !/^https?:\/\//.test(p.cancel_url)) return bad("Not a valid URL", "cancel_url");
          const items = Array.isArray(p.line_items) ? p.line_items : [];
          if (!items.length) return bad("Missing required param: line_items.", "line_items");
          let total = 0;
          for (const li of items) {
            const pd = li?.price_data;
            const amount = Number(pd?.unit_amount);
            const qty = Number(li?.quantity ?? 1);
            if (!/^[a-z]{3}$/.test(pd?.currency ?? "")) return bad("Invalid currency.", "line_items[0][price_data][currency]");
            if (!Number.isInteger(amount) || amount < 0) return bad("Invalid integer.", "line_items[0][price_data][unit_amount]");
            if (!Number.isInteger(qty) || qty < 1) return bad("Invalid integer.", "line_items[0][quantity]");
            if (!pd?.product_data?.name) return bad("Missing required param: line_items[0][price_data][product_data][name].", "line_items[0][price_data][product_data][name]");
            total += amount * qty;
          }
          const currency = items[0].price_data.currency;

          const key = req.headers["idempotency-key"];
          const fingerprint = raw;
          if (key && idempotency.has(key)) {
            const prior = idempotency.get(key);
            if (prior.fingerprint !== fingerprint) {
              return stripeError(res, 400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
            }
            return json(res, 200, sessionView(sessions.get(prior.sessionId)));
          }

          const id = `cs_test_${rid(40)}`;
          const created = Math.floor(now() / 1000);
          const session = {
            id, object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid",
            amount_subtotal: total, amount_total: total, currency,
            client_reference_id: p.client_reference_id ?? null, metadata: p.metadata ?? {},
            success_url: p.success_url, cancel_url: p.cancel_url ?? null,
            url: `${base}/c/pay/${id}`, created, expires_at: created + 1800, livemode: false,
            _items: items.map((li) => ({ name: li.price_data.product_data.name, unit: Number(li.price_data.unit_amount), qty: Number(li.quantity ?? 1) })),
          };
          sessions.set(id, session);
          if (key) idempotency.set(key, { fingerprint, sessionId: id });
          return json(res, 200, sessionView(session));
        }

        const m = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/);
        if (req.method === "GET" && m) {
          const s = sessions.get(m[1]);
          return s ? json(res, 200, sessionView(s)) : stripeError(res, 404, "invalid_request_error", `No such checkout.session: '${m[1]}'`);
        }
        return stripeError(res, 404, "invalid_request_error", "Unrecognized request URL.");
      }

      // ---- The bank's verification page --------------------------------------------------------------
      const ap = url.pathname.match(/^\/authenticate\/(pi_[A-Za-z0-9]+)$/);
      if (ap) {
        const intent = intents.get(ap[1]);
        const returnUrl = intent?.next_action?.redirect_to_url?.return_url;
        if (!returnUrl) return page(res, 404, "<h1>Nothing to verify</h1>");
        if (req.method === "GET") {
          return page(res, 200, `<h1>Dev bank</h1><p>This is a development processor. Verify this payment?</p>
            <form method="post"><p><button name="outcome" value="complete">Complete verification</button></p>
            <p><button name="outcome" value="fail">Fail verification</button></p></form>`);
        }
        if (req.method === "POST") {
          const outcome = new URLSearchParams(await body(req)).get("outcome");
          if (outcome !== "complete" && outcome !== "fail") return page(res, 400, "<h1>Unknown choice</h1>");
          intent.next_action = null;
          if (outcome === "complete") {
            intent.status = "succeeded";
            intent.amount_received = intent.amount;
            await announce(event("payment_intent.succeeded", { ...intent }));
          } else {
            intent.status = "requires_payment_method";
            await announce(event("payment_intent.payment_failed", { ...intent }));
          }
          const back = new URL(returnUrl);
          back.searchParams.set("payment_intent", intent.id);
          back.searchParams.set("payment_intent_client_secret", intent.client_secret); // as Stripe does; the host must not keep it
          back.searchParams.set("redirect_status", outcome === "complete" ? "succeeded" : "failed");
          return void res.writeHead(303, { Location: back.href }).end();
        }
      }

      // ---- The hosted payment page -----------------------------------------------------------------
      const hp = url.pathname.match(/^\/c\/pay\/(cs_test_[A-Za-z0-9]+)$/);
      if (hp) {
        const s = sessions.get(hp[1]);
        if (!s) return page(res, 404, "<h1>Checkout not found</h1>");

        if (req.method === "GET") {
          if (s.status !== "open") return page(res, 200, "<h1>This checkout is no longer open</h1>");
          const money = (n) => `${(n / 100).toFixed(2)} ${s.currency.toUpperCase()}`;
          const rows = s._items.map((i) => `<li>${esc(i.name)} &times; ${i.qty}: ${esc(money(i.unit * i.qty))}</li>`).join("");
          return page(res, 200, `<h1>Dev checkout</h1><ul>${rows}</ul><p><strong>Total: ${esc(money(s.amount_total))}</strong></p>
            <p>This is a development processor. No card is charged.</p>
            <form method="post"><p><button name="outcome" value="pay">Pay with test card 4242 4242 4242 4242</button></p>
            <p><button name="outcome" value="decline">Pay with a card that will be declined</button></p>
            <p><button name="outcome" value="cancel">Cancel and return</button></p></form>`);
        }

        if (req.method === "POST") {
          const outcome = new URLSearchParams(await body(req)).get("outcome");
          if (s.status !== "open") return page(res, 400, "<h1>This checkout is no longer open</h1>");
          if (outcome === "cancel") {
            return void res.writeHead(303, { Location: s.cancel_url ?? s.success_url }).end();
          }
          if (outcome === "decline") {
            return page(res, 402, "<h1>Your card was declined.</h1><p>Go back and try another card, or cancel.</p>");
          }
          if (outcome === "pay") {
            s.status = "complete";
            s.payment_status = "paid";
            await announce(event("checkout.session.completed", sessionView(s)));
            return void res.writeHead(303, { Location: s.success_url }).end();
          }
          return page(res, 400, "<h1>Unknown choice</h1>");
        }
      }
      json(res, 404, { error: "not_found" });
    } catch (e) {
      json(res, 500, { error: { type: "api_error", message: e.message } });
    }
  });

  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    port: server.address().port,
    secretKey,
    publishableKey,
    intents,
    get webhookSecret() { return state.webhookSecret; },
    sessions,
    delivered: state.delivered,
    /** Where webhooks go, and (optionally) how long after the redirect: 0 = before it, Infinity = held. */
    configure: (o) => Object.assign(state, o),
    /** Build a session-shaped event for the given session id, for tests that deliver their own. */
    makeEvent: (type, session, over = {}) => ({ ...event(type, { ...sessionView(session), ...over }) }),
    deliver,
    /** Send events held by webhookDelayMs = Infinity. */
    async releasePending() { const evs = state.pending.splice(0); for (const e of evs) await deliver(e); return evs.length; },
    close: () => new Promise((ok) => { server.close(ok); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const psp = await startPsp({
    port: Number(opt("--port", 9200)), secretKey: opt("--secret-key", "sk_test_dev"),
    webhookSecret: opt("--webhook-secret", "whsec_dev"), webhookUrl: opt("--webhook-url", null),
  });
  console.log(`dev payment processor, Stripe-compatible (NOT A REAL PROCESSOR): ${psp.url}`);
  console.log(`  secret key ${psp.secretKey}   webhook secret ${psp.webhookSecret}   webhook url ${opt("--webhook-url", "(none)")}`);
}

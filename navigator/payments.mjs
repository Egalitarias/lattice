// The host's side of payments (spec/payments.md): hosted checkout, and a card sheet the host draws itself.
//
// The app names an order. This broker asks the app's own server what the order is and where to pay,
// validates the answer, shows the user a sheet drawn from it, opens the processor's page, and waits
// for the user to come back. It never uses a price or a URL that came from the component.

import { randomToken, uuid } from "./bytes.mjs";
import { fail } from "./prompts.mjs";

const MAX_REPLY = 64 * 1024;
const MAX_ITEMS = 50;
const PAY_TIMEOUT_MS = 10 * 60 * 1000;
const isLoopbackHost = (h) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/** What each processor the host knows may be: the hosts it may send the user to. */
export const HANDLERS = {
  stripe: { checkoutHosts: ["checkout.stripe.com"] },
  // The host draws the card form and tokenises the card itself, at the processor's API, with the merchant's publishable key.
  // actionHosts: where the processor may send the user to verify a card with their bank (3-D Secure).
  "stripe-card": { apiHosts: ["api.stripe.com"], actionHosts: ["hooks.stripe.com"], card: true },
};

const MAX_CARD_ATTEMPTS = 5;
const CARD_TIMEOUT_MS = 15_000;

/** The Luhn check digit: catches a mistyped number before anything is sent. */
const luhnOk = (n) => {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

/** Validate what the user typed. Returns { ok: true, card } with clean values, or { ok: false, error }. */
export function checkCard(input, now = new Date()) {
  const number = String(input?.number ?? "").replace(/[ -]/g, "");
  if (!/^\d{12,19}$/.test(number) || !luhnOk(number)) return { ok: false, error: "That card number does not look right. Check it and try again." };
  const month = Number(input.exp_month);
  let year = Number(input.exp_year);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { ok: false, error: "The expiry month must be 1 to 12." };
  if (Number.isInteger(year) && year < 100) year += 2000;
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  if (!Number.isInteger(year) || year > y + 25 || year < y || (year === y && month < m)) return { ok: false, error: "That card has expired, or the expiry year is not valid." };
  const cvc = String(input.cvc ?? "");
  if (!/^\d{3,4}$/.test(cvc)) return { ok: false, error: "The security code is 3 or 4 digits." };
  return { ok: true, card: { number, exp_month: month, exp_year: year, cvc } };
}

/** Text from the processor or server that is safe to show: no long digit runs, short. */
const safeMessage = (m, fallback) => (typeof m === "string" && m ? m.replace(/\d[\d \-]{5,}\d/g, "[number]").slice(0, 150) : fallback);

const rand = () => randomToken(32);

export class PaymentBroker {
  /**
   * @param manifest   the verified manifest
   * @param endpoint   absolute URL of payments.server, mapped to the address the manifest was fetched from; or null
   * @param session    SessionStore
   * @param uiOrigin   () => origin the user's browser is on
   * @param prompts    shared Prompts
   * @param dev        allow plain-http checkout on loopback (development processors)
   */
  constructor({ manifest, endpoint, session, uiOrigin, prompts, dev = false, timeoutMs = PAY_TIMEOUT_MS, fetchImpl = (...args) => fetch(...args) }) {
    Object.assign(this, { manifest, endpoint, session, uiOrigin, prompts, dev, timeoutMs, fetchImpl });
  }

  /** Can this host draw the card sheet for this app? The manifest must say so and name the key the app uses. */
  #cardSheetOk() {
    return (this.manifest.payments?.handlers ?? []).includes("stripe-card") && !!this.manifest.payments?.merchant?.stripe_publishable_key;
  }

  /**
   * Can the sheet also offer a wallet (Google Pay, through the browser's Payment Request API)? The manifest must opt in with
   * `stripe-wallet`. Google needs a merchant id for real payments; a test key needs none. Returns what the window needs, or null.
   */
  #walletOffer(publishableKey) {
    const m = this.manifest.payments;
    if (!(m?.handlers ?? []).includes("stripe-wallet")) return null;
    const test = publishableKey.startsWith("pk_test_");
    const merchantId = m.merchant?.google_merchant_id;
    if (!test && !merchantId) return null;
    return { publishableKey, environment: test ? "TEST" : "PRODUCTION", ...(merchantId ? { merchantId } : {}) };
  }

  /** The processor's API address for a card sheet: its fixed host, or in development a loopback one. Origin only. */
  #apiOk(handler, value) {
    let u;
    try { u = new URL(value); } catch { return null; }
    if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    if (u.protocol === "https:" && HANDLERS[handler].apiHosts.includes(u.hostname)) return u.origin;
    return this.dev && u.protocol === "http:" && isLoopbackHost(u.hostname) ? u.origin : null;
  }

  /** Is this the kind of URL a handler may send the user to, given the hosts it may use? */
  #userUrlOk(hosts, value) {
    if (typeof value !== "string" || value.length > 2048) return false;
    let u;
    try { u = new URL(value); } catch { return false; }
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return hosts.includes(u.hostname);
    return this.dev && u.protocol === "http:" && isLoopbackHost(u.hostname);
  }

  /** Validate the server's session reply. Returns the clean value the sheet is drawn from, or throws. */
  #validate(reply) {
    const bad = (why) => fail("invalid-argument", `the server's payment details were rejected: ${why}`);
    if (!reply || typeof reply !== "object") throw bad("not an object");
    const { handler, url, reference, summary } = reply;
    if (typeof handler !== "string" || !Object.hasOwn(HANDLERS, handler)) throw bad("unknown handler");
    if (!(this.manifest.payments?.handlers ?? []).includes(handler)) throw bad("handler is not in the manifest");
    const card = !!HANDLERS[handler].card;
    if (card) {
      if (!this.#cardSheetOk()) throw bad("the manifest does not declare a publishable key");
      // The key the app's server names must be the one in the manifest: a server cannot redirect the card to another account.
      if (reply.publishable_key !== this.manifest.payments.merchant.stripe_publishable_key) throw bad("the publishable key is not the manifest's");
      if (typeof reference !== "string" || !/^pi_[A-Za-z0-9_]{1,64}$/.test(reference)) throw bad("bad reference");
    } else {
      if (!this.#userUrlOk(HANDLERS[handler].checkoutHosts, url)) throw bad("the checkout address is not one this handler may use");
      if (typeof reference !== "string" || reference.length > 256) throw bad("bad reference");
    }
    if (!summary || typeof summary !== "object") throw bad("no summary");

    const { currency, total_minor: total, items } = summary;
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw bad("bad currency");
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) throw bad("bad items");
    let sum = 0;
    const clean = [];
    for (const i of items) {
      if (!i || typeof i !== "object") throw bad("bad item");
      if (typeof i.label !== "string" || i.label.length < 1 || i.label.length > 100) throw bad("bad item label");
      if (!Number.isSafeInteger(i.amount_minor) || i.amount_minor < 0) throw bad("bad item amount");
      if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 1000) throw bad("bad item quantity");
      sum += i.amount_minor * i.quantity;
      clean.push({ label: i.label, amount_minor: i.amount_minor, quantity: i.quantity });
    }
    if (!Number.isSafeInteger(total) || total < 0) throw bad("bad total");
    if (total !== sum) throw bad("the total does not equal the sum of its lines");
    const out = { handler, url, reference, summary: { currency, total_minor: total, items: clean } };
    if (card) {
      const api = this.#apiOk(handler, reply.api);
      if (!api) throw bad("the processor address is not one this handler may use");
      Object.assign(out, { api, publishableKey: reply.publishable_key });
    }
    return out;
  }

  async request(orderRef) {
    if (typeof orderRef !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(orderRef)) throw fail("invalid-argument", "bad order reference");
    if (!this.endpoint || !this.manifest.payments) throw fail("unavailable", "the app declares no payments.server");

    const state = rand();
    const ui = this.uiOrigin();
    let res;
    try {
      res = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Lattice-Session": this.session.token(), "Lattice-Request-Id": uuid() },
        body: JSON.stringify({
          order_ref: orderRef,
          ...(this.#cardSheetOk() ? { methods: ["card_sheet"] } : {}),
          return_url: `${ui}/_navigator/payment/return?state=${state}`,
          cancel_url: `${ui}/_navigator/payment/cancel?state=${state}`,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw fail("unavailable", `could not reach the app's server: ${e.message}`);
    }

    const text = await res.text().catch(() => "");
    if (text.length > MAX_REPLY) throw fail("invalid-argument", "the server's reply was too large");
    let reply;
    try { reply = JSON.parse(text); } catch { reply = null; }
    if (!res.ok) throw fail("invalid-argument", String(reply?.message ?? `the server refused the payment (${res.status})`).slice(0, 200));

    const checked = this.#validate(reply);
    const { app } = this.prompts;
    if (HANDLERS[checked.handler].card) {
      // The host draws the form. Nothing the user types goes anywhere the host did not choose: the processor's API
      // (tokenising) and the app's own server (confirming). The component sees neither.
      const wallet = this.#walletOffer(checked.publishableKey);
      await this.prompts.ask(
        { flow: "payment", method: "card", handlerHost: new URL(checked.api).host, summary: checked.summary, app, ...(wallet ? { wallet } : {}) },
        { state, handler: checked.handler, orderRef, reference: checked.reference, api: checked.api, publishableKey: checked.publishableKey, attempts: 0, busy: false, timeoutMs: this.timeoutMs }
      );
      return { orderRef, handler: checked.handler };
    }
    await this.prompts.ask(
      {
        flow: "payment",
        handlerHost: new URL(checked.url).host,
        url: checked.url,
        summary: checked.summary,
        app,
      },
      { state, handler: checked.handler, orderRef, timeoutMs: this.timeoutMs }
    );
    return { orderRef, handler: checked.handler };
  }

  /**
   * The user submitted the host-drawn card form for prompt `id`. Returns { ok: true } (the prompt is finished) or
   * { ok: false, error } with a message for the sheet; the sheet stays open for another try. The card never leaves this
   * function except to the processor's tokenising endpoint, and what comes back from there is a token.
   */
  async submitCard(id, input) {
    return this.#attempt(id, () => {
      const checked = checkCard(input);
      if (!checked.ok) return checked;
      const { number, exp_month, exp_year, cvc } = checked.card;
      return { ok: true, fields: { type: "card", "card[number]": number, "card[exp_month]": String(exp_month), "card[exp_year]": String(exp_year), "card[cvc]": cvc } };
    });
  }

  /**
   * The user approved the payment in their wallet, in the window; `token` is what the wallet handed back (for Google Pay with
   * Stripe's gateway, a JSON text holding a Stripe token). Same rules and the same attempts as a card typed into the form.
   */
  async submitWallet(id, token) {
    return this.#attempt(id, (entry) => {
      if (!entry.prompt.wallet) return { ok: false, error: "This payment does not take a wallet." };
      let parsed;
      try { parsed = typeof token === "string" && token.length <= 8192 ? JSON.parse(token) : null; } catch { parsed = null; }
      if (typeof parsed?.id !== "string" || !/^tok_[A-Za-z0-9_]{1,64}$/.test(parsed.id)) return { ok: false, error: "The wallet did not give a usable payment. Nothing was charged." };
      return { ok: true, fields: { type: "card", "card[token]": parsed.id } };
    });
  }

  /** What every way of paying shares: the sheet must be waiting, one attempt at a time, five at most. */
  async #attempt(id, prepare) {
    const entry = this.prompts.get(id);
    if (!entry || entry.prompt.flow !== "payment" || entry.prompt.method !== "card") return { ok: false, error: "That payment is no longer waiting." };
    if (entry.busy) return { ok: false, error: "Your payment is already being processed." };
    if (entry.verifying) return { ok: false, error: "Finish verifying this payment with your bank first." };
    if (entry.attempts >= MAX_CARD_ATTEMPTS) {
      this.prompts.settle(id, "reject", fail("cancelled"));
      return { ok: false, error: "Too many attempts. Start again from the app." };
    }
    const prepared = prepare(entry);
    if (!prepared.ok) return prepared;
    entry.busy = true;
    entry.attempts++;
    try {
      const pm = await this.#tokenise(entry, prepared.fields);
      if (!pm.ok) return pm;
      const confirmed = await this.#confirm(entry, pm.id);
      if (!confirmed.ok) return confirmed;
      if (!entry.verifying) this.prompts.settle(id, "resolve", true);
      return { ok: true };
    } finally {
      entry.busy = false;
    }
  }

  /** Card or wallet token -> payment method, straight to the processor with the publishable key. */
  async #tokenise(entry, fields) {
    const form = new URLSearchParams(fields);
    let res;
    try {
      res = await this.fetchImpl(`${entry.api}/v1/payment_methods`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${entry.publishableKey}` },
        body: form,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, error: "Could not reach the payment processor. Nothing was charged. Please try again." };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: safeMessage(body?.error?.message, "The card could not be accepted.") };
    if (typeof body?.id !== "string" || !/^pm_[A-Za-z0-9_]{1,64}$/.test(body.id)) return { ok: false, error: "The payment processor sent an unexpected answer. Nothing was charged." };
    return { ok: true, id: body.id };
  }

  /** Ask the app's server to charge the order with that token. The server, not this code, decides what is paid. */
  async #confirm(entry, paymentMethod) {
    entry.state = rand(); // new for each confirm: a link from an earlier attempt on this sheet is dead
    let res;
    try {
      res = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Lattice-Session": this.session.token(), "Lattice-Request-Id": uuid() },
        body: JSON.stringify({ order_ref: entry.orderRef, reference: entry.reference, payment_method: paymentMethod, return_url: `${this.uiOrigin()}/_navigator/payment/return?state=${entry.state}` }),
        redirect: "error",
        signal: AbortSignal.timeout(CARD_TIMEOUT_MS * 2),
      });
    } catch {
      return { ok: false, error: "Could not reach the app's server. Please check before trying again, in case the payment went through." };
    }
    const text = await res.text().catch(() => "");
    let body;
    try { body = text.length <= MAX_REPLY ? JSON.parse(text) : null; } catch { body = null; }
    if (res.status === 402) return { ok: false, error: safeMessage(body?.message, "Your card was declined.") };
    if (!res.ok) return { ok: false, error: safeMessage(body?.message, "The payment could not be completed.") };
    if (body?.status === "requires_action") {
      if (this.#userUrlOk(HANDLERS[entry.handler].actionHosts, body.action_url)) {
        // The bank's page opens in its own window, on the user's click. The form goes away, and with it what they typed.
        entry.verifying = true;
        const { error, ...shown } = entry.prompt;
        this.prompts.update(entry.prompt.id, { ...shown, step: "verify", url: body.action_url, actionHost: new URL(body.action_url).host });
        return { ok: true };
      }
      // A kind of verification the host cannot start. Say so rather than leave the user stuck.
      this.prompts.settle(entry.prompt.id, "reject", fail("unavailable", "the card needs extra verification, which this payment sheet cannot do"));
      return { ok: false, error: "Your bank needs to verify this payment, which this sheet cannot do." };
    }
    if (body?.status !== "succeeded" && body?.status !== "processing") return { ok: false, error: "The payment did not go through." };
    return { ok: true };
  }

  /**
   * The user's browser came back from the processor. `outcome` is "return" or "cancel". Returns what to
   * tell the user. An unknown or repeated `state` is refused without touching any pending request.
   */
  callback(outcome, params) {
    for (const name of ["state", "payment_intent", "redirect_status"]) {
      if (params.getAll(name).length > 1) return { ok: false, message: "This link is not valid. Return to the app and try again." };
    }
    const entry = this.prompts.byState("payment", params.get("state"));
    if (!entry) return { ok: false, message: "This link is not valid or has expired. Return to the app and try again." };
    const id = entry.prompt.id;
    if (entry.prompt.method === "card") {
      // The only return a card sheet expects is from the bank, for the payment it is waiting on.
      if (!entry.verifying || params.get("payment_intent") !== entry.reference) return { ok: false, message: "This link is not valid or has expired. Return to the app and try again." };
      if (params.get("redirect_status") === "failed") {
        // Only decides what to show: the sheet goes back to the form. The link is now dead.
        entry.verifying = false;
        entry.state = rand();
        const { step, url, actionHost, ...shown } = entry.prompt;
        this.prompts.update(id, { ...shown, error: "Your bank did not verify the payment. You can try again or use another card." });
        return { ok: false, message: "Your bank did not verify the payment. You can close this tab and return to the app to try again." };
      }
    }
    if (outcome === "cancel") {
      this.prompts.settle(id, "reject", fail("cancelled"));
      return { ok: false, message: "Payment cancelled. You can close this tab and return to the app." };
    }
    this.prompts.settle(id, "resolve", true);
    return { ok: true, message: "Thank you. You can close this tab and return to the app, which will confirm your payment." };
  }
}

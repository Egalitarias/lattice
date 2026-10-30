// The host's side of payments (spec/payments.md): hosted checkout.
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
};

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

  /** Is this the kind of URL the handler may send the user to? */
  #checkoutUrlOk(handler, value) {
    let u;
    try { u = new URL(value); } catch { return false; }
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return HANDLERS[handler].checkoutHosts.includes(u.hostname);
    return this.dev && u.protocol === "http:" && isLoopbackHost(u.hostname);
  }

  /** Validate the server's session reply. Returns the clean value the sheet is drawn from, or throws. */
  #validate(reply) {
    const bad = (why) => fail("invalid-argument", `the server's payment details were rejected: ${why}`);
    if (!reply || typeof reply !== "object") throw bad("not an object");
    const { handler, url, reference, summary } = reply;
    if (typeof handler !== "string" || !Object.hasOwn(HANDLERS, handler)) throw bad("unknown handler");
    if (!(this.manifest.payments?.handlers ?? []).includes(handler)) throw bad("handler is not in the manifest");
    if (typeof url !== "string" || url.length > 2048 || !this.#checkoutUrlOk(handler, url)) throw bad("the checkout address is not one this handler may use");
    if (typeof reference !== "string" || reference.length > 256) throw bad("bad reference");
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
    return { handler, url, reference, summary: { currency, total_minor: total, items: clean } };
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
   * The user's browser came back from the processor. `outcome` is "return" or "cancel". Returns what to
   * tell the user. An unknown or repeated `state` is refused without touching any pending request.
   */
  callback(outcome, params) {
    for (const name of ["state"]) {
      if (params.getAll(name).length > 1) return { ok: false, message: "This link is not valid. Return to the app and try again." };
    }
    const entry = this.prompts.byState("payment", params.get("state"));
    if (!entry) return { ok: false, message: "This link is not valid or has expired. Return to the app and try again." };
    const id = entry.prompt.id;
    if (outcome === "cancel") {
      this.prompts.settle(id, "reject", fail("cancelled"));
      return { ok: false, message: "Payment cancelled. You can close this tab and return to the app." };
    }
    this.prompts.settle(id, "resolve", true);
    return { ok: true, message: "Thank you. You can close this tab and return to the app, which will confirm your payment." };
  }
}

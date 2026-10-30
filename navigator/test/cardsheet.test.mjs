// The host-drawn card sheet (spec/payments.md, "Card sheet"): the host draws the form, tokenises the card at the processor
// with the merchant's publishable key, and asks the app's server to confirm; the webhook still decides what is paid.
// Requires the tasks component to be built.

import test from "node:test";
import assert from "node:assert/strict";
import { withStack, find, sleep } from "./stack.mjs";
import { checkCard, PaymentBroker } from "../payments.mjs";
import { Prompts } from "../prompts.mjs";

const UPGRADE = "Upgrade to Pro ($4.00)";
const stack = (fn, opts = {}) => withStack(fn, { psp: true, cardSheet: true, ...opts });
const isPro = async (h) => /\(Pro\)/.test(find((await h.state()).tree, (n) => n.id === 30).props.text);
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; };
const GOOD = { number: "4242 4242 4242 4242", exp_month: "12", exp_year: String((new Date().getUTCFullYear() + 2) % 100), cvc: "123" };
const card = (h, id, over = {}) => h.call("/_navigator/prompt/card", { id, ...GOOD, ...over });

async function startCardPurchase(h) {
  assert.equal((await h.signInOidc("alice")).res.status, 200);
  const pending = h.press(UPGRADE);
  const prompt = await h.waitPrompt("payment");
  return { pending, prompt };
}

test("card sheet: the host draws the form, the card goes to the processor and never to the app, and the webhook unlocks Pro", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startCardPurchase(h);

    // What the window is told: the summary from the server and where the card goes. No URL to open, no key, no reference.
    assert.equal(prompt.method, "card");
    assert.deepEqual(Object.keys(prompt).sort(), ["app", "flow", "handlerHost", "id", "method", "summary"]);
    assert.equal(prompt.handlerHost, `127.0.0.1:${h.psp.port}`);
    assert.deepEqual(prompt.summary, { currency: "USD", total_minor: 400, items: [{ label: "Lattice Tasks Pro", amount_minor: 400, quantity: 1 }] });

    // The server made an intent for the order's real amount.
    const [intent] = [...h.psp.intents.values()];
    assert.equal(intent.amount, 400);
    assert.equal(intent.currency, "usd");
    assert.equal(intent.metadata.order_id, [...h.payments.orders.values()][0].id);
    assert.equal(await isPro(h), false);

    const r = await card(h, prompt.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await pending).status, 200);
    assert.equal(h.psp.intents.get(intent.id).status, "succeeded");

    // The webhook, not the host's confirmation, is what made the order paid.
    assert.equal(h.psp.delivered.at(-1).event.type, "payment_intent.succeeded");
    assert.equal([...h.payments.orders.values()][0].status, "paid");
    assert.equal(await isPro(h), true);
    assert.equal(h.pro.size, 1);

    // The card appears nowhere the app or its server can see.
    const everything = JSON.stringify([[...h.payments.orders.values()], await h.state(), h.psp.intents.get(intent.id)]);
    assert.doesNotMatch(everything, /4242 ?4242|"cvc"|123"/);
  });
});

test("card sheet: a declined card keeps the sheet open for another try; the retry pays", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startCardPurchase(h);
    const declined = await card(h, prompt.id, { number: "4000 0000 0000 0002" });
    assert.equal(declined.status, 422);
    assert.match(declined.body.error, /declined/i);
    assert.equal((await h.state()).chrome.prompts.length, 1, "the sheet is still there");
    assert.equal(await isPro(h), false);

    assert.equal((await card(h, prompt.id)).status, 200);
    assert.equal((await pending).status, 200);
    assert.ok(await until(() => isPro(h)));
  });
});

test("card sheet: a card that needs extra verification ends the payment with an explanation, not a hang", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startCardPurchase(h);
    const r = await card(h, prompt.id, { number: "4000 0025 0000 3155" });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /verify/i);
    const done = await pending;
    assert.notEqual(done.status, 200, "the app was told it did not go through");
    assert.equal((await h.state()).chrome.prompts.length, 0);
    assert.equal(await isPro(h), false);
  });
});

test("card sheet: nonsense is refused by the host before anything is sent to the processor", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startCardPurchase(h);
    const before = h.psp.intents.size;
    const year = new Date().getUTCFullYear();
    for (const bad of [{ number: "4242 4242 4242 4241" }, { number: "abcd" }, { number: "" }, { exp_month: "13" }, { exp_month: "0" }, { exp_year: String(year - 1) }, { exp_year: String(year + 40) }, { cvc: "12" }, { cvc: "12345" }, { cvc: "abc" }]) {
      const r = await card(h, prompt.id, bad);
      assert.equal(r.status, 422, JSON.stringify(bad));
    }
    // And a malformed request is a 400, not an attempt.
    assert.equal((await h.call("/_navigator/prompt/card", { id: prompt.id, number: 4242424242424242, exp_month: "1", exp_year: "30", cvc: "123" })).status, 400);
    assert.equal((await h.call("/_navigator/prompt/card", { id: prompt.id })).status, 400);
    assert.equal((await h.call("/_navigator/prompt/card", { id: 7, ...GOOD })).status, 400);
    assert.equal(h.psp.intents.size, before);
    assert.equal([...h.psp.intents.values()][0].status, "requires_payment_method", "nothing was confirmed");
    await h.call("/_navigator/prompt/cancel", { id: prompt.id });
    await pending;
  });
});

test("card sheet: a prompt that does not exist, or is not a card sheet, cannot be paid into", async () => {
  await stack(async (h) => {
    assert.equal((await card(h, "no-such-prompt")).status, 422);
    assert.equal((await h.signInOidc("alice")).res.status, 200);
    const pending = h.press("Sign in with a passkey").catch(() => null);
    void pending;
    const other = await h.waitPrompt("passkey-assert").catch(() => null);
    if (other) {
      assert.equal((await card(h, other.id)).status, 422, "a sign-in prompt is not a payment sheet");
      await h.call("/_navigator/prompt/cancel", { id: other.id });
    }
  });
});

test("card sheet: after five failed attempts the payment is cancelled", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startCardPurchase(h);
    for (let i = 0; i < 5; i++) assert.equal((await card(h, prompt.id, { number: "4000 0000 0000 0002" })).status, 422);
    assert.equal((await card(h, prompt.id)).status, 422, "the sixth is refused without trying");
    assert.notEqual((await pending).status, 200);
    assert.equal((await h.state()).chrome.prompts.length, 0);
  });
});

test("card sheet: the sheet's text comes from the host, and a card is not sent until the user submits", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startCardPurchase(h);
    assert.equal(h.psp.intents.size, 1);
    assert.equal([...h.psp.intents.values()][0].payment_method, null);
    await h.call("/_navigator/prompt/cancel", { id: prompt.id });
    assert.notEqual((await pending).status, 200);
    assert.equal([...h.payments.orders.values()][0].status, "pending");
  });
});

// ---- The server's confirm endpoint, asked directly ------------------------------------------------------------------

const confirm = (h, body, token) =>
  fetch(`http://127.0.0.1:${h.originPort}/pay/confirm`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "Lattice-Session": token } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("card sheet: the confirm endpoint is for the order's owner, with an intent made for that order, once", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startCardPurchase(h);
    const token = h.nav.controller.sessionStore.token();
    const order = [...h.payments.orders.values()][0];
    const [intent] = [...h.psp.intents.values()];
    const pm = "pm_" + "a".repeat(24);

    assert.equal((await confirm(h, { order_ref: order.id, reference: intent.id, payment_method: pm })).status, 401, "no session");
    assert.equal((await confirm(h, { order_ref: order.id, reference: intent.id, payment_method: pm }, "x".repeat(40))).status, 401, "an anonymous session");
    assert.equal((await confirm(h, { order_ref: order.id, reference: intent.id, payment_method: "not-a-method" }, token)).status, 400);
    assert.equal((await confirm(h, { order_ref: order.id, reference: "pi_notmine1234567890", payment_method: pm }, token)).status, 404, "an intent that is not this order's");
    assert.equal((await confirm(h, { order_ref: "ord_unknown", reference: intent.id, payment_method: pm }, token)).status, 404);
    assert.equal((await confirm(h, { order_ref: order.id, reference: intent.id, payment_method: pm }, token)).status, 502, "a payment method the processor does not know");

    // Bob cannot confirm Alice's order even with her intent id. (The component is blocked waiting on the sheet, so end that first.)
    await h.call("/_navigator/prompt/cancel", { id: prompt.id });
    await pending.catch(() => {});
    await h.signOut();
    await h.signInOidc("bob");
    assert.equal((await confirm(h, { order_ref: order.id, reference: intent.id, payment_method: pm }, h.nav.controller.sessionStore.token())).status, 404);
  });
});

// ---- The webhook for intents -----------------------------------------------------------------------------------------

test("card sheet: webhooks for intents are verified like any other, and cannot be used to mark an order paid by mistake", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startCardPurchase(h);
    const order = [...h.payments.orders.values()][0];
    const [intent] = [...h.psp.intents.values()];
    const evt = (type, over = {}) => h.psp.makeEvent(type, { ...intent, status: "succeeded", amount_received: intent.amount, ...over });
    const deliver = (e, o) => h.psp.deliver(e, o);
    const paid = () => order.status === "paid";

    // Wrong signature, wrong amount, someone else's intent, an unknown order, an intent that is not yet succeeded.
    assert.equal((await deliver(evt("payment_intent.succeeded"), { secret: "whsec_wrong" })).status, 400);
    assert.equal((await deliver(evt("payment_intent.succeeded", { amount: 1, amount_received: 1 }))).status, 200);
    assert.equal((await deliver(evt("payment_intent.succeeded", { id: "pi_someoneelse12345678" }))).status, 200);
    assert.equal((await deliver(evt("payment_intent.succeeded", { metadata: { order_id: "ord_nope" } }))).status, 200);
    assert.equal((await deliver(evt("payment_intent.succeeded", { status: "processing" }))).status, 200);
    assert.equal((await deliver(evt("payment_intent.succeeded", { amount_received: 0 }))).status, 200);
    assert.equal(paid(), false, "none of those paid the order");

    // The real thing, then a replay and a late failure: paid once and stays paid.
    const real = evt("payment_intent.succeeded");
    assert.equal((await deliver(real)).status, 200);
    assert.equal(paid(), true);
    assert.equal(h.pro.size, 1);
    await deliver(real);
    await deliver(evt("payment_intent.payment_failed", { status: "requires_payment_method" }));
    assert.equal(paid(), true, "a late failure does not undo a payment");
    assert.equal(h.pro.size, 1, "fulfilled exactly once");
    await h.call("/_navigator/prompt/cancel", { id: prompt.id });
    await pending.catch(() => {});
  });
});

// ---- The host, in isolation ----------------------------------------------------------------------------------------------

test("checkCard: what the host accepts from the form", () => {
  const now = new Date(Date.UTC(2026, 5, 15));
  const ok = (o) => checkCard({ number: "4242424242424242", exp_month: "6", exp_year: "2026", cvc: "123", ...o }, now);
  assert.deepEqual(ok({}).card, { number: "4242424242424242", exp_month: 6, exp_year: 2026, cvc: "123" });
  assert.equal(ok({ number: "4242-4242 4242 4242", exp_year: "26" }).ok, true, "separators and two-digit years");
  assert.equal(ok({ exp_month: "5" }).ok, false, "last month");
  assert.equal(ok({ exp_month: "7" }).ok, true);
  assert.equal(ok({ exp_year: "2025" }).ok, false);
  assert.equal(ok({ exp_year: "2052" }).ok, false, "too far ahead");
  assert.equal(ok({ number: "4242424242424243" }).ok, false, "Luhn");
  assert.equal(ok({ number: "424242424241" }).ok, false, "a 12-digit number that fails Luhn");
  assert.equal(ok({ number: "42".repeat(10) }).ok, false, "too long");
  assert.equal(ok({ cvc: "1234" }).ok, true);
  assert.equal(ok({ cvc: "12" }).ok, false);
  assert.equal(checkCard(null).ok, false);
});

test("host: the reply for a card sheet must carry the manifest's own publishable key and a processor address the handler may use", async () => {
  const manifest = { app: "tasks.localhost", payments: { handlers: ["stripe-card"], merchant: { domain: "tasks.localhost", stripe_publishable_key: "pk_test_mine" }, server: "https://tasks.localhost/pay" } };
  const good = () => ({ handler: "stripe-card", reference: "pi_abc123", publishable_key: "pk_test_mine", api: "https://api.stripe.com", summary: { currency: "USD", total_minor: 100, items: [{ label: "x", amount_minor: 100, quantity: 1 }] } });
  const run = async (reply, { dev = false, m = manifest } = {}) => {
    const msgs = [];
    const prompts = new Prompts({ broadcast: (x) => msgs.push(x), app: { name: "T", domain: "tasks.localhost" }, timeoutMs: 200 });
    const broker = new PaymentBroker({ manifest: m, endpoint: "http://x/pay", session: { token: () => "t" }, uiOrigin: () => "http://x", prompts, dev, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(reply) }) });
    const p = broker.request("ord_1").then(() => "asked", (e) => e.hostError?.val ?? e.hostError?.tag);
    await sleep(20);
    const asked = msgs.some((x) => x.kind === "prompt");
    prompts.dispose();
    await p;
    return asked;
  };
  assert.equal(await run(good()), true);
  for (const [name, reply] of Object.entries({
    "another account's key": { ...good(), publishable_key: "pk_test_evil" },
    "a secret key": { ...good(), publishable_key: "sk_test_x" },
    "the processor on another host": { ...good(), api: "https://evil.example" },
    "a path on the processor's host": { ...good(), api: "https://api.stripe.com/steal" },
    "credentials in the address": { ...good(), api: "https://u:p@api.stripe.com" },
    "plain http": { ...good(), api: "http://api.stripe.com" },
    "loopback outside development": { ...good(), api: "http://127.0.0.1:9" },
    "a reference that is not an intent": { ...good(), reference: "cs_test_abc" },
    "no key": { ...good(), publishable_key: undefined },
  })) assert.equal(await run(reply), false, name);
  assert.equal(await run({ ...good(), api: "http://127.0.0.1:9" }, { dev: true }), true, "loopback is fine in development");
  assert.equal(await run(good(), { m: { ...manifest, payments: { ...manifest.payments, merchant: { domain: "tasks.localhost" } } } }), false, "a manifest with no publishable key cannot use the card sheet");
});

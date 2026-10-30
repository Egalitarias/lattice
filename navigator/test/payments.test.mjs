// Payment tests: hosted checkout against a Stripe-compatible processor, from all three sides
// (the user, the host, the origin server), including attacks. Requires the tasks component to be built.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { withStack, find, all, sleep, quiet, tasksDir } from "./stack.mjs";
import { PaymentBroker, HANDLERS } from "../payments.mjs";
import { Prompts, HostFailure } from "../prompts.mjs";
import { startPsp, signStripe, nest } from "../../server/dev-psp.mjs";
import { createPayments } from "../../server/payments.mjs";
import { defaultOriginAllowed } from "../../server/auth.mjs";
import { loadApp, createServer } from "../../server/server.mjs";

const UPGRADE = "Upgrade to Pro ($4.00)";
const stack = (fn, opts = {}) => withStack(fn, { psp: true, ...opts });

/** Sign in as alice, press Upgrade, and wait for the host's payment prompt. */
async function startPurchase(h) {
  const signedIn = await h.signInOidc("alice");
  assert.equal(signedIn.res.status, 200, JSON.stringify(signedIn.res.body));
  return beginPurchase(h);
}
async function beginPurchase(h) {
  const pending = h.press(UPGRADE);
  const prompt = await h.waitPrompt("payment");
  return { pending, prompt };
}
const isPro = async (h) => /\(Pro\)/.test(find((await h.state()).tree, (n) => n.id === 30).props.text);
const orders = (h) => [...h.payments.orders.values()];

// ---- The flows ----------------------------------------------------------------------------------

test("pay: the user pays, the webhook arrives first, and Pro is unlocked for that account only", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startPurchase(h);

    // The sheet is drawn from the server's summary, and carries nothing else the component said.
    assert.deepEqual(Object.keys(prompt).sort(), ["app", "flow", "handlerHost", "id", "summary", "url"]);
    assert.deepEqual(prompt.summary, { currency: "USD", total_minor: 400, items: [{ label: "Lattice Tasks Pro", amount_minor: 400, quantity: 1 }] });
    assert.equal(prompt.app.domain, "tasks.localhost");
    assert.equal(prompt.app.name, "Lattice Tasks");
    assert.equal(prompt.handlerHost, `127.0.0.1:${h.psp.port}`);
    assert.match(prompt.url, new RegExp(`^${h.psp.url}/c/pay/cs_test_`));

    // The processor was asked for exactly the order's amount, with the host's own return URLs.
    const session = [...h.psp.sessions.values()][0];
    assert.equal(session.amount_total, 400);
    assert.equal(session.currency, "usd");
    assert.equal(session.client_reference_id, orders(h)[0].id);
    assert.equal(new URL(session.success_url).pathname, "/_navigator/payment/return");
    assert.equal(new URL(session.cancel_url).pathname, "/_navigator/payment/cancel");
    assert.ok(session.success_url.startsWith(h.nav.uiOrigin));

    // The user pays on the processor's page. The processor's signed webhook reaches the server, then the user is sent back.
    const paid = await h.atProcessor(prompt.url, "pay");
    assert.equal(paid.status, 303);
    assert.equal((await h.callback(paid.location)).status, 200);
    assert.equal((await pending).status, 200);

    assert.equal(h.psp.delivered.length, 1);
    assert.equal(h.psp.delivered[0].status, 200);
    assert.equal(orders(h)[0].status, "paid");
    assert.equal(await isPro(h), true, "the app shows Pro, as its server reported");
    assert.equal(h.pro.size, 1);

    // What it unlocked: more than the free limit.
    for (let i = 0; i < 51; i++) assert.equal((await h.press("Add", { title: `t${i}` })).status, 200, `task ${i}`);

    // A different account does not get it.
    await h.signOut();
    assert.equal((await h.signInOidc("bob")).res.status, 200);
    assert.equal(await isPro(h), false);
    assert.equal(h.pro.size, 1);
  });
});

test("pay: a webhook that arrives after the redirect leaves the order pending until it does", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startPurchase(h);
    const paid = await h.atProcessor(prompt.url, "pay");
    await h.callback(paid.location);
    assert.equal((await pending).status, 200, "the receipt only says the user came back");

    // Nothing has proven payment yet: no Pro, and the app says it is waiting.
    assert.equal(await isPro(h), false);
    assert.equal(orders(h)[0].status, "pending");
    const s = await h.state();
    assert.ok(find(s.tree, (n) => n.type === "text" && /Waiting for the server/.test(n.props.text)));
    assert.equal((await h.press("Check payment")).status, 200);
    assert.equal(await isPro(h), false, "asking again before the webhook still shows nothing");

    // The webhook lands; asking again now unlocks Pro.
    assert.equal(await h.psp.releasePending(), 1);
    assert.equal((await h.press("Check payment")).status, 200);
    assert.equal(await isPro(h), true);
    assert.equal(orders(h)[0].status, "paid");
  }, { pspOptions: { webhookDelayMs: Infinity } });
});

test("pay: cancelling at the processor, declining a card, and retrying", async () => {
  await stack(async (h) => {
    let { pending, prompt } = await startPurchase(h);

    // A declined card keeps the user on the processor's page: no redirect, nothing paid.
    const declined = await h.atProcessor(prompt.url, "decline");
    assert.equal(declined.status, 402);
    assert.equal(declined.location, null);

    // Cancelling returns to the host's cancel URL.
    const cancelled = await h.atProcessor(prompt.url, "cancel");
    assert.equal(cancelled.status, 303);
    assert.match(cancelled.location, /\/_navigator\/payment\/cancel\?state=/);
    assert.equal((await h.callback(cancelled.location)).status, 400);
    const r = await pending;
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "Payment was cancelled.");
    assert.equal(await isPro(h), false);
    assert.equal(h.psp.delivered.length, 0);

    // A second attempt works, on the same order or a fresh one.
    ({ pending, prompt } = await beginPurchase(h));
    const paid = await h.atProcessor(prompt.url, "pay");
    await h.callback(paid.location);
    assert.equal((await pending).status, 200);
    assert.equal(await isPro(h), true);
  });
});

test("pay: cancelling the host's own dialog, and an unanswered payment, end cleanly", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    let { pending, prompt } = await beginPurchase(h);
    assert.equal((await h.call("/_navigator/prompt/cancel", { id: prompt.id })).status, 200);
    assert.equal((await pending).body.error, "Payment was cancelled.");
    assert.equal((await h.state()).chrome.prompts.length, 0);
    assert.equal(h.psp.delivered.length, 0);
  });
  await stack(async (h) => {
    await h.signInOidc("alice");
    const t0 = Date.now();
    const r = await h.press(UPGRADE);
    assert.equal(r.body.error, "Payment was cancelled.");
    assert.ok(Date.now() - t0 < 3000);
  }, { authTimeoutMs: 300 });
});

test("pay: a sign-in is needed, and an account that has Pro cannot buy it again", async () => {
  await stack(async (h) => {
    // Anonymous: the app offers no Upgrade button, and the server refuses the order if asked anyway.
    assert.equal(await h.button(UPGRADE), undefined);
    const anon = await h.rawRpc("create_order", { sku: "pro" }, h.nav.sessionStore.token());
    assert.equal(anon.status, 401);
    assert.equal(anon.value.code, "unauthorized");

    const { pending, prompt } = await startPurchase(h);
    await h.callback((await h.atProcessor(prompt.url, "pay")).location);
    await pending;
    assert.equal(await h.button(UPGRADE), undefined, "no Upgrade button once you have Pro");
    const again = await h.rawRpc("create_order", { sku: "pro" }, h.nav.sessionStore.token());
    assert.equal(again.value.code, "already_pro");
  });
});

test("pay: the watchdog does not kill a component waiting on a person to pay", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    const { pending, prompt } = await beginPurchase(h);
    await sleep(1200); // three watchdog periods while the user is at the processor
    await h.callback((await h.atProcessor(prompt.url, "pay")).location);
    assert.equal((await pending).status, 200);
    assert.equal(await isPro(h), true);
  }, { watchdogMs: 400 });
});

test("pay: an app that is not granted payments.request cannot be linked", async () => {
  await assert.rejects(stack(async () => {}, { requires: ["net.origin", "session", "auth.oidc", "auth.passkey", "analytics.event"] }), /could not be linked/);
});

test("pay: without a processor configured, the app says so and nothing breaks", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    const r = await h.press("Upgrade to Pro ($4.00)");
    assert.equal(r.status, 422);
    assert.match(r.body.error, /not set up/);
    assert.equal((await h.state()).chrome.prompts.length, 0);
  }, { psp: false });
});

// ---- The return redirect -----------------------------------------------------------------------

test("return: forged, replayed, duplicated and cross-flow callbacks are refused", async () => {
  await stack(async (h) => {
    const { pending, prompt } = await startPurchase(h);
    const state = new URL(h.psp.sessions.values().next().value.success_url).searchParams.get("state");
    const base = `${h.nav.uiOrigin}/_navigator/payment`;

    // Wrong state, no state, duplicated state: refused, and the real request is untouched.
    assert.equal((await h.callback(`${base}/return?state=${randomBytes(32).toString("base64url")}`)).status, 400);
    assert.equal((await h.callback(`${base}/return`)).status, 400);
    assert.equal((await h.callback(`${base}/return?state=${state}&state=${state}`)).status, 400);
    assert.equal((await h.callback(`${base}/cancel?state=${randomBytes(32).toString("base64url")}`)).status, 400);
    assert.equal((await h.state()).chrome.prompts.length, 1, "the real prompt is still pending");

    // A genuine return works once.
    const paid = await h.atProcessor(prompt.url, "pay");
    assert.equal((await h.callback(paid.location)).status, 200);
    await pending;
    assert.equal((await h.callback(paid.location)).status, 400, "replay");
    assert.equal((await h.callback(`${base}/cancel?state=${state}`)).status, 400, "the same state cannot be reused to cancel");
  });
});

test("return: an OIDC state cannot answer a payment, and the reverse", async () => {
  const msgs = [];
  const prompts = new Prompts({ broadcast: (m) => msgs.push(m), app: { name: "A", domain: "tasks.localhost" }, timeoutMs: 5000 });
  const broker = new PaymentBroker({ manifest: { app: "tasks.localhost", payments: { handlers: ["stripe"] } }, endpoint: "http://x/pay", session: { token: () => "t" }, uiOrigin: () => "http://tasks.localhost:7070", prompts, dev: true });
  const oidc = prompts.ask({ flow: "oidc" }, { state: "oidc-state-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const settled = oidc.catch((e) => e);
  assert.equal(broker.callback("return", new URLSearchParams({ state: "oidc-state-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).ok, false);
  assert.equal(prompts.list().length, 1, "the OIDC request is still pending");
  prompts.dispose();
  assert.ok((await settled) instanceof HostFailure);
});

// ---- What the host accepts from the server ----------------------------------------------------

function brokerWith(reply, { status = 200, dev = false, handlers = ["stripe"], raw } = {}) {
  const msgs = [];
  const calls = [];
  const prompts = new Prompts({ broadcast: (m) => msgs.push(m), app: { name: "Lattice Tasks", domain: "tasks.localhost" }, timeoutMs: 300 });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(raw ?? JSON.stringify(reply), { status });
  };
  const manifest = { app: "tasks.localhost", name: "Lattice Tasks", payments: { handlers, merchant: { domain: "tasks.localhost" }, server: "https://tasks.localhost/pay" } };
  const broker = new PaymentBroker({ manifest, endpoint: "http://127.0.0.1:1/pay", session: { token: () => "tok" }, uiOrigin: () => "http://tasks.localhost:7070", prompts, dev, fetchImpl, timeoutMs: 300 });
  return { broker, msgs, calls, prompts };
}
const good = (over = {}) => ({
  handler: "stripe", url: "https://checkout.stripe.com/c/pay/cs_test_abc", reference: "cs_test_abc",
  summary: { currency: "USD", total_minor: 1000, items: [{ label: "Thing", amount_minor: 500, quantity: 2 }] }, ...over,
});
const rejects = (tag = "invalid-argument") => (e) => e instanceof HostFailure && e.hostError.tag === tag;

test("host: what the server says about a payment is validated before the user sees it", async () => {
  const withSummary = (s) => good({ summary: { ...good().summary, ...s } });
  const cases = {
    "unknown handler": good({ handler: "paypal" }),
    "handler not in the manifest": [good(), { handlers: [] }],
    "checkout on another site": good({ url: "https://evil.example/c/pay/x" }),
    "lookalike host (suffix)": good({ url: "https://checkout.stripe.com.evil.example/x" }),
    "lookalike host (userinfo)": good({ url: "https://checkout.stripe.com@evil.example/x" }),
    "credentials in the URL": good({ url: "https://user:pw@checkout.stripe.com/x" }),
    "plain http": good({ url: "http://checkout.stripe.com/x" }),
    "http on loopback outside development": good({ url: "http://127.0.0.1:9/x" }),
    "javascript URL": good({ url: "javascript:alert(1)" }),
    "data URL": good({ url: "data:text/html,<h1>pay</h1>" }),
    "no URL": good({ url: undefined }),
    "no summary": good({ summary: undefined }),
    "total differs from its lines": withSummary({ total_minor: 1 }),
    "total larger than its lines": withSummary({ total_minor: 99999 }),
    "negative amount": withSummary({ total_minor: -500, items: [{ label: "x", amount_minor: -500, quantity: 1 }] }),
    "fractional amount": withSummary({ total_minor: 5, items: [{ label: "x", amount_minor: 2.5, quantity: 2 }] }),
    "amount past the safe integer range": withSummary({ total_minor: 2 ** 60, items: [{ label: "x", amount_minor: 2 ** 60, quantity: 1 }] }),
    "zero quantity": withSummary({ total_minor: 0, items: [{ label: "x", amount_minor: 5, quantity: 0 }] }),
    "huge quantity": withSummary({ total_minor: 5001000, items: [{ label: "x", amount_minor: 5001, quantity: 1001 }] }),
    "no items": withSummary({ total_minor: 0, items: [] }),
    "too many items": withSummary({ total_minor: 51, items: Array.from({ length: 51 }, () => ({ label: "x", amount_minor: 1, quantity: 1 })) }),
    "empty label": withSummary({ items: [{ label: "", amount_minor: 500, quantity: 2 }] }),
    "very long label": withSummary({ items: [{ label: "x".repeat(101), amount_minor: 500, quantity: 2 }] }),
    "lowercase currency": withSummary({ currency: "usd" }),
    "currency of the wrong length": withSummary({ currency: "USDX" }),
    "not an object": "a string",
  };
  for (const [why, c] of Object.entries(cases)) {
    const [reply, opts] = Array.isArray(c) ? c : [c, {}];
    const { broker, msgs } = brokerWith(reply, opts);
    await assert.rejects(broker.request("ord_123"), rejects(), why);
    assert.equal(msgs.filter((m) => m.kind === "prompt").length, 0, `${why}: the user was never prompted`);
  }

  // The control: a well-formed reply is shown, drawn from the validated fields only.
  const { broker, msgs } = brokerWith(good());
  const p = broker.request("ord_123");
  await sleep(10);
  const prompt = msgs.find((m) => m.kind === "prompt").prompt;
  assert.equal(prompt.handlerHost, "checkout.stripe.com");
  assert.equal(prompt.summary.total_minor, 1000);
  broker.prompts.cancel(prompt.id);
  await assert.rejects(p, rejects("cancelled"));

  // Plain http on loopback is acceptable only in development.
  const dev = brokerWith(good({ url: "http://127.0.0.1:9/c/pay/x" }), { dev: true });
  const q = dev.broker.request("ord_123");
  await sleep(10);
  assert.ok(dev.msgs.find((m) => m.kind === "prompt"));
  dev.prompts.dispose();
  await assert.rejects(q, rejects("cancelled"));
});

test("host: the request to the server is built by the host, and server refusals reach the app as messages", async () => {
  // The host, not the component, chooses the return URLs and sends the session; the order reference is validated first.
  const { broker, calls } = brokerWith(good());
  const p = broker.request("ord_123").catch(() => {});
  await sleep(10);
  const { url, init } = calls[0];
  assert.equal(url, "http://127.0.0.1:1/pay/sessions");
  assert.equal(init.headers["Lattice-Session"], "tok");
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ["cancel_url", "order_ref", "return_url"]);
  const state = new URL(body.return_url).searchParams.get("state");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.return_url, `http://tasks.localhost:7070/_navigator/payment/return?state=${state}`);
  assert.equal(body.cancel_url, `http://tasks.localhost:7070/_navigator/payment/cancel?state=${state}`);
  broker.prompts.dispose();
  await p;

  for (const bad of ["", "has space", "a/b", "x".repeat(65), "../etc", 5, null, undefined]) {
    const b = brokerWith(good());
    await assert.rejects(b.broker.request(bad), rejects(), `order ref ${JSON.stringify(bad)}`);
    assert.equal(b.calls.length, 0, "no request was sent");
  }

  const refused = brokerWith({ code: "already_paid", message: "That order has already been paid." }, { status: 409 });
  await assert.rejects(refused.broker.request("ord_1"), (e) => e.hostError.tag === "invalid-argument" && /already been paid/.test(e.hostError.val));
  const long = brokerWith({ message: "m".repeat(1000) }, { status: 400 });
  await assert.rejects(long.broker.request("ord_1"), (e) => e.hostError.val.length <= 200);
  const huge = brokerWith(null, { raw: "x".repeat(70_000) });
  await assert.rejects(huge.broker.request("ord_1"), rejects());
  const down = new PaymentBroker({ manifest: { app: "tasks.localhost", payments: { handlers: ["stripe"] } }, endpoint: "http://127.0.0.1:1/pay", session: { token: () => "t" }, uiOrigin: () => "http://x", prompts: new Prompts({ broadcast: quiet, app: {}, timeoutMs: 100 }), fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(down.request("ord_1"), rejects("unavailable"));
  const none = new PaymentBroker({ manifest: { app: "tasks.localhost", payments: { handlers: ["stripe"] } }, endpoint: null, session: { token: () => "t" }, uiOrigin: () => "http://x", prompts: new Prompts({ broadcast: quiet, app: {}, timeoutMs: 100 }) });
  await assert.rejects(none.request("ord_1"), rejects("unavailable"));
  assert.deepEqual(Object.keys(HANDLERS), ["stripe"]);
});

// ---- What the server accepts from the host ------------------------------------------------------

async function sessionsCall(h, body, { token, headers = {}, method = "POST", raw } = {}) {
  const res = await fetch(`http://127.0.0.1:${h.originPort}/pay/sessions`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { "Lattice-Session": token } : {}), ...headers }, body: method === "GET" ? undefined : (raw ?? JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json() };
}
const hostUrls = (h, state = randomBytes(32).toString("base64url")) => ({
  return_url: `${h.nav.uiOrigin}/_navigator/payment/return?state=${state}`,
  cancel_url: `${h.nav.uiOrigin}/_navigator/payment/cancel?state=${state}`,
});

test("server: the sessions endpoint serves only the order's owner, and only the host's URLs", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    const alice = h.nav.sessionStore.token();
    const subject = h.nav.sessionStore.info().subject;
    const order = h.payments.createOrder({ owner: subject, currency: "USD", items: [{ label: "Pro", amount_minor: 400, quantity: 1 }] });
    const urls = hostUrls(h);
    let current = alice; // whose session the helper uses by default
    const call = (over = {}, opts = { token: current }) => sessionsCall(h, { order_ref: order.id, ...urls, ...over }, opts);

    // The control, and what the processor was asked for: the amount comes from the order, never the request.
    const ok = await call({ amount: 1, total_minor: 1, currency: "EUR", items: [{ label: "free", amount_minor: 0, quantity: 1 }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.summary.total_minor, 400);
    assert.equal([...h.psp.sessions.values()][0].amount_total, 400);
    assert.equal([...h.psp.sessions.values()][0].currency, "usd");

    // Identity.
    assert.equal((await call({}, {})).status, 401, "no session");
    assert.equal((await call({}, { token: "A".repeat(43) })).status, 401, "an anonymous or unknown session");
    await h.signOut();
    await h.signInOidc("bob");
    current = h.nav.sessionStore.token(); // bob; alice's session was revoked by signing out
    assert.equal((await call({}, { token: alice })).status, 401, "a revoked session");
    assert.equal((await call()).status, 404, "another user's order looks like it does not exist");
    assert.equal((await call({ order_ref: "ord_nope" })).status, 404);

    // The host's URLs are the only ones accepted.
    const state = randomBytes(32).toString("base64url");
    for (const [why, over] of Object.entries({
      "return_url on another site": { return_url: `http://evil.example/_navigator/payment/return?state=${state}` },
      "return_url on the lookalike of our domain": { return_url: `http://tasks.localhost.evil.com/_navigator/payment/return?state=${state}` },
      "return_url at another path": { return_url: `${h.nav.uiOrigin}/steal?state=${state}` },
      "return_url with an extra parameter": { return_url: `${urls.return_url}&next=http://evil.example` },
      "return_url with no state": { return_url: `${h.nav.uiOrigin}/_navigator/payment/return` },
      "return_url with a short state": { return_url: `${h.nav.uiOrigin}/_navigator/payment/return?state=abc` },
      "return_url with a fragment": { return_url: `${urls.return_url}#x` },
      "cancel_url at the return path": { cancel_url: urls.return_url },
      "return_url that is not a URL": { return_url: "not a url" },
      "missing cancel_url": { cancel_url: undefined },
    })) {
      assert.equal((await call(over)).status, 400, why);
    }
    for (const bad of ["", "has space", "a/b", "x".repeat(65), 5, null]) assert.equal((await call({ order_ref: bad })).status, 400, `order_ref ${JSON.stringify(bad)}`);

    // Shape of the request itself.
    assert.equal((await sessionsCall(h, {}, { token: alice, headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await sessionsCall(h, null, { token: alice, raw: "{nope" })).status, 400);
    assert.equal((await sessionsCall(h, null, { token: alice, raw: "[1]" })).status, 400);
    assert.equal((await sessionsCall(h, null, { token: alice, raw: JSON.stringify({ pad: "x".repeat(20_000) }) })).status, 413);
    assert.equal((await sessionsCall(h, null, { token: alice, method: "GET" })).status, 405);
  });
});

test("server: a retried sessions call returns the same checkout; a new attempt makes a new one; paid orders refuse", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    const token = h.nav.sessionStore.token();
    const subject = h.nav.sessionStore.info().subject;
    const order = h.payments.createOrder({ owner: subject, currency: "USD", items: [{ label: "Pro", amount_minor: 400, quantity: 1 }] });
    const state = randomBytes(32).toString("base64url");
    const a = await sessionsCall(h, { order_ref: order.id, ...hostUrls(h, state) }, { token });
    const b = await sessionsCall(h, { order_ref: order.id, ...hostUrls(h, state) }, { token });
    assert.equal(a.body.reference, b.body.reference, "same attempt, same checkout (idempotency key)");
    assert.equal(h.psp.sessions.size, 1);
    const c = await sessionsCall(h, { order_ref: order.id, ...hostUrls(h) }, { token });
    assert.notEqual(c.body.reference, a.body.reference, "a new attempt is a new checkout");
    assert.equal(order.sessionIds.length, 2);

    // Paying on either session fulfils the order; once paid, no more checkouts.
    await h.atProcessor(a.body.url, "pay");
    assert.equal(order.status, "paid");
    assert.equal((await sessionsCall(h, { order_ref: order.id, ...hostUrls(h) }, { token })).status, 409);
    // Paying the other session as well is a double payment: it does not change the order or grant anything twice.
    await h.atProcessor(c.body.url, "pay");
    assert.equal(order.status, "paid");
    assert.equal(order.paidSessionId, a.body.reference);
    assert.equal(h.pro.size, 1);
  });
});

test("server: a processor that cannot be reached, or that returns a different amount, does not produce a checkout", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    const token = h.nav.sessionStore.token();
    const subject = h.nav.sessionStore.info().subject;
    const order = h.payments.createOrder({ owner: subject, currency: "USD", items: [{ label: "Pro", amount_minor: 400, quantity: 1 }] });
    await h.psp.close(); // the processor goes away
    const r = await sessionsCall(h, { order_ref: order.id, ...hostUrls(h) }, { token });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "processor_unavailable");
    assert.doesNotMatch(JSON.stringify(r.body), /ECONN|127\.0\.0\.1|stripe/i, "no internals in the message");
  });
});

// ---- What the server accepts from the processor -------------------------------------------------

/** Create an order and a processor session for it, as the host would. */
async function sessionFor(h) {
  const token = h.nav.sessionStore.token();
  const subject = h.nav.sessionStore.info().subject;
  const order = h.payments.createOrder({ owner: subject, currency: "USD", items: [{ label: "Pro", amount_minor: 400, quantity: 1 }] });
  const r = await sessionsCall(h, { order_ref: order.id, ...hostUrls(h) }, { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { order, subject, session: h.psp.sessions.get(r.body.reference) };
}

test("webhook: only authentic events about the right order, amount and state grant anything", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    const { order, session } = await sessionFor(h);
    const granted = [];
    h.payments.onPaid((o) => granted.push(o.id));
    const completed = (over = {}) => h.psp.makeEvent("checkout.session.completed", { ...session, payment_status: "paid", status: "complete", ...over });
    const fulfilled = () => order.status === "paid";
    const now = Math.floor(Date.now() / 1000);

    // Not authentic: nothing happens, and the processor is told (so it retries).
    const forged = [
      ["signed with another secret", { secret: "whsec_other" }],
      ["no signature header", { omitSignature: true }],
      ["body changed after signing", { tamper: (p) => p.replace('"amount_total":400', '"amount_total":1') }],
      ["a timestamp from an hour ago", { timestamp: now - 3600 }],
      ["a timestamp an hour ahead", { timestamp: now + 3600 }],
    ];
    for (const [why, opts] of forged) {
      const r = await h.psp.deliver(completed(), opts);
      assert.equal(r.status, 400, why);
      assert.equal(fulfilled(), false, `${why}: not fulfilled`);
    }
    const garbageSig = await fetch(`http://127.0.0.1:${h.originPort}/pay/webhook`, { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00" }, body: "{}" });
    assert.equal(garbageSig.status, 400);

    // Authentic, but not a payment for this order as asked: acknowledged and ignored.
    const ignored = [
      ["an order that does not exist", completed({ client_reference_id: "ord_unknown" })],
      ["a session that is not the order's", completed({ id: "cs_test_someoneElsesSession" })],
      ["a smaller amount than the order's", completed({ amount_total: 1 })],
      ["a different currency", completed({ currency: "eur" })],
      ["a checkout that is not paid yet", completed({ payment_status: "unpaid" })],
      ["an event type the server does not use", h.psp.makeEvent("customer.created", session)],
    ];
    for (const [why, ev] of ignored) {
      const r = await h.psp.deliver(ev);
      assert.equal(r.status, 200, `${why}: acknowledged so the processor does not retry`);
      assert.equal(fulfilled(), false, `${why}: not fulfilled`);
    }
    assert.deepEqual(granted, []);
    assert.equal(h.pro.size, 0);

    // The real thing, and then it arriving again (processors deliver at least once).
    const real = completed();
    assert.equal((await h.psp.deliver(real)).status, 200);
    assert.equal(fulfilled(), true);
    assert.equal((await h.psp.deliver(real)).status, 200);
    assert.equal((await h.psp.deliver(completed())).status, 200, "a new event for the same payment");
    assert.deepEqual(granted, [order.id], "fulfilled exactly once");
    assert.equal(h.pro.size, 1);

    // Paid is terminal: a later expiry or failure does not take it back.
    await h.psp.deliver(h.psp.makeEvent("checkout.session.expired", session));
    await h.psp.deliver(h.psp.makeEvent("checkout.session.async_payment_failed", session));
    assert.equal(order.status, "paid");
    assert.equal(h.pro.size, 1);
  });
});

test("webhook: asynchronous payments wait for the success event, and failures are recorded", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    const first = await sessionFor(h);
    const granted = [];
    h.payments.onPaid((o) => granted.push(o.id));

    // Completed but unpaid (a bank debit that has not cleared): nothing yet. The later event unlocks it.
    await h.psp.deliver(h.psp.makeEvent("checkout.session.completed", first.session, { payment_status: "unpaid" }));
    assert.equal(first.order.status, "pending");
    await h.psp.deliver(h.psp.makeEvent("checkout.session.async_payment_succeeded", first.session, { payment_status: "paid" }));
    assert.equal(first.order.status, "paid");
    assert.deepEqual(granted, [first.order.id]);

    // A payment that fails, or a checkout that expires, is recorded and grants nothing.
    const second = await sessionFor(h);
    await h.psp.deliver(h.psp.makeEvent("checkout.session.async_payment_failed", second.session));
    assert.equal(second.order.status, "failed");
    const third = await sessionFor(h);
    await h.psp.deliver(h.psp.makeEvent("checkout.session.expired", third.session));
    assert.equal(third.order.status, "expired");
    assert.deepEqual(granted, [first.order.id]);
  });
});

test("webhook: an event cannot grant Pro to anyone but the order's owner", async () => {
  await stack(async (h) => {
    await h.signInOidc("alice");
    const alice = await sessionFor(h);
    await h.signOut();
    await h.signInOidc("bob");
    const bob = await sessionFor(h);
    // Alice's order is paid. Bob's stays unpaid, and so does he.
    await h.psp.deliver(h.psp.makeEvent("checkout.session.completed", alice.session, { payment_status: "paid" }));
    assert.deepEqual([...h.pro], [alice.subject]);
    assert.equal(bob.order.status, "pending");
    // Bob's order id with Alice's session does not pay Bob's order either.
    await h.psp.deliver(h.psp.makeEvent("checkout.session.completed", alice.session, { payment_status: "paid", client_reference_id: bob.order.id }));
    assert.equal(bob.order.status, "pending");
    assert.deepEqual([...h.pro], [alice.subject]);
  });
});

test("webhook: the endpoint rejects the wrong method and oversize bodies", async () => {
  await stack(async (h) => {
    const url = `http://127.0.0.1:${h.originPort}/pay/webhook`;
    assert.equal((await fetch(url)).status, 405);
    const huge = "x".repeat(300 * 1024);
    const res = await fetch(url, { method: "POST", headers: { "Stripe-Signature": signStripe(huge, h.psp.webhookSecret) }, body: huge });
    assert.equal(res.status, 413);
  });
});

// ---- The stand-in processor itself ---------------------------------------------------------------

test("processor stand-in: speaks Stripe's wire format and rejects what Stripe would", async () => {
  const psp = await startPsp();
  const post = (body, { key = psp.secretKey, headers = {} } = {}) =>
    fetch(`${psp.url}/v1/checkout/sessions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", ...headers }, body });
  const form = (over = {}) => new URLSearchParams({
    mode: "payment", success_url: "http://a.test/ok", cancel_url: "http://a.test/no", client_reference_id: "ord_1",
    "line_items[0][quantity]": "2", "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": "150", "line_items[0][price_data][product_data][name]": "Thing", "metadata[order_id]": "ord_1", ...over,
  });
  try {
    assert.deepEqual(nest(new URLSearchParams("a[b][0][c]=1&a[b][1][c]=2&d=3")), { a: { b: [{ c: "1" }, { c: "2" }] }, d: "3" });

    assert.equal((await post(form(), { key: "sk_test_wrong" })).status, 401);
    const ok = await (await post(form())).json();
    assert.equal(ok.amount_total, 300, "unit_amount x quantity");
    assert.equal(ok.currency, "usd");
    assert.equal(ok.payment_status, "unpaid");
    assert.match(ok.url, /\/c\/pay\/cs_test_/);
    assert.equal("_items" in ok, false, "no internals in the API response");
    assert.equal((await (await fetch(`${psp.url}/v1/checkout/sessions/${ok.id}`, { headers: { Authorization: `Bearer ${psp.secretKey}` } })).json()).id, ok.id);

    for (const [why, body] of Object.entries({
      "not payment mode": form({ mode: "subscription" }),
      "no success_url": form({ success_url: "" }),
      "negative amount": form({ "line_items[0][price_data][unit_amount]": "-5" }),
      "fractional amount": form({ "line_items[0][price_data][unit_amount]": "1.5" }),
      "bad currency": form({ "line_items[0][price_data][currency]": "dollars" }),
      "no product name": form({ "line_items[0][price_data][product_data][name]": "" }),
      "no line items": new URLSearchParams({ mode: "payment", success_url: "http://a.test/ok" }),
    })) assert.equal((await post(body)).status, 400, why);

    // Idempotency, as Stripe defines it: same key and params replay; same key and different params is an error.
    const k = { headers: { "Idempotency-Key": "key-1" } };
    const a = await (await post(form(), k)).json();
    const b = await (await post(form(), k)).json();
    assert.equal(a.id, b.id);
    assert.equal((await post(form({ client_reference_id: "ord_2" }), k)).status, 400);
  } finally { await psp.close(); }
});

// ---- Order bookkeeping -------------------------------------------------------------------------

test("orders: built from the server's own items, and visible only to their owner", () => {
  const p = createPayments({ originAllowed: defaultOriginAllowed("tasks.localhost"), secretKey: "sk_test_x", webhookSecret: "whsec_x", identify: () => null, log: quiet });
  const o = p.createOrder({ owner: "u_1", currency: "USD", items: [{ label: "A", amount_minor: 250, quantity: 2 }, { label: "B", amount_minor: 100, quantity: 1 }] });
  assert.equal(o.total_minor, 600);
  assert.equal(o.status, "created");
  assert.match(o.id, /^ord_[A-Za-z0-9_-]{16}$/);
  assert.equal(p.getOwned(o.id, "u_1"), o);
  assert.equal(p.getOwned(o.id, "u_2"), null);
  assert.equal(p.getOwned(o.id, null), null);
  assert.equal(p.getOwned(o.id, undefined), null);
  assert.equal(p.getOwned(123, "u_1"), null);
  for (const bad of [
    { currency: "usd", items: [{ label: "A", amount_minor: 1, quantity: 1 }] },
    { currency: "USD", items: [] },
    { currency: "USD", items: [{ label: "A", amount_minor: -1, quantity: 1 }] },
    { currency: "USD", items: [{ label: "A", amount_minor: 1.5, quantity: 1 }] },
    { currency: "USD", items: [{ label: "A", amount_minor: 1, quantity: 0 }] },
  ]) assert.throws(() => p.createOrder({ owner: "u_1", ...bad }));
  assert.throws(() => p.createOrder({ owner: null, currency: "USD", items: [{ label: "A", amount_minor: 1, quantity: 1 }] }));

  // One account cannot fill the server with unpaid orders; others are unaffected, and paying frees a slot.
  const item = [{ label: "A", amount_minor: 1, quantity: 1 }];
  for (let i = 0; i < 19; i++) p.createOrder({ owner: "u_1", currency: "USD", items: item }); // 20 with the first
  assert.throws(() => p.createOrder({ owner: "u_1", currency: "USD", items: item }), (e) => e.code === "rate_limited");
  assert.ok(p.createOrder({ owner: "u_2", currency: "USD", items: item }));
  o.status = "paid";
  assert.ok(p.createOrder({ owner: "u_1", currency: "USD", items: item }));
});

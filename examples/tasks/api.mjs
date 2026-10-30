// Server-side handlers for the Tasks API (see api.json). State is in memory.
//
// Tasks belong to whoever the session token resolves to: a signed-in user (passkey or OIDC), or,
// before sign-in, the anonymous token the host generated. Signing in does not migrate anonymous
// tasks: that is an app decision, and this one keeps them separate.

import { ApiError } from "../../server/rpc.mjs";
import { createAuth, defaultOriginAllowed } from "../../server/auth.mjs";
import { createPayments } from "../../server/payments.mjs";

const MAX_TASKS = 50;
const MAX_TASKS_PRO = 200;
const PRO_PRICE = { currency: "USD", amount_minor: 400, label: "Lattice Tasks Pro" };

export async function setup({ manifest, oidc, dev, stripe, log }) {
  const auth = createAuth({ rpId: manifest.app, rpName: manifest.name ?? manifest.app, oidc, allowInsecureIssuers: dev, log });
  const accounts = new Map(); // "user:<subject>" | "anon:<token>" -> { tasks, nextId }
  const pro = new Set(); // subjects with Pro: granted only by a verified payment webhook

  // Payments are optional: without a processor key the app still runs and says so when asked to buy.
  let payments = null;
  if (stripe?.secretKey && manifest.payments?.server) {
    payments = createPayments({
      originAllowed: defaultOriginAllowed(manifest.app),
      secretKey: stripe.secretKey,
      webhookSecret: stripe.webhookSecret,
      api: stripe.api,
      identify: (token) => auth.identify(token),
      log,
    });
    payments.onPaid((order) => pro.add(order.owner)); // the only place Pro is granted
  }

  function account(ctx) {
    if (!ctx.session) throw new ApiError("unauthorized", "No session. Is the session capability granted?");
    const who = auth.identify(ctx.session);
    const key = who ? `user:${who.subject}` : `anon:${ctx.session}`;
    let a = accounts.get(key);
    if (!a) accounts.set(key, (a = { tasks: [], nextId: 1 }));
    return a;
  }

  const find = (a, id) => {
    const t = a.tasks.find((t) => t.id === id);
    if (!t) throw new ApiError("task_not_found", `No task with id ${id}.`);
    return t;
  };

  const handlers = {
    async list_tasks(_req, ctx) {
      return { tasks: account(ctx).tasks.map((t) => ({ ...t })) };
    },

    async add_task({ title }, ctx) {
      const a = account(ctx);
      const who = auth.identify(ctx.session);
      const trimmed = title.trim();
      if (!trimmed) throw new ApiError("title_blank", "Enter something to do first.");
      const limit = who && pro.has(who.subject) ? MAX_TASKS_PRO : MAX_TASKS;
      if (a.tasks.length >= limit) throw new ApiError("too_many_tasks", `You can have at most ${limit} tasks.`);
      const task = { id: a.nextId++, title: trimmed, done: false };
      a.tasks.push(task);
      return { task: { ...task } };
    },

    async set_done({ id, done }, ctx) {
      const t = find(account(ctx), id);
      t.done = done;
      return { task: { ...t } };
    },

    async delete_task({ id }, ctx) {
      const a = account(ctx);
      find(a, id);
      a.tasks = a.tasks.filter((t) => t.id !== id);
      return {};
    },

    async profile(_req, ctx) {
      const who = auth.identify(ctx.session);
      return { signed_in: !!who, name: who?.name ?? "", pro: !!who && pro.has(who.subject) };
    },

    // ---- Payments: the server names the price; the host takes the payment; the webhook grants Pro ----
    async create_order({ sku }, ctx) {
      if (!payments) throw new ApiError("payments_unavailable", "Payments are not set up on this server.");
      const who = auth.identify(ctx.session);
      if (!who) throw new ApiError("unauthorized", "Sign in to upgrade.");
      if (pro.has(who.subject)) throw new ApiError("already_pro", "You already have Pro.");
      if (sku !== "pro") throw new ApiError("invalid_request", "unknown sku");
      const order = payments.createOrder({
        owner: who.subject,
        currency: PRO_PRICE.currency,
        items: [{ label: PRO_PRICE.label, amount_minor: PRO_PRICE.amount_minor, quantity: 1 }],
      });
      return { order_ref: order.id };
    },

    async order_status({ order_ref }, ctx) {
      const who = auth.identify(ctx.session);
      const order = payments && who ? payments.getOwned(order_ref, who.subject) : null;
      if (!order) throw new ApiError("order_not_found", "No such order.");
      return { status: order.status };
    },

    passkey_register_begin: (req) => auth.passkey.registerBegin(req),
    passkey_register_finish: (req, ctx) => auth.passkey.registerFinish(req, ctx),
    passkey_login_begin: () => auth.passkey.loginBegin(),
    passkey_login_finish: (req, ctx) => auth.passkey.loginFinish(req, ctx),
  };

  const http = {};
  if (manifest.auth?.token_endpoint) http[new URL(manifest.auth.token_endpoint).pathname] = auth.tokenEndpoint;
  if (payments) {
    const base = new URL(manifest.payments.server).pathname.replace(/\/$/, "");
    http[`${base}/sessions`] = payments.sessionsEndpoint;
    http[`${base}/webhook`] = payments.webhookEndpoint;
  }
  return { handlers, http, auth, payments, pro };
}

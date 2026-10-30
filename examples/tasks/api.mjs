// Server-side handlers for the Tasks API (see api.json). State is in memory.
//
// Tasks belong to whoever the session token resolves to: a signed-in user (passkey or OIDC), or,
// before sign-in, the anonymous token the host generated. Signing in does not migrate anonymous
// tasks: that is an app decision, and this one keeps them separate.

import { ApiError } from "../../server/rpc.mjs";
import { createAuth } from "../../server/auth.mjs";

const MAX_TASKS = 50;

export async function setup({ manifest, oidc, dev, log }) {
  const auth = createAuth({ rpId: manifest.app, rpName: manifest.name ?? manifest.app, oidc, allowInsecureIssuers: dev, log });
  const accounts = new Map(); // "user:<subject>" | "anon:<token>" -> { tasks, nextId }

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
      const trimmed = title.trim();
      if (!trimmed) throw new ApiError("title_blank", "Enter something to do first.");
      if (a.tasks.length >= MAX_TASKS) throw new ApiError("too_many_tasks", `You can have at most ${MAX_TASKS} tasks.`);
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
      return { signed_in: !!who, name: who?.name ?? "" };
    },

    passkey_register_begin: (req) => auth.passkey.registerBegin(req),
    passkey_register_finish: (req, ctx) => auth.passkey.registerFinish(req, ctx),
    passkey_login_begin: () => auth.passkey.loginBegin(),
    passkey_login_finish: (req, ctx) => auth.passkey.loginFinish(req, ctx),
  };

  const http = {};
  if (manifest.auth?.token_endpoint) http[new URL(manifest.auth.token_endpoint).pathname] = auth.tokenEndpoint;
  return { handlers, http, auth };
}

// Server-side handlers for the Tasks API (see api.json). State is in memory, per session.
// A real origin would persist this and authenticate; the session here is an anonymous,
// host-generated token, so "my tasks" means "tasks created by this Lattice Navigator profile".

import { ApiError } from "../../server/rpc.mjs";

const MAX_TASKS = 50;
const accounts = new Map(); // session token -> { tasks: Task[], nextId }

function account(ctx) {
  if (!ctx.session) throw new ApiError("unauthorized", "No session. Is the session capability granted?");
  let a = accounts.get(ctx.session);
  if (!a) accounts.set(ctx.session, (a = { tasks: [], nextId: 1 }));
  return a;
}

const find = (a, id) => {
  const t = a.tasks.find((t) => t.id === id);
  if (!t) throw new ApiError("task_not_found", `No task with id ${id}.`);
  return t;
};

export const handlers = {
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
};

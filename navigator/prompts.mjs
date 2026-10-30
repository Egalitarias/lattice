// Interactions that need the user: the host asks, a window shows a host-drawn dialog, and the answer
// comes back later (a redirect, a passkey result, a cancel). Sign-in and payments share this.
//
// Each pending interaction is single-use and expires. Nothing outside the host can create one.

import { randomUUID } from "node:crypto";

/** A failure the app may see: carries a WIT `host-error` value. */
export class HostFailure extends Error {
  constructor(tag, val) {
    super(val ? `${tag}: ${val}` : tag);
    this.hostError = val === undefined ? { tag } : { tag, val };
  }
}
export const fail = (tag, val) => new HostFailure(tag, val);

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class Prompts {
  #pending = new Map(); // id -> { prompt, resolve, reject, timer, ...extra }

  /**
   * @param broadcast  (message) => void, to every open Navigator window
   * @param app        { name, domain } the app on whose behalf the user is being asked
   */
  constructor({ broadcast, app, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    Object.assign(this, { broadcast, app, timeoutMs });
  }

  /** Show `prompt` to the user and wait. `extra` is private to the host (never sent to a window). */
  ask(prompt, extra = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, "reject", fail("cancelled")), extra.timeoutMs ?? this.timeoutMs);
      const full = { id, app: this.app, ...prompt };
      this.#pending.set(id, { prompt: full, resolve, reject, timer, ...extra });
      this.broadcast({ kind: "prompt", prompt: full });
    });
  }

  /** Finish an interaction exactly once. Returns false if it was already finished or never existed. */
  settle(id, how, value) {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    this.broadcast({ kind: "prompt-end", id });
    p[how](value);
    return true;
  }

  get(id) {
    return this.#pending.get(id);
  }

  /** The pending interaction of this flow that was bound to `state` (a redirect's single-use value). */
  byState(flow, state) {
    if (typeof state !== "string" || !state) return undefined;
    return [...this.#pending.values()].find((p) => p.state === state && p.prompt.flow === flow);
  }

  /** Public view, for a window that connects mid-flow. */
  list() {
    return [...this.#pending.values()].map((p) => p.prompt);
  }

  cancel(id) {
    return this.settle(id, "reject", fail("cancelled"));
  }

  dispose() {
    for (const id of [...this.#pending.keys()]) this.cancel(id);
  }
}

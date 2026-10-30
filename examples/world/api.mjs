// Server side of the World API (see api.json). One shared grid, in memory. A player is whoever holds a session token.
//
// This is the part a real app would scale out: every change is published once on the `world` topic, and the
// host delivers it to every subscribed client.

import { ApiError } from "../../server/rpc.mjs";

const WIDTH = 12;
const HEIGHT = 8;
const IDLE_MS = 5 * 60_000;
const MAX_PLAYERS = 200;
const ADJECTIVES = ["Quick", "Quiet", "Brave", "Gentle", "Bright", "Calm", "Eager", "Merry"];
const ANIMALS = ["Otter", "Heron", "Fox", "Lynx", "Wren", "Hare", "Newt", "Crane"];

export async function setup({ topics, log }) {
  const players = new Map(); // session token -> { id, name, x, y, seen }
  let nextId = 1;

  const picture = () => ({ players: [...players.values()].map(({ id, name, x, y }) => ({ id, name, x, y })) });
  const publish = () => topics.publish("world", picture());
  const session = (ctx) => {
    if (!ctx.session) throw new ApiError("unauthorized", "No session. Is the session capability granted?");
    return ctx.session;
  };
  const free = () => {
    for (let i = 0; i < 100; i++) {
      const x = Math.floor(Math.random() * WIDTH), y = Math.floor(Math.random() * HEIGHT);
      if (![...players.values()].some((p) => p.x === x && p.y === y)) return { x, y };
    }
    return { x: 0, y: 0 };
  };

  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    let changed = false;
    for (const [token, p] of players) if (p.seen < cutoff) { players.delete(token); changed = true; }
    if (changed) publish();
  }, 30_000);
  sweep.unref();

  return {
    // Anyone with a session may watch. The first thing a new subscriber gets is the current picture.
    authorizeTopic(topic, ctx) {
      session(ctx);
      return { snapshot: picture() };
    },
    handlers: {
      async join(_req, ctx) {
        const token = session(ctx);
        let p = players.get(token);
        if (!p) {
          if (players.size >= MAX_PLAYERS) throw new ApiError("rate_limited", "The world is full.");
          const id = nextId++;
          p = { id, name: `${ADJECTIVES[id % ADJECTIVES.length]} ${ANIMALS[(id * 3) % ANIMALS.length]}`, ...free(), seen: Date.now() };
          players.set(token, p);
          log?.(`world: ${p.name} joined`);
        }
        p.seen = Date.now();
        publish();
        return { id: p.id, width: WIDTH, height: HEIGHT };
      },
      async move({ dx, dy }, ctx) {
        const p = players.get(session(ctx));
        if (!p) throw new ApiError("not_found", "Join the world first.");
        const x = Math.min(WIDTH - 1, Math.max(0, p.x + dx)), y = Math.min(HEIGHT - 1, Math.max(0, p.y + dy));
        p.seen = Date.now();
        if (![...players.values()].some((q) => q !== p && q.x === x && q.y === y) && (x !== p.x || y !== p.y)) {
          p.x = x;
          p.y = y;
          publish();
        }
        return {};
      },
      async leave(_req, ctx) {
        if (players.delete(session(ctx))) publish();
        return {};
      },
    },
  };
}

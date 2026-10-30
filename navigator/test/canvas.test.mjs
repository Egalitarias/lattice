// The 2D canvas: what the host accepts as a drawing, and what a canvas may send back. Requires the world component built.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer } from "../../server/server.mjs";
import { startNavigator } from "../navigator.mjs";
import { checkDrawing, SceneError, MAX_DRAW_OPS, MAX_DRAW_TEXT } from "../scene.mjs";
import { SHARED_CACHE, listen, close, sleep, quiet, find } from "./stack.mjs";

const worldDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "world");

const rect = (o = {}) => ({ tag: "rect", val: { x: 0, y: 0, w: 10, h: 10, tone: "accent", outline: false, ...o } });
const text = (o = {}) => ({ tag: "text", val: { x: 5, y: 5, text: "hi", size: 8, tone: "default", ...o } });
const drawing = (ops, extra = {}) => ({ width: 100, height: 50, ops, ...extra });
const refuses = (d, re) => assert.throws(() => checkDrawing(1, d), (e) => e instanceof SceneError && re.test(e.message));

test("drawing: a normal display list is accepted", () => {
  checkDrawing(1, drawing([rect(), text(), { tag: "ellipse", val: { cx: 1, cy: 1, rx: 2, ry: 2, tone: "positive", outline: true } }, { tag: "line", val: { x1: 0, y1: 0, x2: 9, y2: 9, tone: "muted", width: 1 } }]));
  checkDrawing(1, drawing([]));
});

test("drawing: sizes, counts, numbers and text are bounded", () => {
  for (const bad of [0, -1, 2049, 1.5, NaN]) {
    refuses(drawing([], { width: bad }), /width must be 1 to 2048/);
    refuses(drawing([], { height: bad }), /height must be 1 to 2048/);
  }
  checkDrawing(1, drawing(Array.from({ length: MAX_DRAW_OPS }, () => rect())));
  refuses(drawing(Array.from({ length: MAX_DRAW_OPS + 1 }, () => rect())), /at most 2000/);
  for (const bad of [NaN, Infinity, -Infinity, 100_001, -100_001]) refuses(drawing([rect({ x: bad })]), /not a number in range/);
  refuses(drawing([text({ text: "x".repeat(MAX_DRAW_TEXT + 1) })]), /longer than 120/);
  checkDrawing(1, drawing([text({ text: "x".repeat(MAX_DRAW_TEXT) })]));
  refuses(drawing([text({ size: 0 })]), /empty-sized/);
  refuses(drawing([{ tag: "line", val: { x1: 0, y1: 0, x2: 1, y2: 1, tone: "muted", width: -1 } }]), /negative/);
  refuses(drawing([{ tag: "image", val: {} }]), /unknown drawing operation/);
});

// ---- Input -------------------------------------------------------------------------------------------

async function inWorld(fn) {
  const app = await loadApp({ appDir: worldDir, dev: true, log: quiet });
  const server = createServer(app);
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), "nav-canvas-"));
  const nav = await startNavigator({ cacheDir: SHARED_CACHE, url: `http://127.0.0.1:${port}/`, dev: true, port: 0, dataDir: dir, log: quiet });
  const state = () => fetch(`http://127.0.0.1:${nav.port}/_navigator/state`).then((r) => r.json());
  const send = async (source, event, values) => {
    const r = await fetch(`http://127.0.0.1:${nav.port}/_navigator/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Navigator": "1", Host: `world.localhost:${nav.port}` },
      body: JSON.stringify({ source, event, values }),
    });
    return r.status;
  };
  const where = async () => (find((await state()).tree, (n) => /online/.test(n.props?.text ?? "")).props.text.match(/column (\d+), row (\d+)/) ?? []).slice(1).join(",");
  try {
    const tree = (await state()).tree;
    await fn({ canvas: find(tree, (n) => n.type === "canvas"), send, where });
  } finally {
    await nav.close();
    app.topics.close();
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("canvas: the host paints a drawing it was given and exposes an accessible name and description", async () => {
  await inWorld(async ({ canvas }) => {
    assert.equal(canvas.props.label, "The world");
    assert.match(canvas.props.description, /arrow keys/);
    assert.equal(canvas.props.drawing.width, 480);
    assert.equal(canvas.props.onInput, true, "the UI learns that input exists, not the action behind it");
    assert.ok(!("action" in canvas.props));
  });
});

test("canvas: only pointer positions and a few keys are accepted from it, and only as fields it may send", async () => {
  await inWorld(async ({ canvas, send }) => {
    const id = canvas.id;
    for (const bad of [
      {}, { kind: "other" }, { kind: "key" }, { kind: "key", key: "a" }, { kind: "key", key: "Escape" }, { kind: "key", key: "ArrowUp", x: 1 },
      { kind: "pointer" }, { kind: "pointer", x: 1 }, { kind: "pointer", x: "1", y: 2 }, { kind: "pointer", x: 1e9, y: 0 }, { kind: "pointer", x: 1, y: 2, key: "ArrowUp" },
      { kind: "pointer", x: 1, y: 2, extra: "field" },
    ]) {
      assert.equal(await send(id, "input", bad), 400, JSON.stringify(bad));
      await sleep(30);
    }
    assert.equal(await send(id, "input", { kind: "key", key: "ArrowUp" }), 200);
  });
});

test("canvas: keys and clicks move the player, and a burst of input is answered without an error", async () => {
  await inWorld(async ({ canvas, send, where }) => {
    const start = await where();
    // Any arrow that does not hit an edge changes the position; try them until one does.
    let moved = false;
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) {
      await send(canvas.id, "input", { kind: "key", key });
      await sleep(60);
      if ((await where()) !== start) { moved = true; break; }
    }
    assert.ok(moved, "an arrow key moved the player");

    const here = (await where()).split(",").map(Number);
    await sleep(60);
    // A click two squares to the right of the player steps one square right.
    const target = here[0] + 2 <= 12 ? 2 : -2;
    await send(canvas.id, "input", { kind: "pointer", x: (here[0] - 1 + target + 0.5) * 40, y: (here[1] - 1 + 0.5) * 40 });
    await sleep(60);
    assert.deepEqual((await where()).split(",").map(Number), [here[0] + Math.sign(target), here[1]], "a click steps toward the square");

    // A burst: the second arrives inside the minimum gap and is dropped quietly.
    const [a, b] = await Promise.all([send(canvas.id, "input", { kind: "key", key: "ArrowDown" }), send(canvas.id, "input", { kind: "key", key: "ArrowDown" })]);
    assert.deepEqual([a, b], [200, 200]);
  });
});

// Pixel surfaces (spec/capabilities.md, `gpu.surface`): the host's limits on what an app may create and present, and the
// whole path with a real component that paints a plasma. Requires the surface component built (examples/surface).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp, createServer } from "../../server/server.mjs";
import { startNavigator } from "../navigator.mjs";
import { Surfaces, MAX_SURFACES, MAX_SIDE, MAX_PIXELS, MAX_PRESENTS_PER_SECOND } from "../surface.mjs";
import { SceneStore, SceneError } from "../scene.mjs";
import { SHARED_CACHE, listen, close, sleep, quiet, find } from "./stack.mjs";

const surfaceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "surface");
const text = (r) => new TextDecoder().decode(r.bytes);
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  return false;
};

// ---- The store ---------------------------------------------------------------------------------------------------

test("surfaces: sizes are bounded, handles are unguessable, and an app holds at most two", () => {
  const s = new Surfaces();
  for (const [w, h] of [[0, 1], [1, 0], [-1, 5], [MAX_SIDE + 1, 1], [1, MAX_SIDE + 1], [1.5, 2], [NaN, 2], ["4", 4], [1024, 1024]]) {
    const r = s.create(w, h);
    assert.equal(r.ok, false, `${w} x ${h}`);
    assert.equal(r.error.tag, "invalid-argument");
  }
  assert.ok(1024 * 768 === MAX_PIXELS && s.create(1024, 768).ok, "the largest allowed");
  const a = s.create(2, 2);
  assert.match(text(a), /^srf_[0-9a-f]{24}$/);
  assert.equal(s.create(1, 1).ok, false, "the third is refused");
  assert.equal(s.size, MAX_SURFACES);
  assert.equal(s.create(1, 1).error.tag, "rate-limited");
  s.destroy(text(a));
  assert.ok(s.create(1, 1).ok, "room again after destroy");
});

test("surfaces: a frame is exactly width x height x 4 bytes, for a surface that exists", () => {
  const s = new Surfaces();
  const h = text(s.create(3, 2));
  for (const bad of [new Uint8Array(23), new Uint8Array(25), new Uint8Array(0), [1, 2, 3], "x", null, new Uint16Array(24)]) {
    assert.equal(s.present(h, bad).ok, false);
  }
  assert.equal(s.present("srf_nope", new Uint8Array(24)).error.tag, "invalid-argument");
  assert.equal(s.present(7, new Uint8Array(24)).error.tag, "invalid-argument");
  assert.equal(s.frame(h).seq, 0, "nothing shown yet");
  assert.equal(s.present(h, new Uint8Array(24).fill(9)).ok, true);
  assert.deepEqual({ ...s.frame(h), pixels: [...s.frame(h).pixels].slice(0, 3) }, { width: 3, height: 2, seq: 1, pixels: [9, 9, 9] });
  assert.deepEqual(s.info(h), { width: 3, height: 2 });
  assert.equal(s.info("srf_nope"), undefined);
  assert.equal(s.frame("srf_nope"), null);
});

test("surfaces: presenting is limited to about 30 frames a second, with a short burst, and recovers", () => {
  let t = 0;
  const frames = [];
  const s = new Surfaces({ now: () => t, onFrame: (h, seq) => frames.push(seq) });
  const h = text(s.create(1, 1));
  const px = new Uint8Array(4);
  let accepted = 0;
  for (let i = 0; i < 100; i++) if (s.present(h, px).ok) accepted++;
  assert.ok(accepted >= 5 && accepted <= 8, `a burst of ${accepted}`);
  assert.equal(s.present(h, px).error.tag, "rate-limited");
  t += 1000; // a second later
  accepted = 0;
  for (let i = 0; i < 100; i++) if (s.present(h, px).ok) accepted++;
  assert.ok(accepted >= MAX_PRESENTS_PER_SECOND / 5 && accepted <= 8, "a second's worth is only the burst again, not 30 at once");
  // At a steady 30 a second, nothing is refused.
  t += 1000;
  for (let i = 0; i < 6; i++) s.present(h, px);
  let refused = 0;
  for (let i = 0; i < 60; i++) { t += 36; if (!s.present(h, px).ok) refused++; }
  assert.equal(refused, 0);
  assert.equal(frames.at(-1), frames.length, "every accepted frame was announced once, in order");
});

test("surfaces: they go with the app, and a scene can only name one the app holds", () => {
  const s = new Surfaces();
  const h = text(s.create(8, 4));
  const canvas = (extra) => ({ id: 1, common: {}, children: [], body: { tag: "canvas", val: { label: "c", description: "d", surface: undefined, drawing: undefined, onInput: undefined, ...extra } } });
  const scene = (c) => ({ title: "t", lang: "en", live: undefined, root: 1, nodes: [c] });
  const make = (extra) => { const st = new SceneStore(); st.surfaces = s; st.load(scene(canvas(extra))); return st; };
  assert.deepEqual(make({ surface: h }).tree().props.surface, { handle: h, width: 8, height: 4 }, "the window is told the handle and the size");
  assert.throws(() => make({ surface: "srf_000000000000000000000000" }), (e) => e instanceof SceneError && /no such surface/.test(e.message));
  assert.throws(() => make({ surface: h, drawing: { width: 1, height: 1, ops: [] } }), (e) => e instanceof SceneError && /not both/.test(e.message));
  s.reset();
  assert.equal(s.size, 0);
  assert.throws(() => make({ surface: h }), (e) => e instanceof SceneError && /no such surface/.test(e.message), "gone with the app");
});

// ---- A real app ------------------------------------------------------------------------------------------------

async function inPlasma(fn) {
  const app = await loadApp({ appDir: surfaceDir, dev: true, log: quiet });
  const server = createServer(app);
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), "nav-surface-"));
  const nav = await startNavigator({ cacheDir: SHARED_CACHE, url: `http://127.0.0.1:${port}/`, dev: true, port: 0, dataDir: dir, log: quiet });
  const base = `http://127.0.0.1:${nav.port}/_navigator`;
  const post = (endpoint, body) => fetch(`${base}/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Navigator": "1", Host: `surface.localhost:${nav.port}` }, body: JSON.stringify(body) });
  const canvas = async () => find((await fetch(`${base}/state`).then((r) => r.json())).tree, (n) => n.type === "canvas");
  const frame = async (handle) => {
    const r = await fetch(`${base}/surface/${encodeURIComponent(handle)}`);
    return r.ok ? { seq: Number(r.headers.get("x-seq")), width: Number(r.headers.get("x-width")), height: Number(r.headers.get("x-height")), pixels: new Uint8Array(await r.arrayBuffer()) } : { status: r.status };
  };
  try {
    await fn({ nav, base, post, canvas, frame });
  } finally {
    await nav.close();
    rmSync(dir, { recursive: true, force: true });
    await close(server);
  }
}

test("plasma: the canvas names a surface the app made, the window can fetch its pixels, and asking for a frame makes the app paint the next", async () => {
  await inPlasma(async ({ canvas, frame, post, nav }) => {
    const c = await canvas();
    assert.equal(c.props.drawing, undefined);
    const { handle, width, height } = c.props.surface;
    assert.match(handle, /^srf_[0-9a-f]{24}$/);
    assert.deepEqual([width, height], [160, 100]);

    const first = await frame(handle);
    assert.equal(first.pixels.length, 160 * 100 * 4);
    assert.equal(first.seq, 1, "the app painted a first picture before any frame was asked for");
    assert.ok(first.pixels.some((b) => b !== 0));
    assert.ok([...first.pixels.keys()].filter((i) => i % 4 === 3).every((i) => first.pixels[i] === 255), "opaque");

    const messages = [];
    const events = await fetch(`http://127.0.0.1:${nav.port}/_navigator/events`);
    const reader = events.body.getReader();
    (async () => { for (;;) { const r = await reader.read().catch(() => ({ done: true })); if (r.done) return; messages.push(new TextDecoder().decode(r.value)); } })();

    assert.equal((await post("frame", { handle })).status, 200);
    assert.ok(await until(async () => (await frame(handle)).seq >= 2), "the app painted again");
    const second = await frame(handle);
    assert.notDeepEqual(second.pixels, first.pixels, "a different picture");
    assert.ok(messages.join("").includes(`"kind":"surface","handle":"${handle}"`), "the window was told there was a new frame");
    reader.cancel().catch(() => {});
  });
});

test("plasma: frames are asked for at most about thirty times a second, and a click changes the picture", async () => {
  await inPlasma(async ({ canvas, frame, post }) => {
    const { handle } = (await canvas()).props.surface;
    const start = (await frame(handle)).seq;
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) { await post("frame", { handle }); await sleep(1); }
    const painted = (await frame(handle)).seq - start;
    assert.ok(painted >= 5 && painted <= 40, `${painted} frames in a second`);

    const before = (await frame(handle)).pixels;
    const nodeId = (await canvas()).id;
    const r = await post("act", { source: nodeId, event: "input", values: { kind: "pointer", x: 40, y: 30 } });
    assert.equal(r.status, 200);
    await sleep(60);
    await post("frame", { handle });
    assert.ok(await until(async () => Buffer.compare(Buffer.from((await frame(handle)).pixels), Buffer.from(before)) !== 0));
  });
});

test("plasma: a handle that is not the app's is refused everywhere", async () => {
  await inPlasma(async ({ frame, post, base }) => {
    for (const bad of ["srf_000000000000000000000000", "nope", "../state", ""]) {
      assert.equal((await post("frame", { handle: bad })).status, 404, `frame ${bad}`);
      if (bad) assert.equal((await frame(bad)).status, 404, `fetch ${bad}`);
    }
    assert.equal((await post("frame", { handle: 7 })).status, 404);
    assert.equal((await post("frame", {})).status, 404);
    // The frame endpoint is for the window: it needs the custom header, like every other POST.
    const r = await fetch(`${base}/frame`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "x" }) });
    assert.equal(r.status, 403);
  });
});

test("surfaces: nothing an app passes can make the host throw, and only exact frames are ever kept", () => {
  let seed = 99;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const junk = [undefined, null, true, "", "srf_", "x".repeat(10_000), -1, 0, 1, 2, 3.5, NaN, Infinity, 2 ** 31, 2 ** 53, [], {}, [1], new Uint8Array(0), new Uint8Array(7), new Uint8Array(16), new ArrayBuffer(16), "__proto__", "constructor"];
  let now = 0;
  const s = new Surfaces({ now: () => (now += 40) });
  const handles = [];
  for (let i = 0; i < 3000; i++) {
    const op = Math.floor(rnd() * 4);
    let r;
    if (op === 0) { r = s.create(pick(junk), pick(junk)); if (r.ok) handles.push(text(r)); }
    else if (op === 1) r = s.present(pick([...junk, ...handles]), pick(junk));
    else if (op === 2) r = s.destroy(pick([...junk, ...handles]));
    else { s.info(pick(junk)); s.frame(pick(junk)); continue; }
    assert.ok(r.ok === true || (r.ok === false && typeof r.error.tag === "string"));
    assert.ok(s.size <= MAX_SURFACES);
  }
  for (const h of handles) {
    const f = s.frame(h);
    if (f) assert.equal(f.pixels.length, f.width * f.height * 4, "a frame that was kept has exactly the right size");
  }
});

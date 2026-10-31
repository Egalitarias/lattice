// Pixel surfaces (spec/capabilities.md, `gpu.surface`): a rectangle of pixels the app paints and the host shows.
//
// The app creates a surface, paints into its own memory, and hands the host whole frames; a `canvas` node names the
// surface and the host composites its latest frame in the window. The app never touches the display and cannot draw
// outside the canvas, over the host's own chrome, or at any rate the host does not allow.
//
// Portable (no Node APIs), so the Node and browser Navigators share it.

export const MAX_SURFACES = 2;
export const MAX_SIDE = 1024;
export const MAX_PIXELS = 1024 * 768;
export const MAX_PRESENTS_PER_SECOND = 30;
const BURST = 6;
const enc = new TextEncoder();

const hostErr = (tag, val) => ({ ok: false, error: val === undefined ? { tag } : { tag, val } });
const randomHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export class Surfaces {
  #surfaces = new Map(); // handle -> { width, height, seq, pixels }
  #tokens = BURST;
  #last;

  /** @param onFrame (handle, seq) => void; a new frame can be fetched with frame(). */
  constructor({ onFrame = () => {}, now = () => performance.now() } = {}) {
    Object.assign(this, { onFrame, now });
    this.#last = now();
  }

  get size() {
    return this.#surfaces.size;
  }

  /** Results are in the shape of a host call: { ok: true, bytes } or { ok: false, error: <host-error> }. */
  create(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
      return hostErr("invalid-argument", `a surface is 1 to ${MAX_SIDE} pixels on a side and at most ${MAX_PIXELS} pixels in all`);
    }
    if (this.#surfaces.size >= MAX_SURFACES) return hostErr("rate-limited");
    const handle = `srf_${randomHex(12)}`;
    this.#surfaces.set(handle, { width, height, seq: 0, pixels: new Uint8Array(width * height * 4) });
    return { ok: true, bytes: enc.encode(handle) };
  }

  /** Replace the surface's pixels with one frame: RGBA, 8 bits each, rows from the top. */
  present(handle, pixels) {
    const s = typeof handle === "string" ? this.#surfaces.get(handle) : undefined;
    if (!s) return hostErr("invalid-argument", "no such surface");
    if (!(pixels instanceof Uint8Array) || pixels.length !== s.width * s.height * 4) return hostErr("invalid-argument", `a frame for this surface is ${s.width * s.height * 4} bytes (${s.width} x ${s.height} RGBA)`);
    const t = this.now();
    this.#tokens = Math.min(BURST, this.#tokens + ((t - this.#last) / 1000) * MAX_PRESENTS_PER_SECOND);
    this.#last = t;
    if (this.#tokens < 1) return hostErr("rate-limited");
    this.#tokens -= 1;
    s.pixels = pixels;
    s.seq++;
    this.onFrame(handle, s.seq);
    return { ok: true, bytes: new Uint8Array() };
  }

  destroy(handle) {
    this.#surfaces.delete(handle);
    return { ok: true, bytes: new Uint8Array() };
  }

  /** { width, height } of a live surface, or undefined. */
  info(handle) {
    const s = typeof handle === "string" ? this.#surfaces.get(handle) : undefined;
    return s && { width: s.width, height: s.height };
  }

  /** The latest frame, or null. `seq` is 0 until the app has presented one. */
  frame(handle) {
    const s = typeof handle === "string" ? this.#surfaces.get(handle) : undefined;
    return s ? { width: s.width, height: s.height, seq: s.seq, pixels: s.pixels } : null;
  }

  /** The app stopped: its surfaces go with it. */
  reset() {
    this.#surfaces.clear();
  }
}

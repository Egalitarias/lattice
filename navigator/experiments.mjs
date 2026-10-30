// A/B experiments (spec/experiments.md). The manifest declares them; the host assigns a variant, remembers it on
// this device, tells the app only its own variant, and records an exposure through analytics, which applies the
// user's level. The user can opt out, which puts them in the control for everything.
//
// Assignment uses no identifier and no server: a weighted draw from the system's secure random source, made once and
// stored in the profile. It therefore cannot be linked across apps, and a reset or new profile is a new draw.

import { getJson, setJson } from "./kv.mjs";

export class ExperimentError extends Error {}

const draw = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

export class Experiments {
  #exposed = new Set();

  /**
   * @param random  () => number in [0, 1); injectable for tests
   */
  constructor({ manifest, kv, domain, analytics = null, random = draw }) {
    this.defs = new Map();
    for (const e of manifest.experiments ?? []) {
      if (this.defs.has(e.name)) throw new ExperimentError(`experiment "${e.name}" is declared twice`);
      const names = new Set(e.variants.map((v) => v.name));
      if (names.size !== e.variants.length) throw new ExperimentError(`experiment "${e.name}" repeats a variant name`);
      this.defs.set(e.name, e);
    }
    Object.assign(this, { kv, key: `experiments/${domain}`, analytics, random });
  }

  #read() {
    const s = getJson(this.kv, this.key);
    return { optOut: s?.optOut === true, assigned: s && typeof s.assigned === "object" && s.assigned ? s.assigned : {} };
  }

  /** The first variant listed is the control. */
  control(name) {
    return this.defs.get(name)?.variants[0].name;
  }

  /** The variant this user is in, or undefined if there is no such experiment. Records the exposure once per run. */
  variant(name) {
    const def = this.defs.get(name);
    if (!def) return undefined;
    const saved = this.#read();
    if (saved.optOut) return def.variants[0].name;

    let v = saved.assigned[name];
    if (!def.variants.some((x) => x.name === v)) {
      // Never assigned, or the manifest no longer has the variant: draw again.
      const total = def.variants.reduce((n, x) => n + x.weight, 0);
      let r = this.random() * total;
      v = def.variants.find((x) => (r -= x.weight) < 0)?.name ?? def.variants.at(-1).name;
      setJson(this.kv, this.key, { optOut: false, assigned: { ...saved.assigned, [name]: v } });
    }
    if (!this.#exposed.has(name)) {
      this.#exposed.add(name);
      this.analytics?.host("product", "host.experiment", { experiment: name, variant: v });
    }
    return v;
  }

  setOptOut(optOut) {
    setJson(this.kv, this.key, { ...this.#read(), optOut: !!optOut });
    this.#exposed.clear();
  }

  /** What the user is shown: every experiment, their variant if any, and whether they have opted out. */
  snapshot() {
    const saved = this.#read();
    return {
      optOut: saved.optOut,
      list: [...this.defs.values()].map((e) => ({
        name: e.name,
        description: e.description ?? "",
        variants: e.variants.map((v) => v.name),
        yours: saved.optOut ? e.variants[0].name : (saved.assigned[e.name] ?? null),
      })),
    };
  }
}

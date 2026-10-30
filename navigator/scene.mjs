// Holds the current scene (a WIT arena as produced by jco), applies updates, enforces the
// host-side scene rules from spec/wit/README.md, and projects the arena to a plain nested tree
// for the UI.

export class SceneError extends Error {}

const LEAF = new Set(["heading", "text", "link", "button", "input", "select", "checkbox", "image", "media", "canvas", "ad-slot"]);
const CONTAINER_ONE = new Set(["scroll"]);
// Action-ref carrying fields on each body type.
const ACTION_FIELDS = ["onPress", "onSubmit", "onChange", "onEnd", "onSort", "onRowPress", "onInput", "onReward"];

const num = (v) => (typeof v === "bigint" ? Number(v) : v);

export function scalar(s) {
  switch (s.tag) {
    case "null": return null;
    case "integer": return num(s.val);
    default: return s.val;
  }
}

export const argsObject = (list) => Object.fromEntries(list.map(([k, v]) => [k, scalar(v)]));

/** JS value -> WIT scalar. Integers become s64, other numbers f64. */
export function toScalar(v) {
  if (v === null || v === undefined) return { tag: "null" };
  if (typeof v === "boolean") return { tag: "boolean", val: v };
  if (typeof v === "number") return Number.isInteger(v) ? { tag: "integer", val: BigInt(v) } : { tag: "number", val: v };
  if (typeof v === "string") return { tag: "text", val: v };
  throw new SceneError(`unsupported value type ${typeof v}`);
}

export const toArgs = (obj) => Object.entries(obj).map(([k, v]) => [k, toScalar(v)]);

export class SceneStore {
  #nodes = new Map(); // id -> node (as received)
  #rev = new Map(); // id -> revision, bumped whenever the node is (re)set
  #tick = 0;
  title = "";
  lang = undefined;
  live = undefined;
  root = undefined;

  load(scene) {
    const nodes = new Map();
    for (const n of scene.nodes) {
      if (nodes.has(n.id)) throw new SceneError(`duplicate node id ${n.id}`);
      nodes.set(n.id, n);
    }
    const prev = [this.#nodes, this.#rev];
    this.#nodes = nodes;
    this.#rev = new Map([...nodes.keys()].map((id) => [id, ++this.#tick]));
    const before = [this.title, this.lang, this.live, this.root];
    this.title = scene.title;
    this.lang = scene.lang;
    this.live = scene.live;
    this.root = scene.root;
    try {
      this.tree();
    } catch (e) {
      [this.#nodes, this.#rev] = prev;
      [this.title, this.lang, this.live, this.root] = before;
      throw e;
    }
  }

  /** Atomic: either every op applies and the result is a valid tree, or nothing changes. */
  apply(update) {
    const nodes = new Map(this.#nodes);
    const rev = new Map(this.#rev);
    let { title, lang, live, root } = this;
    for (const op of update.ops) {
      switch (op.tag) {
        case "set-node":
          nodes.set(op.val.id, op.val);
          rev.set(op.val.id, ++this.#tick);
          break;
        case "remove-node":
          nodes.delete(op.val);
          rev.delete(op.val);
          break;
        case "set-root": root = op.val; break;
        case "set-title": title = op.val; break;
        case "set-live": live = op.val; break;
      }
    }
    const next = new SceneStore();
    Object.assign(next, { title, lang, live, root });
    next.#nodes = nodes;
    next.#rev = rev;
    const tree = next.tree(); // throws if the result is invalid

    // Commit, dropping nodes no longer reachable.
    const reachable = new Set();
    (function walk(t) { reachable.add(t.id); t.children.forEach(walk); })(tree);
    for (const id of [...nodes.keys()]) if (!reachable.has(id)) { nodes.delete(id); rev.delete(id); }
    this.#nodes = nodes;
    this.#rev = rev;
    Object.assign(this, { title, lang, live, root });
  }

  get(id) { return this.#nodes.get(id); }

  /** Nested tree, validated. */
  tree() {
    if (this.root === undefined || !this.#nodes.has(this.root)) throw new SceneError(`root ${this.root} does not exist`);
    const seen = new Set();
    const build = (id) => {
      const n = this.#nodes.get(id);
      if (!n) throw new SceneError(`node ${id} is referenced but not defined`);
      if (seen.has(id)) throw new SceneError(`node ${id} appears more than once (not a tree)`);
      seen.add(id);
      const type = n.body.tag;
      if (LEAF.has(type) && n.children.length) throw new SceneError(`${type} node ${id} cannot have children`);
      if (CONTAINER_ONE.has(type) && n.children.length !== 1) throw new SceneError(`scroll node ${id} needs exactly one child`);
      this.#check(n);
      return {
        id,
        rev: this.#rev.get(id),
        type,
        props: this.#props(n.body),
        common: this.#common(n.common),
        children: Array.from(n.children, build),
      };
    };
    return build(this.root);
  }

  #check(n) {
    const v = n.body.val;
    switch (n.body.tag) {
      case "image":
        if (!v.alt && !v.decorative) throw new SceneError(`image ${n.id} needs alt text (or decorative = true)`);
        break;
      case "heading":
        if (v.level < 1 || v.level > 6) throw new SceneError(`heading ${n.id} level must be 1-6`);
        break;
      case "table":
        for (const row of v.rows) {
          if (row.length !== v.columns.length) throw new SceneError(`table ${n.id} row has ${row.length} cells for ${v.columns.length} columns`);
        }
        break;
    }
    for (const f of ACTION_FIELDS) {
      const a = v?.[f];
      if (a && !/^[a-z][a-z0-9_]*$/.test(a.action)) throw new SceneError(`node ${n.id}: invalid action name`);
    }
  }

  #common(c) {
    const out = {};
    if (c.hidden) out.hidden = true;
    for (const k of ["width", "height", "padding", "tone", "label", "description", "lang"]) {
      if (c[k] !== undefined) out[k] = c[k];
    }
    return out;
  }

  #props(body) {
    const v = body.val ?? {};
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (ACTION_FIELDS.includes(k)) out[k] = true; // the UI only learns *that* an action exists; Lattice Navigator keeps the ref
      else if (k === "rows") out.rows = val.map((r) => r.map(scalar));
      else if (k === "props") out.props = argsObject(val);
      else if (typeof val === "bigint") out[k] = Number(val);
      else out[k] = val;
    }
    return out;
  }

  /** The action reference attached to `field` of node `id`, as typed WIT values. */
  actionRef(id, field) {
    return this.#nodes.get(id)?.body.val?.[field];
  }

  /** Names of the form fields under the Form that contains `id` (or under `id` itself if a Form). */
  formFields(id) {
    const parentOf = new Map();
    for (const n of this.#nodes.values()) for (const c of n.children) parentOf.set(c, n.id);
    let cur = id;
    while (cur !== undefined && this.#nodes.get(cur)?.body.tag !== "form") cur = parentOf.get(cur);
    if (cur === undefined) return new Set();
    const names = new Set();
    (function walk(nid, self) {
      const n = self.#nodes.get(nid);
      if (["input", "select", "checkbox"].includes(n.body.tag)) names.add(n.body.val.name);
      n.children.forEach((c) => walk(c, self));
    })(cur, this);
    return names;
  }
}

// Lattice Navigator renderer. Receives a validated scene tree from Lattice Navigator and projects it onto semantic elements.
// It never evaluates app-provided strings as markup (everything is textContent / attributes), and
// it sends back only {source node id, event, field values}. Lattice Navigator decides what action that means.
//
// It talks to the Navigator through a *transport*, so the same renderer serves both builds:
//   - Node: HTTP + server-sent events to the local Navigator process (ui-http.js)
//   - browser: direct calls into the in-page controller (browser/main.mjs)
//
//   transport.post(endpoint, body) -> Promise<{ ok: true } | { ok: false, error }>
//   transport.subscribe(handler)   -> handler receives each message (scene, notice, prompt, chrome, ...)
//   transport.state()              -> Promise<the current state message>

const appEl = document.getElementById("app");
const noticeEl = document.getElementById("notice");

/** id -> { el, rev, type } for every element currently in the document. */
const live = new Map();
let currentPath = null;
let noticeTimer;

// ---- Talking to Lattice Navigator --------------------------------------------------------------------------

let transport;

async function post(endpoint, body) {
  const r = await transport.post(endpoint, body);
  if (!r.ok) notice(r.error ?? "Something went wrong.");
}

function notice(message) {
  noticeEl.textContent = message;
  noticeEl.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (noticeEl.hidden = true), 6000);
}

const act = (source, event, values = {}) => post("act", { source, event, values });

function navigate(path, { push = true } = {}) {
  if (push && path !== location.pathname + location.search) history.pushState(null, "", path);
  return post("route", { path });
}

// ---- Form values ------------------------------------------------------------------------------

function fieldValue(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.type === "number" && el.value !== "") return Number(el.value);
  return el.value;
}

/** Values of all named controls in the form containing `el`, or just `el` if not in a form. */
function collect(el) {
  const form = el.closest("form");
  const out = {};
  for (const f of (form ?? el).querySelectorAll("[data-field]")) out[f.dataset.field] = fieldValue(f);
  return out;
}

// ---- Element construction ---------------------------------------------------------------------

const h = (tag, attrs = {}, text) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
  if (text !== undefined) el.textContent = text;
  return el;
};

const LANDMARK = {
  banner: ["header", {}], navigation: ["nav", {}], main: ["main", {}], complementary: ["aside", {}],
  contentinfo: ["footer", {}], search: ["div", { role: "search" }], dialog: ["div", { role: "dialog", "aria-modal": "true" }],
  alert: ["div", { role: "alert" }], status: ["div", { role: "status" }],
};

const safeHttps = (u) => typeof u === "string" && /^https:\/\//.test(u);

/** Returns { el, slot } where slot is the element that receives children (defaults to el). */
function shell(n) {
  const p = n.props;
  switch (n.type) {
    case "stack":
      return { el: h("div", { class: "stack", "data-axis": p.axis, "data-gap": p.gap, "data-align": p.align, "data-justify": p.justify, "data-wrap": String(!!p.wrap) }) };
    case "grid": {
      const el = h("div", { class: "grid", "data-gap": p.gap });
      const cols = p.columns;
      el.style.gridTemplateColumns = cols.tag === "fixed" ? `repeat(${cols.val}, 1fr)` : `repeat(auto-fit, minmax(${cols.val}rem, 1fr))`;
      return { el };
    }
    case "scroll": return { el: h("div", { class: "scroll", "data-axis": p.axis, tabindex: "0" }) };
    case "layer": return { el: h("div", { class: "layer" }) };
    case "region": {
      const [tag, attrs] = LANDMARK[p.role];
      return { el: h(tag, { ...attrs, "aria-label": p.label }) };
    }
    case "heading": return { el: h(`h${p.level}`, {}, p.text) };
    case "text": {
      const tag = p.style === "quote" ? "blockquote" : p.style === "code" ? "code" : "p";
      const el = h(tag, { class: `text-${p.style}` });
      const inner = p.emphasis === "strong" ? h("strong", {}, p.text) : p.emphasis === "em" ? h("em", {}, p.text) : document.createTextNode(p.text);
      el.append(inner);
      if (p.maxLines) { el.style.display = "-webkit-box"; el.style.webkitLineClamp = String(p.maxLines); el.style.webkitBoxOrient = "vertical"; el.style.overflow = "hidden"; }
      if (!p.selectable) el.style.userSelect = "none";
      return { el };
    }
    case "link": {
      const external = !p.target.startsWith("/");
      const a = h("a", { href: p.target, "aria-label": p.text && p.text !== p.label ? p.label : undefined }, p.text ?? p.label);
      if (external) { a.rel = "noopener noreferrer"; a.target = "_blank"; }
      else a.addEventListener("click", (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(p.target);
      });
      return { el: a };
    }
    case "button": {
      const b = h("button", { type: "button", "aria-label": p.text && p.text !== p.label ? p.label : undefined, "data-emphasis": p.emphasis, disabled: p.disabled }, p.text ?? p.label);
      b.addEventListener("click", () => act(n.id, "press", collect(b)));
      return { el: b };
    }
    case "form": {
      const f = h("form", { class: "stack", "data-axis": "vertical", "data-gap": "sm", "aria-label": p.label, novalidate: true });
      f.addEventListener("submit", (e) => { e.preventDefault(); act(n.id, "submit", collect(f)); });
      f.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); act(n.id, "submit", collect(f)); }
      });
      return { el: f };
    }
    case "input": {
      const id = `f${n.id}`;
      const wrap = h("div", { class: "field" });
      const label = h("label", { for: id }, p.label);
      const multiline = p.kind === "multiline";
      const inputType = { text: "text", email: "email", tel: "tel", url: "url", number: "number", password: "password", date: "date", time: "time", search: "search", "one-time-code": "text" }[p.kind];
      const input = multiline ? h("textarea", { rows: "4" }) : h("input", { type: inputType });
      Object.entries({
        id, name: p.name, "data-field": p.name, placeholder: p.placeholder, required: p.required,
        autocomplete: p.autocomplete ?? (p.kind === "one-time-code" ? "one-time-code" : undefined),
        maxlength: p.maxLength, min: p.min, max: p.max, "data-sensitive": p.sensitive,
        "aria-describedby": n.common.description ? `${id}-d` : undefined,
      }).forEach(([k, v]) => v !== undefined && v !== false && input.setAttribute(k, v === true ? "" : String(v)));
      if (p.value !== undefined) input.value = p.value;
      if (p.onChange) input.addEventListener("change", () => act(n.id, "change", { [p.name]: fieldValue(input) }));
      wrap.append(label, input);
      return { el: wrap };
    }
    case "select": {
      const id = `f${n.id}`;
      const wrap = h("div", { class: "field" });
      const sel = h("select", { id, name: p.name, "data-field": p.name, required: p.required });
      for (const o of p.options) sel.append(h("option", { value: o.value }, o.text));
      if (p.value !== undefined) sel.value = p.value;
      if (p.onChange) sel.addEventListener("change", () => act(n.id, "change", { [p.name]: sel.value }));
      wrap.append(h("label", { for: id }, p.label), sel);
      return { el: wrap };
    }
    case "checkbox": {
      const label = h("label", { class: "check" });
      const box = h("input", { type: "checkbox", name: p.name, "data-field": p.name });
      box.checked = p.checked;
      if (p.onChange) box.addEventListener("change", () => act(n.id, "change", { [p.name]: box.checked }));
      label.append(box, document.createTextNode(p.label));
      return { el: label };
    }
    case "item-list": return { el: h(p.ordered ? "ol" : "ul") };
    case "table": {
      const t = h("table");
      t.append(h("caption", {}, p.label));
      const head = h("tr");
      p.columns.forEach((c) => head.append(h("th", { scope: "col", "data-cell-align": c.align }, c.title)));
      t.append(h("thead")).firstChild.append(head);
      const body = h("tbody");
      p.rows.forEach((row) => {
        const tr = h("tr");
        row.forEach((cell, i) => tr.append(h("td", { "data-cell-align": p.columns[i].align }, cell === null ? "" : String(cell))));
        body.append(tr);
      });
      t.append(body);
      return { el: t };
    }
    case "image": {
      if (safeHttps(p.src)) {
        const img = h("img", { src: p.src, alt: p.decorative ? "" : p.alt, referrerpolicy: "no-referrer", loading: "lazy" });
        if (p.decorative) img.setAttribute("role", "presentation");
        return { el: img };
      }
      return { el: h("div", { class: "placeholder", role: "img", "aria-label": p.alt }, p.alt) };
    }
    case "media": {
      if (safeHttps(p.src)) {
        const m = h(p.kind, { src: p.src, "aria-label": p.label, controls: p.controls });
        return { el: m };
      }
      return { el: h("div", { class: "placeholder" }, p.label) };
    }
    case "canvas": {
      if (!p.drawing) {
        const el = h("div", { class: "placeholder", role: "img", "aria-label": p.label });
        el.append(h("span", {}, p.description));
        return { el };
      }
      return canvasEl(n);
    }
    case "ad-slot":
      // Ads are host-rendered. This prototype has no ad network, so it shows the mandatory disclosure only.
      return { el: h("div", { class: "placeholder", role: "complementary", "aria-label": "Advertisement" }, "Advertisement (no ad network connected)") };
    case "embed":
      return { el: h("div", { class: "placeholder", role: "group", "aria-label": p.label }, `${p.label} (embed "${p.provider}" not supported by this Lattice Navigator)`) };
    default:
      return { el: h("div", { class: "placeholder" }, `Unsupported node: ${n.type}`) };
  }
}

function decorate(el, n) {
  const c = n.common;
  if (c.hidden) el.hidden = true;
  if (c.padding && c.padding !== "none") el.dataset.pad = c.padding;
  if (c.tone && c.tone !== "default") el.dataset.tone = c.tone;
  if (c.lang) el.lang = c.lang;
  if (c.label && !el.hasAttribute("aria-label") && !["input", "select", "checkbox"].includes(n.type)) el.setAttribute("aria-label", c.label);
  if (c.width === "fill" || c.height === "fill") el.dataset.fill = "true";
  if (c.description) {
    if (n.type === "input") el.append(h("span", { class: "sr-only", id: `f${n.id}-d` }, c.description));
    else el.setAttribute("aria-description", c.description);
  }
}

// ---- Canvas -----------------------------------------------------------------------------------
// The app supplies a display list (data); this paints it with Canvas 2D. Tones are resolved against the current theme, so
// the app cannot choose a colour, only a meaning. Input goes back as a pointer position or one of a few keys.

const TONE_VAR = { default: "--fg", muted: "--muted", accent: "--accent", positive: "--positive", caution: "--caution", critical: "--critical" };

function paint(canvas, d) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  const cssW = canvas.clientWidth || d.width;
  const scale = cssW / d.width;
  canvas.width = Math.max(1, Math.round(d.width * scale * dpr));
  canvas.height = Math.max(1, Math.round(d.height * scale * dpr));
  const ctx = canvas.getContext("2d");
  const style = getComputedStyle(canvas);
  const colour = (tone) => style.getPropertyValue(TONE_VAR[tone ?? "default"] ?? "--fg").trim() || "#888";
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  ctx.fillStyle = style.getPropertyValue("--surface").trim() || "#eee";
  ctx.fillRect(0, 0, d.width, d.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const { tag, val: v } of d.ops) {
    const c = colour(v.tone);
    ctx.fillStyle = ctx.strokeStyle = c;
    if (tag === "rect") {
      if (v.outline) { ctx.lineWidth = 1; ctx.strokeRect(v.x, v.y, v.w, v.h); } else ctx.fillRect(v.x, v.y, v.w, v.h);
    } else if (tag === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(v.cx, v.cy, Math.abs(v.rx), Math.abs(v.ry), 0, 0, Math.PI * 2);
      if (v.outline) { ctx.lineWidth = 1; ctx.stroke(); } else ctx.fill();
    } else if (tag === "line") {
      ctx.lineWidth = v.width;
      ctx.beginPath();
      ctx.moveTo(v.x1, v.y1);
      ctx.lineTo(v.x2, v.y2);
      ctx.stroke();
    } else if (tag === "text") {
      ctx.font = `${v.size}px system-ui, sans-serif`;
      ctx.fillText(v.text, v.x, v.y);
    }
  }
}

const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Enter"]);

function canvasEl(n) {
  let p = n.props;
  const wrap = h("div", { class: "canvas-wrap" });
  const canvas = h("canvas", { class: "scene-canvas", "aria-label": p.label, role: p.onInput ? "application" : "img", "aria-roledescription": p.onInput ? "interactive drawing" : undefined });
  canvas.style.aspectRatio = `${p.drawing.width} / ${p.drawing.height}`;
  const descId = `cv${n.id}-d`;
  canvas.setAttribute("aria-describedby", descId);
  wrap.append(canvas, h("span", { class: "sr-only", id: descId }, p.description));
  const desc = wrap.querySelector(".sr-only");
  const draw = () => paint(canvas, p.drawing);
  requestAnimationFrame(draw);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(draw).observe(canvas);
  matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", draw);
  if (p.onInput) {
    canvas.tabIndex = 0;
    canvas.addEventListener("pointerdown", (e) => {
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * p.drawing.width;
      const y = ((e.clientY - r.top) / r.height) * p.drawing.height;
      canvas.focus();
      act(n.id, "input", { kind: "pointer", x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    });
    canvas.addEventListener("keydown", (e) => {
      if (!ARROWS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      act(n.id, "input", { kind: "key", key: e.key });
    });
  }
  // A new picture repaints the same element, so keyboard focus survives the update.
  const update = (next) => {
    p = next.props;
    canvas.setAttribute("aria-label", p.label);
    canvas.style.aspectRatio = `${p.drawing.width} / ${p.drawing.height}`;
    desc.textContent = p.description;
    draw();
  };
  return { el: wrap, update };
}

// ---- Reconcile --------------------------------------------------------------------------------

const CONTAINERS = new Set(["stack", "grid", "scroll", "layer", "region", "item-list", "form"]);

/**
 * Make `parent`'s children be the elements for `nodes`, reusing the element of any node whose
 * revision is unchanged. Only container nodes have DOM children that come from the scene; leaf
 * controls (input, table, ...) own their internal structure.
 */
function reconcile(parent, nodes, seen) {
  const desired = nodes.map((n) => {
    seen.add(n.id);
    let entry = live.get(n.id);
    const reusable = entry && entry.update && entry.type === n.type && entry.input === !!n.props.onInput && n.props.drawing;
    if (entry && entry.rev !== n.rev && reusable) {
      entry.update(n);
      entry.rev = n.rev;
    } else if (!entry || entry.rev !== n.rev || entry.type !== n.type) {
      const { el, update } = shell(n);
      decorate(el, n);
      entry = { el, rev: n.rev, type: n.type, update, input: !!n.props.onInput };
      live.set(n.id, entry);
    }
    if (CONTAINERS.has(n.type)) reconcile(entry.el, n.children, seen);
    return entry.el;
  });
  desired.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
  while (parent.children.length > desired.length) parent.lastElementChild.remove();
}

function render(msg) {
  const seen = new Set();
  const root = msg.tree;
  // Leaf nodes build their own inner structure; only container nodes receive reconciled children.
  reconcile(appEl, [root], seen);
  for (const id of [...live.keys()]) if (!seen.has(id)) live.delete(id);

  document.title = msg.title ? `${msg.title}` : "Lattice Navigator";
  document.documentElement.lang = msg.lang ?? "en";

  // Live region announced by assistive tech.
  for (const { el } of live.values()) el.removeAttribute("aria-live");
  const liveEntry = msg.live != null ? live.get(msg.live) : null;
  if (liveEntry) liveEntry.el.setAttribute("aria-live", "polite");

  if (msg.path !== currentPath) {
    if (currentPath !== null && location.pathname !== msg.path) history.pushState(null, "", msg.path);
    currentPath = msg.path;
  }

  if (msg.focus != null) {
    const target = live.get(msg.focus)?.el;
    const focusable = target?.matches("input, textarea, select, button, a, [tabindex]") ? target : target?.querySelector("input, textarea, select, button, a");
    focusable?.focus();
  }
}

// ---- Host chrome -------------------------------------------------------------------------------
// Drawn by Lattice Navigator, outside the app's tree: it says whose page this is and who is signed in,
// so an app cannot claim either for itself.

const chromeEl = document.getElementById("chrome");

// ---- Privacy control ---------------------------------------------------------------------------
// The user's analytics choices and a window onto what has actually been sent. All text is composed here
// from the manifest's declarations and the host's own counters; nothing the app can influence at run time
// appears except event names and properties, which the manifest's catalog already constrains.

const LEVEL_LABEL = { off: "Off", errors: "Errors only", anonymous: "Anonymous", full: "Full (with a resettable ID)" };
let privacyOpen = false;

function privacyEl(p) {
  const d = h("details", { class: "privacy" });
  d.open = privacyOpen;
  d.addEventListener("toggle", () => {
    privacyOpen = d.open;
    // Counters and recent events change without a scene update; refresh them when the panel is opened.
    if (d.open) transport.state().then((m) => m.chrome && renderChrome(m.chrome)).catch(() => {});
  });
  d.append(h("summary", {}, `Analytics: ${LEVEL_LABEL[p.level] ?? p.level}`));

  const field = h("div", { class: "field" });
  const select = h("select", { id: "privacy-level" });
  for (const l of p.levels) select.append(h("option", { value: l }, LEVEL_LABEL[l] ?? l));
  select.value = p.level;
  select.addEventListener("change", () => post("settings", { analytics: select.value }));
  field.append(h("label", { for: "privacy-level" }, "What this app may send"), select);
  d.append(field);

  d.append(h("p", {}, "Data can go to:"));
  const procs = h("ul", {});
  for (const x of p.processors) procs.append(h("li", {}, `${x.name} (${x.host}): ${x.purposes.join(", ")}`));
  d.append(procs);

  const s = p.stats;
  d.append(h("p", {}, `Sent ${s.sent} · held back ${s.held} · dropped ${s.dropped} · failed ${s.failed}`));
  if (p.client) {
    const reset = h("button", { type: "button" }, "Reset my analytics ID");
    reset.addEventListener("click", () => post("analytics/reset", {}));
    d.append(reset);
  }
  d.append(h("p", {}, p.recent.length ? "Last events sent:" : "No events have been sent."));
  const recent = h("ul", { class: "recent" });
  for (const e of [...p.recent].reverse()) recent.append(h("li", {}, `${e.name} ${JSON.stringify(e.props)} → ${e.to.join(", ")}`));
  d.append(recent);
  return d;
}

// ---- Experiments -------------------------------------------------------------------------------
// What the app is testing on this user, and the way out. Text comes from the manifest and the host's own record.

let experimentsOpen = false;

function experimentsEl(x) {
  const d = h("details", { class: "privacy experiments" });
  d.open = experimentsOpen;
  d.addEventListener("toggle", () => (experimentsOpen = d.open));
  d.append(h("summary", {}, `Experiments: ${x.optOut ? "not taking part" : "taking part"}`));
  const box = h("input", { type: "checkbox", id: "experiments-optin" });
  box.checked = !x.optOut;
  box.addEventListener("change", () => post("experiments", { optOut: !box.checked }));
  d.append(h("div", { class: "field" }, box, h("label", { for: "experiments-optin" }, "Take part in this app's experiments")));
  d.append(h("p", {}, x.optOut ? "You see the standard version of everything." : "This app compares versions of itself. You are in:"));
  const ul = h("ul", {});
  for (const e of x.list) ul.append(h("li", {}, `${e.name}: ${e.yours ?? "not yet assigned"}${e.description ? ` \u2014 ${e.description}` : ""}`));
  d.append(ul);
  return d;
}

function renderChrome(c) {
  if (!c) return;
  const parts = [h("strong", {}, c.app.domain)];
  if (c.session) {
    parts.push(document.createTextNode(c.session.signedIn ? ` \u00b7 Signed in as ${c.session.name ?? "account"} ` : " \u00b7 Not signed in "));
    if (c.session.signedIn) {
      const out = h("button", { type: "button", "data-emphasis": "plain" }, "Sign out");
      out.addEventListener("click", () => post("signout", {}));
      parts.push(out);
    }
  }
  if (c.privacy) parts.push(privacyEl(c.privacy));
  if (c.experiments) parts.push(experimentsEl(c.experiments));
  chromeEl.replaceChildren(...parts);
  chromeEl.hidden = false;
  // A window that connects mid-flow still shows the pending prompt.
  const pending = c.prompts?.[0];
  if (pending && activePrompt?.id !== pending.id) showAuth(pending);
}

// ---- Sign-in dialog ----------------------------------------------------------------------------
// The text is composed here from the manifest's name and domain and the issuer's host. Nothing the
// app supplied appears in it.

const dialog = document.getElementById("auth");
let activePrompt = null;

/** "$4.00": minor units scaled by the currency's own number of decimals. */
function money(minor, currency) {
  try {
    const f = new Intl.NumberFormat(undefined, { style: "currency", currency });
    return f.format(minor / 10 ** f.resolvedOptions().maximumFractionDigits);
  } catch {
    return `${minor} ${currency}`;
  }
}

function describe(p) {
  const who = `${p.app.name} (${p.app.domain})`;
  switch (p.flow) {
    case "payment":
      return {
        title: `Pay ${money(p.summary.total_minor, p.summary.currency)} to ${p.app.name}`,
        text: `${who} is asking you to pay. You will enter your payment details on ${p.handlerHost}; ${p.app.domain} never sees them.`,
      };
    case "oidc":
      return { title: `Sign in with ${p.issuerHost}`, text: `${who} wants to sign you in using ${p.issuerHost}. A new window will open on that site.` };
    case "passkey-create":
      return { title: "Create a passkey", text: `${who} wants to create a passkey on this device. It will only work for ${p.app.domain}.` };
    default:
      return { title: "Sign in with a passkey", text: `${who} wants you to sign in with a passkey for ${p.app.domain}.` };
  }
}

function showAuth(p) {
  activePrompt = p;
  const d = describe(p);
  const cont = h("button", { type: "button", "data-emphasis": "primary" }, "Continue");
  const cancel = h("button", { type: "button" }, "Cancel");
  const status = h("p", { role: "status", id: "auth-status" });
  cont.addEventListener("click", () => proceed(p, cont, status));
  cancel.addEventListener("click", cancelAuth);
  const parts = [h("h2", { id: "auth-title" }, d.title), h("p", {}, d.text)];
  if (p.flow === "payment") {
    // The lines come from the app's server, validated by the host. The total equals their sum.
    const list = h("ul", { class: "pay-lines" });
    for (const i of p.summary.items) {
      list.append(h("li", {}, `${i.label}${i.quantity > 1 ? ` × ${i.quantity}` : ""}: ${money(i.amount_minor * i.quantity, p.summary.currency)}`));
    }
    const total = h("p", {}, `Total: ${money(p.summary.total_minor, p.summary.currency)}`);
    total.style.fontWeight = "600";
    parts.push(list, total);
  }
  dialog.replaceChildren(...parts, status, h("div", { class: "stack", "data-axis": "horizontal", "data-gap": "sm" }, ""));
  dialog.lastChild.append(cont, cancel);
  if (!dialog.open) dialog.showModal();
  cont.focus();
}

function closeAuth(id) {
  if (activePrompt && activePrompt.id === id) {
    activePrompt = null;
    if (dialog.open) dialog.close();
  }
}

function cancelAuth() {
  if (activePrompt) post("prompt/cancel", { id: activePrompt.id });
}
dialog.addEventListener("cancel", (e) => { e.preventDefault(); cancelAuth(); });

async function proceed(p, button, status) {
  button.disabled = true;
  if (p.flow === "oidc" || p.flow === "payment") {
    // Opened on the user's click so the browser allows it; noopener keeps the other site's page from
    // reaching back into this one.
    window.open(p.url, "_blank", "noopener");
    status.textContent = p.flow === "payment"
      ? "Waiting for you to finish paying in the other window\u2026"
      : "Waiting for you to finish signing in in the other window\u2026";
    return;
  }
  try {
    const create = p.flow === "passkey-create";
    if (!window.PublicKeyCredential || !PublicKeyCredential.parseCreationOptionsFromJSON) {
      throw Object.assign(new Error("Passkeys are not supported by this browser."), { name: "NotSupportedError" });
    }
    const credential = create
      ? await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(p.options) })
      : await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(p.options) });
    await post("auth/result", { id: p.id, ok: true, response: JSON.stringify(credential.toJSON()) });
  } catch (e) {
    await post("auth/result", { id: p.id, ok: false, error: e?.name ?? "Error" });
  }
}

// ---- Boot -------------------------------------------------------------------------------------

/** Start rendering. Called once, by whichever build supplies the transport. */
export function mountUi(t) {
  transport = t;
  let first = true;
  transport.subscribe((msg) => {
    if (msg.kind === "scene") {
      // The first message reflects wherever the Navigator started. If the address differs, navigate there.
      if (first && location.pathname !== msg.path) {
        first = false;
        navigate(location.pathname + location.search, { push: false });
        return;
      }
      first = false;
      render(msg);
      renderChrome(msg.chrome);
    } else if (msg.kind === "notice") notice(msg.message);
    else if (msg.kind === "error") { first = false; appEl.replaceChildren(h("p", { role: "alert" }, msg.message)); renderChrome(msg.chrome); }
    else if (msg.kind === "chrome") renderChrome(msg.chrome);
    else if (msg.kind === "prompt") showAuth(msg.prompt);
    else if (msg.kind === "prompt-end") closeAuth(msg.id);
  });
  addEventListener("popstate", () => navigate(location.pathname + location.search, { push: false }));
}

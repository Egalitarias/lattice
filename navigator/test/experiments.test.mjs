// A/B experiments (spec/experiments.md): the assignment rules in isolation, then the whole path through Navigator with the
// tasks example (its `upgrade_pitch` experiment). Requires the tasks component to be built.

import test from "node:test";
import assert from "node:assert/strict";
import { Experiments, ExperimentError } from "../experiments.mjs";
import { MemoryKv } from "../kv.mjs";
import { withStack, find, all } from "./stack.mjs";

const manifest = (experiments) => ({ experiments });
const two = { name: "pitch", description: "d", variants: [{ name: "control", weight: 1 }, { name: "b", weight: 3 }] };
const mk = (experiments = [two], extra = {}) => {
  const kv = extra.kv ?? new MemoryKv();
  const seen = [];
  const analytics = { host: (kind, name, props) => seen.push({ kind, name, props }) };
  return { kv, seen, ex: new Experiments({ manifest: manifest(experiments), kv, domain: "a.example", analytics, ...extra }) };
};

test("experiments: variants are drawn by weight, once, and then stay", () => {
  // weights 1:3 over [0,1): 0..0.25 is control, the rest is b.
  for (const [r, want] of [[0, "control"], [0.24, "control"], [0.25, "b"], [0.99, "b"]]) {
    assert.equal(mk([two], { random: () => r }).ex.variant("pitch"), want, `random ${r}`);
  }
  const { ex } = mk([two], { random: () => 0.9 });
  assert.equal(ex.variant("pitch"), "b");
  ex.random = () => 0; // a later draw would give control
  assert.equal(ex.variant("pitch"), "b", "sticky");
});

test("experiments: the assignment survives a restart, and a removed variant is redrawn", () => {
  const kv = new MemoryKv();
  mk([two], { kv, random: () => 0.9 }).ex.variant("pitch");
  assert.equal(mk([two], { kv, random: () => 0 }).ex.variant("pitch"), "b", "a new run reads the saved assignment");
  const renamed = { ...two, variants: [{ name: "control", weight: 1 }, { name: "c", weight: 1 }] };
  assert.equal(mk([renamed], { kv, random: () => 0.9 }).ex.variant("pitch"), "c", "b no longer exists, so draw again");
});

test("experiments: an unknown experiment has no variant, and nothing is recorded for it", () => {
  const { ex, seen, kv } = mk();
  assert.equal(ex.variant("nope"), undefined);
  assert.equal(ex.variant("__proto__"), undefined);
  assert.equal(ex.variant(undefined), undefined);
  assert.deepEqual(seen, []);
  assert.deepEqual([...kv.keys?.() ?? []], []);
});

test("experiments: the exposure is recorded once per run, with only the experiment and the variant", () => {
  const { ex, seen } = mk([two], { random: () => 0.9 });
  ex.variant("pitch");
  ex.variant("pitch");
  assert.deepEqual(seen, [{ kind: "product", name: "host.experiment", props: { experiment: "pitch", variant: "b" } }]);
});

test("experiments: opting out puts the user in the control, records nothing, and keeps their old assignment for later", () => {
  const { ex, seen } = mk([two], { random: () => 0.9 });
  assert.equal(ex.variant("pitch"), "b");
  seen.length = 0;
  ex.setOptOut(true);
  assert.equal(ex.variant("pitch"), "control");
  assert.deepEqual(ex.snapshot().list[0].yours, "control");
  assert.deepEqual(seen, [], "no exposure while opted out");
  ex.setOptOut(false);
  assert.equal(ex.variant("pitch"), "b");
  assert.equal(seen.length, 1, "exposed again after opting back in");
});

test("experiments: assignments are kept per app", () => {
  const kv = new MemoryKv();
  const a = new Experiments({ manifest: manifest([two]), kv, domain: "a.example", random: () => 0.9 });
  const b = new Experiments({ manifest: manifest([two]), kv, domain: "b.example", random: () => 0 });
  assert.equal(a.variant("pitch"), "b");
  assert.equal(b.variant("pitch"), "control");
});

test("experiments: a manifest that declares an experiment or a variant twice is refused", () => {
  assert.throws(() => mk([two, two]), ExperimentError);
  assert.throws(() => mk([{ ...two, variants: [{ name: "x", weight: 1 }, { name: "x", weight: 1 }] }]), ExperimentError);
});

test("experiments: the real random source gives both variants, roughly in proportion", () => {
  const counts = { control: 0, b: 0 };
  for (let i = 0; i < 4000; i++) counts[mk().ex.variant("pitch")]++;
  const share = counts.control / 4000;
  assert.ok(share > 0.2 && share < 0.3, `control share ${share} should be near 0.25`);
});

// ---- Through Navigator ----------------------------------------------------------------------------------

const PITCH = "Pro raises the limit from 50 tasks to 200.";
const pitchShown = async (h) => !!find((await h.state()).tree, (n) => n.props?.text === PITCH);
const mine = async (h) => (await h.state()).chrome.experiments.list[0].yours;

test("end to end: the app shows the variant the host chose, the user can see it, and opting out returns the control", async () => {
  await withStack(async (h) => {
    await h.signInOidc("alice");
    const x = (await h.state()).chrome.experiments;
    assert.equal(x.list[0].name, "upgrade_pitch");
    assert.deepEqual(x.list[0].variants, ["control", "benefit"]);
    const v = await mine(h);
    assert.ok(["control", "benefit"].includes(v), v);
    assert.equal(await pitchShown(h), v === "benefit", "the app drew exactly what its variant says");

    // The user's way out.
    assert.equal((await h.call("/_navigator/experiments", { optOut: true })).status, 200);
    await h.press("Sign out").catch(() => {});
    assert.equal((await h.state()).chrome.experiments.optOut, true);
    assert.equal(await mine(h), "control");
    assert.equal((await h.call("/_navigator/experiments", { optOut: "yes" })).status, 400);
    assert.equal((await h.call("/_navigator/experiments", { optOut: false })).status, 200);
    assert.equal(await mine(h), v, "back in, with the same variant as before");
  });
});

test("end to end: the exposure reaches the collector only as the user's level allows, with no identifier below full", async () => {
  await withStack(async (h) => {
    const exposures = () => h.collector.events.filter((e) => e.name === "host.experiment");
    await h.signInOidc("alice"); // the account section asks for its variant here
    await h.nav.analytics.flush();
    assert.deepEqual(exposures(), [], "the default level sends no product events");

    assert.equal((await h.call("/_navigator/settings", { analytics: "anonymous" })).status, 200);
    // Opting out and in again starts a fresh set of exposures; the next time the app draws the account section it asks again.
    await h.call("/_navigator/experiments", { optOut: true });
    await h.press("Add", { title: "while opted out" });
    await h.nav.analytics.flush();
    assert.deepEqual(exposures(), [], "nothing is recorded while the user is opted out");

    await h.call("/_navigator/experiments", { optOut: false });
    await h.press("Add", { title: "after opting back in" });
    await h.nav.analytics.flush();
    assert.equal(exposures().length, 1);
    const [exposure] = exposures();
    assert.deepEqual(Object.keys(exposure.props).sort(), ["experiment", "variant"]);
    assert.equal(exposure.props.experiment, "upgrade_pitch");
    assert.equal(exposure.props.variant, await mine(h));
    assert.equal(exposure.client ?? null, null, "no identifier at the anonymous level");
  });
});

test("end to end: an app that does not hold the experiments capability cannot be linked to it", async () => {
  await assert.rejects(
    withStack(async () => {}, { requires: ["net.origin", "session", "auth.oidc", "auth.passkey", "payments.request", "analytics.event"] }),
    /could not be linked/
  );
});

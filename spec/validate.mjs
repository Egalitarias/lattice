import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const manifest = ajv.compile(load(join(here, "manifest.schema.json")));
const scene = ajv.compile(load(join(here, "scene.schema.json")));

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (n === "target" || n === "node_modules") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const pick = (file) =>
  /manifest/.test(basename(file)) ? manifest : /scene/.test(basename(file)) ? scene : null;

let failed = 0;
const report = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "\n      " + detail : ""}`);
  if (!ok) failed++;
};

for (const f of walk(join(here, "..", "examples")).filter((f) => f.endsWith(".json"))) {
  const v = pick(f);
  if (!v) continue;
  const ok = v(load(f));
  report(ok, `valid    ${f.slice(here.length - 4)}`, ok ? "" : ajv.errorsText(v.errors));
}

for (const f of walk(join(here, "tests", "invalid")).filter((f) => f.endsWith(".json"))) {
  const v = pick(f);
  const ok = !v(load(f));
  report(ok, `rejected ${basename(f)}`, ok ? "" : "was accepted but should be invalid");
}

console.log(failed ? `\n${failed} failure(s)` : "\nall checks passed");
process.exit(failed ? 1 : 0);

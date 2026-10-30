// Builds the browser Navigator into browser/dist, which an origin serves at /.lattice/navigator/ (spec/browser.md).
//
//   node browser/build.mjs
//
// 1. generates the manifest and API-description validators from ../spec as plain JavaScript (no eval)
// 2. bundles the page and the two workers, swapping those validators in for the Node ones
// 3. copies the transpiler's WebAssembly, the stylesheet and the bootstrap page, and stamps the service worker

import { build } from "esbuild";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const navRoot = resolve(here, "..");
const dist = join(here, "dist");
const gen = join(here, "gen");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(gen, { recursive: true });

// ---- 1. Validators ----------------------------------------------------------------------------
const ajv = new Ajv2020({ strict: false, allErrors: true, code: { source: true, esm: true } });
addFormats(ajv);
ajv.addSchema(JSON.parse(readFileSync(join(navRoot, "..", "spec", "manifest.schema.json"), "utf8")), "manifest");
ajv.addSchema(JSON.parse(readFileSync(join(navRoot, "..", "spec", "api.schema.json"), "utf8")), "api");
const code = standaloneCode(ajv, { checkManifest: "manifest", checkApi: "api" });
if (/new Function|\beval\(/.test(code)) throw new Error("the generated validators must not use eval");
writeFileSync(join(gen, "validators.mjs"), code);

// ---- 2. Bundles -------------------------------------------------------------------------------
const swapValidators = {
  name: "swap-validators",
  setup(b) {
    b.onResolve({ filter: /(^|\/)validators\.mjs$/ }, (args) =>
      resolve(args.resolveDir) === navRoot ? { path: join(here, "validators-browser.mjs") } : undefined);
  },
};

await build({
  entryPoints: {
    main: join(here, "main.mjs"),
    "component-worker": join(here, "component-worker.mjs"),
    "transpile-worker": join(here, "transpile-worker.mjs"),
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["browser"],
  external: ["node:*"], // the transpiler has a Node-only branch that a browser never takes
  sourcemap: true,
  legalComments: "none",
  plugins: [swapValidators],
  logLevel: "warning",
});

// ---- 3. Assets --------------------------------------------------------------------------------
const vendor = join(navRoot, "node_modules", "@bytecodealliance", "jco-transpile", "vendor");
for (const f of readdirSync(vendor).filter((f) => f.endsWith(".wasm"))) copyFileSync(join(vendor, f), join(dist, f));
copyFileSync(join(navRoot, "ui", "ui.css"), join(dist, "ui.css"));
copyFileSync(join(here, "bootstrap.html"), join(dist, "bootstrap.html"));

const h = createHash("sha256");
for (const f of readdirSync(dist).filter((f) => f.endsWith(".js") || f.endsWith(".css") || f.endsWith(".wasm")).sort()) h.update(f).update(readFileSync(join(dist, f)));
const buildId = h.digest("hex").slice(0, 16);
writeFileSync(join(dist, "sw.js"), readFileSync(join(here, "sw.js"), "utf8").replace("__BUILD_ID__", buildId));

const files = Object.fromEntries(readdirSync(dist).filter((f) => !f.endsWith(".map")).map((f) => [f, statSync(join(dist, f)).size]));
writeFileSync(join(dist, "build.json"), JSON.stringify({ build: buildId, files }, null, 2));
console.log(`built browser navigator ${buildId}: ${Object.entries(files).map(([f, n]) => `${f} ${(n / 1024).toFixed(0)}K`).join(", ")}`);

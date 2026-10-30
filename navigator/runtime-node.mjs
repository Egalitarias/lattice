// Node's way of turning a hash-verified component into code it can run: transpile with jco (the same
// generator and options the browser uses), and cache the result on disk under the component's hash.

import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { $init, generate } from "@bytecodealliance/jco-transpile/component";
import { generateOptions } from "./transpile-options.mjs";
import { LoadError } from "./runtime.mjs";

/**
 * Transpile to JS + core wasm (cached by hash) and return the entry module path.
 * The cache is content-addressed and written atomically, so concurrent processes can share it.
 */
export async function prepareComponent({ manifest, wasm, cacheDir }) {
  const outDir = join(cacheDir, manifest.entry.replace("sha256-", ""));
  const entryJs = join(outDir, "app.js");
  if (existsSync(entryJs)) return entryJs;

  await $init;
  const { files } = generate(wasm, generateOptions("app"));
  const tmp = `${outDir}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  for (const [name, data] of files) {
    const p = join(tmp, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }
  try {
    renameSync(tmp, outDir); // all-or-nothing
  } catch {
    rmSync(tmp, { recursive: true, force: true }); // another process got there first
  }
  if (!existsSync(entryJs)) throw new LoadError("could not prepare the component");
  return entryJs;
}

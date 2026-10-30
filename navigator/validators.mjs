// Validation of the two documents a Navigator takes from an origin on trust until they pass: the manifest and
// the API description. Each returns null when valid, or readable text when not.
//
// This is the Node implementation (Ajv compiling the schemas in ../spec at start-up). A browser cannot use it
// without allowing `eval` in its page, so the browser build swaps this module for validators generated
// from the same schemas ahead of time (browser/build.mjs). A test checks the two agree.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const compile = (name) => ajv.compile(JSON.parse(readFileSync(join(here, "..", "spec", name), "utf8")));
const manifest = compile("manifest.schema.json");
const api = compile("api.schema.json");

const text = (validate) => ajv.errorsText(validate.errors, { separator: "\n  " });

export const checkManifest = (doc) => (manifest(doc) ? null : text(manifest));
export const checkApiDescription = (doc) => (api(doc) ? null : text(api));

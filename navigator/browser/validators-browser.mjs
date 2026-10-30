// The browser's validators: generated from the same schemas as the Node ones (browser/build.mjs), because a
// page cannot use Ajv's runtime compiler without allowing `eval`. The build swaps this module in for
// ../validators.mjs.

import { checkManifest as manifest, checkApi as api } from "./gen/validators.mjs";
import { formatAjvErrors } from "../validators-format.mjs";

export const checkManifest = (doc) => (manifest(doc) ? null : formatAjvErrors(manifest.errors));
export const checkApiDescription = (doc) => (api(doc) ? null : formatAjvErrors(api.errors));

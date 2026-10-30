// Keeps wit/scene.wit and scene.schema.json describing the same set of node types.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wit = readFileSync(join(here, "wit", "scene.wit"), "utf8");
const schema = JSON.parse(readFileSync(join(here, "scene.schema.json"), "utf8"));

// `list` is a reserved word in WIT, so the List node is spelled item-list there.
const renamed = { List: "item-list" };
const kebab = (s) => renamed[s] ?? s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const nodeTypes = schema.$defs.node.oneOf.map((r) => r.$ref.split("/").pop()).map(kebab);

const body = wit.match(/variant body \{([^}]*)\}/s);
if (!body) { console.error("FAIL  variant body not found in scene.wit"); process.exit(1); }
const witTypes = [...body[1].matchAll(/^\s*([a-z][a-z0-9-]*)\(/gm)].map((m) => m[1]);

const missingInWit = nodeTypes.filter((t) => !witTypes.includes(t));
const missingInSchema = witTypes.filter((t) => !nodeTypes.includes(t));

for (const t of missingInWit) console.error(`FAIL  ${t}: in scene.schema.json but not in scene.wit`);
for (const t of missingInSchema) console.error(`FAIL  ${t}: in scene.wit but not in scene.schema.json`);
if (missingInWit.length || missingInSchema.length) process.exit(1);
console.log(`PASS  scene.wit and scene.schema.json agree on ${nodeTypes.length} node types`);

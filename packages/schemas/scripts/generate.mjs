// Generates src/schemas.generated.ts from the single source of truth at /schemas/*.json
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(here, "..", "..", "..", "schemas");
const files = readdirSync(schemasDir).filter((f) => f.endsWith(".json")).sort();

let out = "// AUTO-GENERATED from /schemas/*.json — do not edit.\n";
out += "/* eslint-disable */\n";
const names = [];
for (const f of files) {
  const name = f.replace(/\.json$/, "");
  names.push(name);
  const json = JSON.parse(readFileSync(join(schemasDir, f), "utf8"));
  out += `export const ${name}Schema = ${JSON.stringify(json, null, 2)} as const;\n\n`;
}
out += `export const SCHEMAS = {\n${names.map((n) => `  ${n}: ${n}Schema,`).join("\n")}\n} as const;\n\n`;
out += `export type SchemaName = keyof typeof SCHEMAS;\n`;
out += `export const SCHEMA_NAMES = Object.keys(SCHEMAS) as SchemaName[];\n`;
writeFileSync(join(here, "..", "src", "schemas.generated.ts"), out);
console.log(`generated ${names.length} schemas: ${names.join(", ")}`);

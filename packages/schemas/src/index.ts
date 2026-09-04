import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { SCHEMAS, SCHEMA_NAMES, type SchemaName } from "./schemas.generated";
import type { SchemaTypeMap } from "./types";

export * from "./types";
export { SCHEMAS, SCHEMA_NAMES };
export type { SchemaName };

export const SCHEMA_VERSION = "1.0";

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
}

export type ValidationResult<T> =
  | { ok: true; data: T; errors: [] }
  | { ok: false; data: undefined; errors: ValidationError[] };

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const compiled = new Map<SchemaName, ValidateFunction>();

function getValidator(name: SchemaName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    v = ajv.compile(SCHEMAS[name] as unknown as object);
    compiled.set(name, v);
  }
  return v;
}

function formatErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath || "/",
    message: e.message ?? "invalid",
    keyword: e.keyword,
  }));
}

/** Validate `data` against the named schema. */
export function validateSchema<N extends SchemaName>(
  name: N,
  data: unknown,
): ValidationResult<SchemaTypeMap[N]> {
  const v = getValidator(name);
  if (v(data)) return { ok: true, data: data as SchemaTypeMap[N], errors: [] };
  return { ok: false, data: undefined, errors: formatErrors(v.errors) };
}

/** Human-readable error list, suitable for feeding back to the LLM on retry. */
export function describeErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("\n");
}

/**
 * Lenient JSON extraction for providers without native structured output:
 * strips markdown code fences and trims to the outermost {...} or [...].
 */
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  const candidates = [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0);
  const start = candidates.length ? Math.min(...candidates) : -1;
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * Produce a provider-safe copy of a schema for structured-output / tool-calling APIs.
 * Removes meta keywords and conditional keywords most providers reject;
 * full validation is always done server-side with the original schema.
 */
export function toProviderSchema(schema: object): Record<string, unknown> {
  const strip = new Set(["$schema", "$id", "if", "then", "else"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (strip.has(k)) continue;
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };
  return walk(schema) as Record<string, unknown>;
}

/** Schema for use in a prompt (compact JSON). */
export function schemaForPrompt(name: SchemaName): string {
  return JSON.stringify(toProviderSchema(SCHEMAS[name] as unknown as object));
}

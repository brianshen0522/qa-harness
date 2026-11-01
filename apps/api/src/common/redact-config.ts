const SECRET_KEY = /(pass(word|wd)?|token|api[_-]?key|apikey|secret|credential|authorization|bearer|cookie)/i;

/** Masks secret-looking values in a Target's config. Keys and other values stay. */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown, key = ""): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, walk(val, k)]));
    }
    if (typeof v === "string" && SECRET_KEY.test(key) && v.length > 0) return "****（已遮蔽）";
    return v;
  };
  return walk(config) as Record<string, unknown>;
}

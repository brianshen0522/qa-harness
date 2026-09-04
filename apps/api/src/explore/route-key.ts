/**
 * Normalizing URLs into route keys is what makes an exploration terminate.
 * `/todos/1`, `/todos/2`, `/users/abc-123` all collapse to `/todos/:id`,
 * `/users/:id` — otherwise a list of a thousand items is a thousand "pages" and
 * the crawl never ends.
 */

/** Segments that look like an id rather than a fixed route name. */
function looksDynamic(seg: string): boolean {
  if (!seg) return false;
  if (/^\d+$/.test(seg)) return true; // 42
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return true; // uuid
  if (/^[0-9a-f]{24,}$/i.test(seg)) return true; // mongo/cuid-ish hex
  if (/^c[a-z0-9]{20,}$/i.test(seg)) return true; // cuid (StreamHub uses these)
  if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /\d/.test(seg)) return true; // long mixed token
  if (/\d{3,}/.test(seg)) return true; // slug-with-a-long-number
  return false;
}

export interface NormalizedRoute {
  /** Path with dynamic segments replaced by :param, query keys sorted & valued-stripped. */
  key: string;
  /** The origin + path that produced it, kept as a representative sample. */
  sample: string;
}

export function normalizeRoute(rawUrl: string, base: string): NormalizedRoute | null {
  let url: URL;
  let baseUrl: URL;
  try {
    url = new URL(rawUrl, base);
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  // Off-site links are not part of this system's map.
  if (url.host !== baseUrl.host) return null;
  if (!/^https?:$/.test(url.protocol)) return null;

  const segs = url.pathname.split("/").map((s) => {
    if (!s) return s;
    const decoded = safeDecode(s);
    return looksDynamic(decoded) ? ":id" : decoded;
  });
  let path = segs.join("/") || "/";
  // Collapse a trailing slash so "/x" and "/x/" are one route.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // Query: keep the parameter names (they change behaviour) but drop the values
  // (they don't change which page it is), sorted so order does not fork routes.
  const params = [...url.searchParams.keys()].sort();
  const query = params.length ? `?${[...new Set(params)].join("&")}` : "";
  // A hash route (#/foo) is a real route in a hash-router SPA; keep its shape.
  const hash = url.hash && url.hash.length > 1
    ? "#" + url.hash.slice(1).split("/").map((s) => (looksDynamic(s) ? ":id" : s)).join("/")
    : "";

  return { key: path + query + hash, sample: url.origin + url.pathname + url.search + url.hash };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

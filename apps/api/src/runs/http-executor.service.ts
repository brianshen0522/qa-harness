import { Injectable, Logger } from "@nestjs/common";

export interface HttpTargetConfig {
  base_url?: string;
  headers?: Record<string, string>;
}

export interface HttpLog {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  statusText: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
  durationMs: number;
  error?: string;
}

export interface HttpActionResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  detail: Record<string, unknown>;
  log: HttpLog;
  /** Credential names actually substituted into this request (same-origin only).
   *  The definitive signal that a value truly reached the target — used to decide
   *  whether a credential rotation took effect. */
  substituted: string[];
}

const MAX_BODY_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Header names whose values are never echoed back into the transcript. */
const SECRET_HEADER = /(authorization|cookie|api[-_]?key|token|secret)/i;

/**
 * Executes the `http_request` action for api targets, which run without a
 * sandbox (§3.3). Credentials are referenced by name as `{{key}}` and filled in
 * here, so a real secret never reaches the model or the stored transcript.
 */
@Injectable()
export class HttpExecutorService {
  private readonly log = new Logger(HttpExecutorService.name);

  async perform(
    params: Record<string, unknown>,
    config: HttpTargetConfig,
    credentials: Record<string, string>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<HttpActionResult> {
    const started = Date.now();
    const method = String(params.method ?? "GET").toUpperCase();

    let url: string;
    try {
      url = this.resolveUrl(params, config);
    } catch (err) {
      return this.failure(method, String(params.url ?? params.path ?? ""), (err as Error).message, started);
    }

    // Credentials are only substituted when the request targets the Target's own
    // origin, so an editor can't author a step that ships {{secret}} to an external
    // host (privilege escalation — credentials are owner-only to set).
    const base = (config.base_url ?? "").trim();
    let creds = credentials;
    if (base) {
      try {
        if (new URL(url).origin !== new URL(base).origin) creds = {};
      } catch {
        creds = {};
      }
    }
    const headerTemplate = { ...(config.headers ?? {}), ...(asRecord(params.headers) ?? {}) };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(headerTemplate)) {
      headers[k] = fillCredentials(String(v), creds);
    }
    const rawBody = params.body ?? params.json ?? null;
    const bodyTemplate = rawBody === null || rawBody === undefined ? "" : typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
    const body = bodyTemplate ? fillCredentials(bodyTemplate, creds) : rawBody === null || rawBody === undefined ? null : "";
    // Which credential names really went out (same-origin, so `creds` is populated).
    const substituted = referencedCredentials(
      [...Object.values(headerTemplate).map(String), bodyTemplate, JSON.stringify(asRecord(params.query ?? params.params) ?? {})],
      creds,
    );
    if (body !== null && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body ?? undefined,
        signal: controller.signal,
        redirect: "manual",
      });
      const text = await res.text();
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        responseHeaders[k] = SECRET_HEADER.test(k) ? "****" : maskValues(v, credentials);
      });

      const log: HttpLog = {
        method,
        url,
        requestHeaders: redactHeaders(headers, credentials),
        requestBody: body ? redactBody(body, credentials) : null,
        status: res.status,
        statusText: res.statusText,
        responseHeaders,
        responseBody: redactBody(text, credentials),
        durationMs: Date.now() - started,
      };
      return {
        // A 4xx or 5xx is a valid observation, not an execution failure: the case
        // may be asserting exactly that.
        ok: true,
        durationMs: log.durationMs,
        detail: {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
          body: parseMaybeJson(redactBody(text, credentials)),
        },
        log,
        substituted,
      };
    } catch (err) {
      const message = (err as Error).name === "AbortError" ? `逾時（${timeoutMs}ms）` : (err as Error).message;
      this.log.warn(`http ${method} ${url} failed: ${message}`);
      return this.failure(method, url, message, started, redactHeaders(headers, credentials), substituted);
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveUrl(params: Record<string, unknown>, config: HttpTargetConfig): string {
    const raw = String(params.url ?? params.path ?? "").trim();
    if (!raw) throw new Error("缺少 url 或 path");

    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
    if (scheme && scheme !== "http" && scheme !== "https") {
      throw new Error(`只支援 http/https，收到的是 ${scheme}`);
    }
    const base = (config.base_url ?? "").trim();
    if (!scheme && !base) {
      throw new Error("這個 Target 沒有設定 base_url，請改用完整的 http(s) 網址");
    }

    let target: URL;
    try {
      target = scheme ? new URL(raw) : new URL(raw.startsWith("/") ? raw : `/${raw}`, base);
    } catch {
      throw new Error(`無法組出網址：base_url=${base || "（未設定）"} path=${raw}`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("只支援 http/https");

    const query = asRecord(params.query ?? params.params);
    if (query) {
      for (const [k, v] of Object.entries(query)) target.searchParams.set(k, String(v));
    }
    return target.toString();
  }

  private failure(
    method: string,
    url: string,
    message: string,
    started: number,
    requestHeaders: Record<string, string> = {},
    substituted: string[] = [],
  ): HttpActionResult {
    const durationMs = Date.now() - started;
    return {
      ok: false,
      durationMs,
      error: message,
      detail: { error: message },
      log: {
        method, url, requestHeaders, requestBody: null, status: null, statusText: "",
        responseHeaders: {}, responseBody: "", durationMs, error: message,
      },
      substituted,
    };
  }
}

/** Credential names referenced as `{{name}}` across the given templates and
 *  present in `creds` — i.e. the names whose real values were substituted. */
function referencedCredentials(templates: string[], creds: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const t of templates) {
    for (const m of t.matchAll(/\{\{\s*([\p{L}\p{N}_.\-]+)\s*\}\}/gu)) {
      if (m[1] in creds) names.add(m[1]);
    }
  }
  return [...names];
}

/** `{{key}}` is replaced with the decrypted credential of that name. Names may be
 *  unicode (e.g. a Chinese credential name) and use `.` to address a login field. */
export function fillCredentials(text: string, credentials: Record<string, string>): string {
  return text.replace(/\{\{\s*([\p{L}\p{N}_.\-]+)\s*\}\}/gu, (whole, key: string) =>
    key in credentials ? credentials[key] : whole,
  );
}

export function redactHeaders(headers: Record<string, string>, credentials: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, SECRET_HEADER.test(k) ? "****" : maskValues(v, credentials)]),
  );
}

/** Mask any credential value that appears in a string (header value, etc.). */
export function maskValues(text: string, credentials: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(credentials)) {
    if (value && value.length >= 4) out = out.split(value).join("****");
  }
  return out;
}

/** Any credential value that made it into a body is masked before it is stored. */
export function redactBody(body: string, credentials: Record<string, string>): string {
  let out = truncate(body);
  for (const value of Object.values(credentials)) {
    if (value && value.length >= 4) out = out.split(value).join("****");
  }
  return out;
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…（已截斷）` : text;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

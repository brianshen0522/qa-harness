import { Injectable, Logger } from "@nestjs/common";
import type { TargetKind } from "@prisma/client";
import { UrlFetchService } from "../discussion/url-fetch.service";

export interface DiscoveredEndpoint {
  method: string;
  path: string;
  summary?: string;
  params: string[];
  requestFields: string[];
  responses: string[];
}

export interface DiscoveredForm {
  action: string | null;
  method: string;
  fields: { name: string; type: string; required: boolean }[];
}

export interface DiscoveryResult {
  kind: TargetKind;
  ok: boolean;
  /** What was consulted, shown to the user so the source of the cases is visible. */
  source: string | null;
  note: string;
  endpoints?: DiscoveredEndpoint[];
  page?: { title: string | null; headings: string[]; links: { text: string; href: string }[]; forms: DiscoveredForm[] };
  /** Compact text handed to the model. */
  summary: string;
}

/**
 * Spec §4.3 「現況探索」: look at the real target before generating, so the case
 * list is grounded in what exists rather than only in the written description.
 */
@Injectable()
export class DiscoveryService {
  private readonly log = new Logger(DiscoveryService.name);

  constructor(private readonly urls: UrlFetchService) {}

  async discover(kind: TargetKind, config: Record<string, unknown>): Promise<DiscoveryResult> {
    try {
      if (kind === "api") return await this.discoverApi(config);
      if (kind === "web") return await this.discoverWeb(config);
      return {
        kind, ok: false, source: null,
        note: "desktop 類型目前不做現況探索，只依描述生成。",
        summary: "",
      };
    } catch (err) {
      this.log.warn(`discovery failed: ${(err as Error).message}`);
      return { kind, ok: false, source: null, note: `探索失敗：${(err as Error).message}`, summary: "" };
    }
  }

  private async discoverApi(config: Record<string, unknown>): Promise<DiscoveryResult> {
    const inline = typeof config.openapi_schema === "string" ? config.openapi_schema.trim() : "";
    const url = typeof config.openapi_url === "string" ? config.openapi_url.trim() : "";

    let raw = inline;
    let source: string | null = inline ? "貼上的 OpenAPI schema" : null;
    if (!raw && url) {
      const page = await this.urls.fetchOne(url, true);
      if (page.error) {
        return { kind: "api", ok: false, source: url, note: `無法取得 OpenAPI 文件：${page.error}`, summary: "" };
      }
      raw = page.raw ?? page.text;
      source = url;
    }
    if (!raw) {
      return {
        kind: "api", ok: false, source: null,
        note: "沒有設定 openapi_url 或 openapi_schema，改為只依描述生成。",
        summary: "",
      };
    }

    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      return {
        kind: "api", ok: false, source,
        note: "OpenAPI 文件不是 JSON（目前不支援 YAML，請提供 JSON 版本），改為只依描述生成。",
        summary: "",
      };
    }

    const endpoints = extractEndpoints(doc);
    if (!endpoints.length) {
      return { kind: "api", ok: false, source, note: "OpenAPI 文件裡沒有找到 paths。", summary: "" };
    }
    return {
      kind: "api", ok: true, source,
      note: `讀到 ${endpoints.length} 個 endpoint。`,
      endpoints,
      summary: summariseEndpoints(endpoints),
    };
  }

  private async discoverWeb(config: Record<string, unknown>): Promise<DiscoveryResult> {
    const url = typeof config.url === "string" ? config.url.trim() : "";
    if (!url) {
      return { kind: "web", ok: false, source: null, note: "沒有設定 url，改為只依描述生成。", summary: "" };
    }
    const page = await this.urls.fetchOne(url, true);
    if (page.error || !page.raw) {
      return { kind: "web", ok: false, source: url, note: `無法取得頁面：${page.error ?? "沒有內容"}`, summary: "" };
    }
    const structure = extractPageStructure(page.raw, url);
    return {
      kind: "web", ok: true, source: url,
      note: `讀到首頁：${structure.links.length} 個連結、${structure.forms.length} 個表單。`,
      page: { title: page.title, ...structure },
      summary: summarisePage(page.title, structure, page.text),
    };
  }
}

// ---------- OpenAPI ----------

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function extractEndpoints(doc: unknown): DiscoveredEndpoint[] {
  const paths = (doc as { paths?: Record<string, Record<string, unknown>> })?.paths;
  if (!paths || typeof paths !== "object") return [];
  const out: DiscoveredEndpoint[] = [];

  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const op = (item as Record<string, unknown>)[method] as Record<string, unknown> | undefined;
      if (!op || typeof op !== "object") continue;

      const params = [
        ...asArray((item as Record<string, unknown>).parameters),
        ...asArray(op.parameters),
      ]
        .map((p) => {
          const o = p as { name?: string; in?: string; required?: boolean };
          return o.name ? `${o.name}${o.required ? "*" : ""} (${o.in ?? "query"})` : null;
        })
        .filter((v): v is string => !!v);

      out.push({
        method: method.toUpperCase(),
        path,
        summary: typeof op.summary === "string" ? op.summary : (typeof op.description === "string" ? op.description.slice(0, 200) : undefined),
        params,
        requestFields: requestBodyFields(op.requestBody),
        responses: Object.keys((op.responses as Record<string, unknown>) ?? {}),
      });
    }
  }
  return out.slice(0, 300);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function requestBodyFields(requestBody: unknown): string[] {
  const content = (requestBody as { content?: Record<string, { schema?: unknown }> })?.content;
  if (!content) return [];
  const schema = Object.values(content)[0]?.schema as
    | { properties?: Record<string, { type?: string }>; required?: string[] }
    | undefined;
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties)
    .map(([name, def]) => `${name}${required.has(name) ? "*" : ""}: ${def?.type ?? "any"}`)
    .slice(0, 40);
}

export function summariseEndpoints(endpoints: DiscoveredEndpoint[]): string {
  const lines = endpoints.map((e) => {
    const bits = [`${e.method} ${e.path}`];
    if (e.summary) bits.push(`— ${e.summary}`);
    if (e.params.length) bits.push(`參數：${e.params.join(", ")}`);
    if (e.requestFields.length) bits.push(`body：${e.requestFields.join(", ")}`);
    if (e.responses.length) bits.push(`回應：${e.responses.join("/")}`);
    return `- ${bits.join(" ")}`;
  });
  return ["## 從 OpenAPI 讀到的 endpoint", ...lines].join("\n").slice(0, 20_000);
}

// ---------- Web page ----------

export function extractPageStructure(html: string, baseUrl: string) {
  const headings = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => stripTags(m[2]))
    .filter(Boolean)
    .slice(0, 40);

  const seen = new Set<string>();
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: resolve(m[1], baseUrl), text: stripTags(m[2]) }))
    .filter((l) => {
      if (!l.href || l.href.startsWith("javascript:") || seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    })
    .slice(0, 60);

  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => {
    const attrs = m[1];
    const body = m[2];
    const fields = [...body.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)].map((f) => ({
      name: attr(f[2], "name") ?? attr(f[2], "id") ?? "",
      type: f[1].toLowerCase() === "input" ? (attr(f[2], "type") ?? "text") : f[1].toLowerCase(),
      required: /\brequired\b/i.test(f[2]),
    })).filter((f) => f.name && f.type !== "hidden");
    return { action: attr(attrs, "action"), method: (attr(attrs, "method") ?? "get").toUpperCase(), fields };
  }).slice(0, 20);

  return { headings, links, forms };
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function resolve(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function summarisePage(
  title: string | null,
  structure: { headings: string[]; links: { text: string; href: string }[]; forms: DiscoveredForm[] },
  text: string,
): string {
  const parts = ["## 從首頁讀到的結構"];
  if (title) parts.push(`標題：${title}`);
  if (structure.headings.length) parts.push(`標題階層：${structure.headings.join(" / ")}`);
  if (structure.links.length) {
    parts.push("連結：");
    parts.push(...structure.links.map((l) => `- ${l.text || "(無文字)"} → ${l.href}`));
  }
  for (const form of structure.forms) {
    parts.push(`表單 ${form.method} ${form.action ?? "(同頁)"}：${form.fields.map((f) => `${f.name}${f.required ? "*" : ""}:${f.type}`).join(", ")}`);
  }
  if (text.trim()) parts.push("", "頁面文字節錄：", text.slice(0, 3000));
  return parts.join("\n").slice(0, 20_000);
}

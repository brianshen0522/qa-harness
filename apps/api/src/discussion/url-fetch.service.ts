import { Injectable, Logger } from "@nestjs/common";
import { assertPublicUrl } from "../common/net-guard";

export interface FetchedPage {
  url: string;
  title: string | null;
  text: string;
  chars: number;
  error?: string;
  /** Raw body, kept only when the caller asks for it (structure discovery). */
  raw?: string;
  contentType?: string;
}

const MAX_BYTES = 2_000_000;
const MAX_CHARS = 20_000;
const TIMEOUT_MS = 15_000;

/**
 * Matches bare http(s) URLs in free text. The excluded set covers full-width CJK
 * punctuation as well as ASCII, because URLs pasted into Chinese prose are almost
 * always followed by 。 or ，.
 */
const CJK_PUNCT = "，。、；：！？（）「」『』【】《》〈〉…　";
const URL_RE = new RegExp(`https?://[^\\s<>"'\`)\\]${CJK_PUNCT}]+`, "g");

export function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? [];
  const cleaned = found.map((u) => u.replace(/[.,;:!?]+$/, "")).filter((u) => {
    try {
      return !!new URL(u).hostname;
    } catch {
      return false;
    }
  });
  return [...new Set(cleaned)].slice(0, 5);
}

/** Minimal HTML -> text. Good enough to give the LLM page context. */
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : null;
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return { title, text };
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    const key = code.toLowerCase();
    if (named[key]) return named[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return m;
  });
}

/**
 * Fetches URLs pasted into the discussion so their content becomes LLM context.
 * This is a self-hosted tool aimed at dev environments, so private addresses are
 * allowed on purpose; protection is limited to scheme, size and time.
 */
@Injectable()
export class UrlFetchService {
  private readonly log = new Logger(UrlFetchService.name);

  async fetchMany(urls: string[]): Promise<FetchedPage[]> {
    return Promise.all(urls.map((u) => this.fetchOne(u)));
  }

  async fetchOne(url: string, keepRaw = false): Promise<FetchedPage> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { url, title: null, text: "", chars: 0, error: "網址格式無效" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { url, title: null, text: "", chars: 0, error: "只支援 http/https" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // SSRF guard: validate the host (and every redirect hop) resolves to a public
      // address, so a link can't be used to read cloud metadata or internal services.
      let current = parsed.toString();
      let res: Response;
      for (let hop = 0; ; hop++) {
        await assertPublicUrl(current, process.env.ALLOW_PRIVATE_FETCH === "true");
        res = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
            "user-agent": "QA-Harness/0.1 (discussion fetch)",
          },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          if (hop >= 5) return { url, title: null, text: "", chars: 0, error: "重新導向次數過多" };
          current = new URL(res.headers.get("location")!, current).toString();
          continue;
        }
        break;
      }
      if (!res.ok) return { url, title: null, text: "", chars: 0, error: `HTTP ${res.status}` };

      const ctype = res.headers.get("content-type") ?? "";
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        return { url, title: null, text: "", chars: 0, error: "內容過大（>2MB）" };
      }
      const body = buf.toString("utf8");
      let title: string | null = null;
      let text: string;
      if (/html/i.test(ctype)) {
        ({ title, text } = htmlToText(body));
      } else {
        text = body.replace(/\r\n/g, "\n");
      }
      const truncated = text.length > MAX_CHARS;
      return {
        url,
        title,
        text: truncated ? `${text.slice(0, MAX_CHARS)}\n…（已截斷）` : text,
        chars: text.length,
        contentType: ctype,
        ...(keepRaw ? { raw: body.slice(0, 600_000) } : {}),
      };
    } catch (err) {
      const msg = (err as Error).name === "AbortError" ? "逾時" : (err as Error).message;
      this.log.warn(`fetch ${url} failed: ${msg}`);
      return { url, title: null, text: "", chars: 0, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

import { Injectable, Logger } from "@nestjs/common";
import type { ActionType } from "@qa-harness/schemas";

export interface PageProbe {
  url: string;
  path: string;
  title: string;
  headings: string[];
  links: { href: string; text: string; visible: boolean }[];
  forms: { action: string | null; method: string; fields: { name: string | null; type: string; required: boolean; label: string | null }[] }[];
  controls: { text: string; role: string; disabled: boolean }[];
  landmarks: string[];
  scrollWidth: number;
  clientWidth: number;
  textLength: number;
  /** Visible modal/dialog count and a generic big-overlay flag (modal detection). */
  dialogs: number;
  overlay: boolean;
}

export interface ActionResult {
  ok: boolean;
  action: string;
  durationMs: number;
  /** base64 PNG, only for screenshot */
  image?: string;
  error?: string;
  /** Everything else the in-container agent returned. */
  detail: Record<string, unknown>;
}

/** Actions the sandbox container can perform; the rest are handled host-side. */
export const CONTAINER_ACTIONS: ReadonlySet<string> = new Set([
  "screenshot", "click", "double_click", "right_click", "move",
  "type", "key", "scroll", "navigate", "run_command", "cursor",
  // Driven by the worker around a case, never proposed by the model.
  "record_start", "record_stop",
  // Deterministic DOM + navigation for the explorer (CDP-backed), also worker-only.
  "dom_snapshot", "cdp_navigate", "cdp_fill", "cdp_click", "cdp_current", "cdp_key", "cdp_reset",
  "set_viewport", "clear_viewport",
]);

/** Actions the worker resolves without touching the container. */
export const HOST_ACTIONS: ReadonlySet<ActionType> = new Set(["wait", "http_request", "done"]);

/** HTTP client for the computer-use agent running inside a sandbox container. */
@Injectable()
export class ComputerService {
  private readonly log = new Logger(ComputerService.name);

  async health(port: number, timeoutMs = 3000): Promise<{ ok: boolean; width?: number; height?: number; error?: string }> {
    try {
      const res = await this.fetchJson(port, "/health", undefined, timeoutMs, "GET");
      return { ok: !!res.ok, width: res.width as number, height: res.height as number };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async screenshot(port: number): Promise<ActionResult> {
    return this.perform(port, "screenshot", {});
  }

  /**
   * Screen recording for the case being executed (§4.7 錄影). Failures are
   * reported, never thrown: losing the video must not take the case with it.
   */
  async startRecording(port: number, fps = 5): Promise<ActionResult> {
    return this.perform(port, "record_start", { fps }, 15_000);
  }

  async stopRecording(port: number): Promise<ActionResult> {
    return this.perform(port, "record_stop", {}, 40_000);
  }

  /** Read the rendered DOM (links, forms, controls, headings, layout metrics). */
  async domSnapshot(port: number): Promise<PageProbe | null> {
    const res = await this.perform(port, "dom_snapshot", {}, 30_000);
    return res.ok ? ((res.detail as { page?: PageProbe }).page ?? null) : null;
  }

  /** Navigate via CDP and return the fresh probe; more reliable than the URL bar. */
  async cdpNavigate(port: number, url: string, waitMs?: number): Promise<PageProbe | null> {
    const res = await this.perform(port, "cdp_navigate", { url, wait_ms: waitMs }, 60_000);
    return res.ok ? ((res.detail as { page?: PageProbe }).page ?? null) : null;
  }

  async cdpFill(port: number, field: string | number, value: string): Promise<ActionResult> {
    return this.perform(port, "cdp_fill", { field, value }, 15_000);
  }

  /** Click a link/button by visible text; result says whether the URL changed. */
  async cdpClick(port: number, text: string, opts: { exact?: boolean; waitMs?: number } = {}): Promise<ActionResult> {
    return this.perform(port, "cdp_click", { text, exact: opts.exact, wait_ms: opts.waitMs }, 30_000);
  }

  async cdpCurrent(port: number): Promise<{ url: string; path: string; title: string } | null> {
    const res = await this.perform(port, "cdp_current", {}, 10_000);
    return res.ok ? (res.detail as { url: string; path: string; title: string }) : null;
  }

  async setViewport(port: number, width: number, height: number, mobile?: boolean): Promise<ActionResult> {
    return this.perform(port, "set_viewport", { width, height, mobile }, 15_000);
  }

  async clearViewport(port: number): Promise<ActionResult> {
    return this.perform(port, "clear_viewport", {}, 10_000);
  }

  /** Send a single key (Escape by default) — used to close a modal. */
  async cdpKey(port: number, key = "Escape"): Promise<ActionResult> {
    return this.perform(port, "cdp_key", { key }, 10_000);
  }

  /** Clear cookies + storage so the next identity starts from a clean session. */
  async cdpReset(port: number): Promise<ActionResult> {
    return this.perform(port, "cdp_reset", {}, 15_000);
  }

  /** Pulls the finished mp4 out of the container. Null when there is nothing to fetch. */
  async fetchRecording(port: number, timeoutMs = 120_000): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/recording`, { signal: controller.signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.byteLength ? buf : null;
    } catch (err) {
      this.log.warn(`failed to fetch recording: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run one action. Agent errors come back as `ok: false`, not as a throw. */
  async perform(port: number, action: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<ActionResult> {
    if (!CONTAINER_ACTIONS.has(action)) {
      return { ok: false, action, durationMs: 0, error: `sandbox 不支援的動作：${action}`, detail: {} };
    }
    const started = Date.now();
    try {
      const body = await this.fetchJson(port, `/${action}`, params, timeoutMs, "POST");
      const { ok, action: _a, duration_ms, image, error, ...detail } = body as Record<string, unknown> & {
        ok: boolean; duration_ms?: number; image?: string; error?: string;
      };
      return {
        ok: !!ok,
        action,
        durationMs: (duration_ms as number) ?? Date.now() - started,
        image: image as string | undefined,
        error: error as string | undefined,
        detail: detail as Record<string, unknown>,
      };
    } catch (err) {
      this.log.warn(`action ${action} failed: ${(err as Error).message}`);
      return { ok: false, action, durationMs: Date.now() - started, error: (err as Error).message, detail: {} };
    }
  }

  private async fetchJson(
    port: number,
    path: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    method: "GET" | "POST",
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        signal: controller.signal,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(params ?? {}) }
          : {}),
      });
      const text = await res.text();
      if (!res.ok && !text.trim().startsWith("{")) {
        throw new Error(`agent HTTP ${res.status}`);
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new Error(`動作逾時（${timeoutMs}ms）`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

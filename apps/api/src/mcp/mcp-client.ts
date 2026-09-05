/**
 * A minimal Model Context Protocol client over the Streamable HTTP transport.
 * MCP is JSON-RPC 2.0: `initialize` (handshake, may return a session id header),
 * then `tools/list` and `tools/call`. Only what the harness needs — no
 * subscriptions, no server-initiated messages — so it stays small and testable.
 *
 * Responses may be plain JSON or an SSE stream (`text/event-stream`); both carry
 * the same JSON-RPC payload, so we accept either.
 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  /** Flattened text content of the tool's response. */
  text: string;
  isError: boolean;
  raw: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {}

export class McpClient {
  private sessionId: string | null = null;
  private id = 0;

  constructor(
    private readonly url: string,
    private readonly auth: string | null,
    private readonly timeoutMs = 20_000,
  ) {}

  /** Handshake. Captures a session id if the server issues one. */
  async initialize(): Promise<void> {
    const { json, sessionId } = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "qa-harness", version: "0.1" },
    });
    if (json.error) throw new McpError(json.error.message ?? "initialize failed");
    if (sessionId) this.sessionId = sessionId;
    // Per spec the client then sends `notifications/initialized`; best-effort.
    await this.notify("notifications/initialized").catch(() => undefined);
  }

  async listTools(): Promise<McpTool[]> {
    const { json } = await this.rpc("tools/list", {});
    if (json.error) throw new McpError(json.error.message ?? "tools/list failed");
    const tools = (json.result?.tools ?? []) as McpTool[];
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const { json } = await this.rpc("tools/call", { name, arguments: args });
    if (json.error) return { text: json.error.message ?? "tool error", isError: true, raw: json.error };
    const result = json.result ?? {};
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`))
      .join("\n")
      .trim();
    return { text: text || JSON.stringify(result).slice(0, 4000), isError: !!result.isError, raw: result };
  }

  /** Connect + list tools in one go; used by the "test connection" button. */
  async probe(): Promise<McpTool[]> {
    await this.initialize();
    return this.listTools();
  }

  // ----- transport -----

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.auth ? { authorization: this.auth.startsWith("Bearer ") ? this.auth : `Bearer ${this.auth}` } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<{ json: JsonRpc; sessionId: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: controller.signal,
      });
      const sessionId = res.headers.get("mcp-session-id");
      const body = await res.text();
      if (!res.ok && !body.trim()) throw new McpError(`MCP HTTP ${res.status}`);
      return { json: parseRpc(body), sessionId };
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new McpError(`MCP 連線逾時（${this.timeoutMs}ms）`);
      throw err instanceof McpError ? err : new McpError((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  private async notify(method: string): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params: {} }),
    });
  }
}

interface JsonRpc {
  result?: { tools?: McpTool[]; content?: unknown; isError?: boolean; [k: string]: unknown };
  error?: { code?: number; message?: string };
}

/** Accept a plain JSON body or an SSE stream; both wrap the same JSON-RPC object. */
export function parseRpc(body: string): JsonRpc {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpc;
  // SSE: pull the last `data:` line's JSON.
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i]) as JsonRpc;
    } catch {
      /* keep looking */
    }
  }
  throw new McpError("MCP 回應無法解析");
}

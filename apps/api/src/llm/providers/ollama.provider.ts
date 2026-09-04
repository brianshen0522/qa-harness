import {
  DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, LlmProviderError,
  type LlmProviderAdapter, type LlmRequest, type LlmResponse, type ResolvedLlmConfig,
} from "./types";

interface OllamaMessage { role: "system" | "user" | "assistant"; content: string; images?: string[] }
interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Native Ollama /api/chat. `format` accepts a JSON schema on recent versions. */
export class OllamaProvider implements LlmProviderAdapter {
  async complete(cfg: ResolvedLlmConfig, req: LlmRequest): Promise<LlmResponse> {
    const endpoint = (cfg.endpoint || "http://localhost:11434").replace(/\/+$/, "");
    const messages: OllamaMessage[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) {
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content });
      } else {
        messages.push({
          role: m.role,
          content: m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n"),
          images: m.content.filter((p) => p.type === "image").map((p) => (p as { base64: string }).base64),
        });
      }
    }

    const body = {
      model: cfg.model,
      messages,
      stream: false,
      ...(req.jsonSchema ? { format: req.jsonSchema.schema } : {}),
      options: {
        num_predict: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") throw new LlmProviderError("timeout", "Ollama request timed out");
      throw new LlmProviderError("network", (err as Error).message);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 429) throw new LlmProviderError("rate_limit", text, 429);
      if (res.status === 401 || res.status === 403) throw new LlmProviderError("auth", text, res.status);
      if (res.status >= 500) throw new LlmProviderError("server", text, res.status);
      if (res.status === 400 && req.jsonSchema && /format/i.test(text)) {
        // Old Ollama without schema-format support: retry without it (schema is in the prompt).
        return this.complete(cfg, { ...req, jsonSchema: undefined });
      }
      throw new LlmProviderError("bad_request", text || `HTTP ${res.status}`, res.status);
    }

    const json = (await res.json()) as OllamaChatResponse;
    if (json.error) throw new LlmProviderError("unknown", json.error);
    return {
      text: json.message?.content ?? "",
      model: json.model ?? cfg.model,
      usage: { inputTokens: json.prompt_eval_count ?? null, outputTokens: json.eval_count ?? null },
      nativeJson: !!req.jsonSchema,
    };
  }
}

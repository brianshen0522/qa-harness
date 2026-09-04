import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, LlmProviderError,
  type LlmProviderAdapter, type LlmRequest, type LlmResponse, type ResolvedLlmConfig,
} from "./types";

function toAnthropicMessages(req: LlmRequest): Anthropic.MessageParam[] {
  return req.messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((p): Anthropic.ContentBlockParam =>
            p.type === "text"
              ? { type: "text", text: p.text }
              : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } },
          ),
  }));
}

function mapError(err: unknown): LlmProviderError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmProviderError("timeout", err.message);
  if (err instanceof Anthropic.RateLimitError) return new LlmProviderError("rate_limit", err.message, 429);
  if (err instanceof Anthropic.AuthenticationError) return new LlmProviderError("auth", err.message, 401);
  if (err instanceof Anthropic.BadRequestError) return new LlmProviderError("bad_request", err.message, 400);
  if (err instanceof Anthropic.InternalServerError) return new LlmProviderError("server", err.message, err.status);
  if (err instanceof Anthropic.APIConnectionError) return new LlmProviderError("network", err.message);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return new LlmProviderError(status >= 500 ? "server" : "unknown", err.message, status);
  }
  return new LlmProviderError("unknown", err instanceof Error ? err.message : String(err));
}

export class AnthropicProvider implements LlmProviderAdapter {
  async complete(cfg: ResolvedLlmConfig, req: LlmRequest): Promise<LlmResponse> {
    const client = new Anthropic({
      apiKey: cfg.apiKey ?? undefined,
      baseURL: cfg.endpoint || undefined,
      timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 0, // retries/fallback are the gateway's job
    });

    const base: Anthropic.MessageCreateParamsNonStreaming = {
      model: cfg.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: req.system,
      messages: toAnthropicMessages(req),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    let nativeJson = false;
    let response: Anthropic.Message;
    try {
      if (req.jsonSchema) {
        try {
          response = await client.messages.create({
            ...base,
            output_config: { format: { type: "json_schema", schema: req.jsonSchema.schema } },
          });
          nativeJson = true;
        } catch (err) {
          // Older models reject output_config; fall back to prompt-guided JSON (schema is already in the prompt).
          if (err instanceof Anthropic.BadRequestError && /output_config|format/i.test(err.message)) {
            response = await client.messages.create(base);
          } else {
            throw err;
          }
        }
      } else {
        response = await client.messages.create(base);
      }
    } catch (err) {
      throw mapError(err);
    }

    if (response.stop_reason === "refusal") {
      throw new LlmProviderError("refusal", `Model refused: ${response.stop_details?.explanation ?? "no explanation"}`);
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return {
      text,
      model: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      nativeJson,
    };
  }
}

import OpenAI from "openai";
import {
  DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, LlmProviderError,
  type LlmProviderAdapter, type LlmRequest, type LlmResponse, type ResolvedLlmConfig,
} from "./types";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAiMessages(req: LlmRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("") });
    } else {
      out.push({
        role: "user",
        content: m.content.map((p) =>
          p.type === "text"
            ? { type: "text" as const, text: p.text }
            : { type: "image_url" as const, image_url: { url: `data:${p.mediaType};base64,${p.base64}` } },
        ),
      });
    }
  }
  return out;
}

function mapError(err: unknown): LlmProviderError {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new LlmProviderError("timeout", err.message);
  if (err instanceof OpenAI.RateLimitError) return new LlmProviderError("rate_limit", err.message, 429);
  if (err instanceof OpenAI.AuthenticationError) return new LlmProviderError("auth", err.message, 401);
  if (err instanceof OpenAI.BadRequestError) return new LlmProviderError("bad_request", err.message, 400);
  if (err instanceof OpenAI.InternalServerError) return new LlmProviderError("server", err.message, err.status);
  if (err instanceof OpenAI.APIConnectionError) return new LlmProviderError("network", err.message);
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    return new LlmProviderError(status >= 500 ? "server" : "unknown", err.message, status);
  }
  return new LlmProviderError("unknown", err instanceof Error ? err.message : String(err));
}

/** OpenAI and any OpenAI-compatible endpoint (vLLM, LM Studio, Ollama's /v1, OpenRouter, ...). */
export class OpenAiProvider implements LlmProviderAdapter {
  async complete(cfg: ResolvedLlmConfig, req: LlmRequest): Promise<LlmResponse> {
    const client = new OpenAI({
      apiKey: cfg.apiKey ?? "not-needed",
      baseURL: cfg.endpoint || undefined,
      timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });

    const base: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: cfg.model,
      messages: toOpenAiMessages(req),
      max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Explicit: some compatible gateways stream by default when the field is absent.
      stream: false,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      // Not in every compatible server's vocabulary; those ignore the field.
      ...(req.reasoningEffort
        ? { reasoning_effort: req.reasoningEffort as OpenAI.ReasoningEffort }
        : {}),
    };

    let nativeJson = false;
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      if (req.jsonSchema) {
        // Escalating fallback: strict schema enforcement is what actually stops the
        // model dropping required fields, but not every compatible server accepts
        // it (strict mode rejects `additionalProperties: true` on some servers).
        const withFormat = (strict: boolean) =>
          client.chat.completions.create({
            ...base,
            response_format: {
              type: "json_schema",
              json_schema: { name: req.jsonSchema!.name, schema: req.jsonSchema!.schema, strict },
            },
          });
        try {
          completion = await withFormat(true);
          nativeJson = true;
        } catch (err) {
          if (!(err instanceof OpenAI.BadRequestError)) throw err;
          try {
            completion = await withFormat(false);
            nativeJson = true;
          } catch (err2) {
            if (!(err2 instanceof OpenAI.BadRequestError)) throw err2;
            // Servers that only know json_object, or nothing at all.
            try {
              completion = await client.chat.completions.create({ ...base, response_format: { type: "json_object" } });
            } catch (err3) {
              if (err3 instanceof OpenAI.BadRequestError) completion = await client.chat.completions.create(base);
              else throw err3;
            }
          }
        }
      } else {
        completion = await client.chat.completions.create(base);
      }
    } catch (err) {
      throw mapError(err);
    }

    const choice = completion.choices[0];
    if (!choice) throw new LlmProviderError("unknown", "Empty choices in response");
    if (choice.finish_reason === "length" && !choice.message.content?.trim()) {
      // The budget went entirely on reasoning. Saying so beats an unexplained
      // blank reply, because the fix is a bigger budget or less thinking.
      throw new LlmProviderError(
        "bad_request",
        `回應在寫出內容前就用完 token（completion=${completion.usage?.completion_tokens ?? "?"}），` +
          "多半是思考佔滿了預算：調高 max tokens 或把 reasoning effort 調低。",
      );
    }
    if (choice.finish_reason === "content_filter") throw new LlmProviderError("refusal", "Content filtered");
    const refusal = (choice.message as { refusal?: string | null }).refusal;
    if (refusal) throw new LlmProviderError("refusal", refusal);

    return {
      text: choice.message.content ?? "",
      model: completion.model,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? null,
        outputTokens: completion.usage?.completion_tokens ?? null,
      },
      nativeJson,
    };
  }
}

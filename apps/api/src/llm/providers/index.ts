import type { LlmProvider } from "@prisma/client";
import { AnthropicProvider } from "./anthropic.provider";
import { OpenAiProvider } from "./openai.provider";
import { OllamaProvider } from "./ollama.provider";
import type { LlmProviderAdapter } from "./types";

export * from "./types";

export function createProviderRegistry(): Record<LlmProvider, LlmProviderAdapter> {
  return {
    anthropic: new AnthropicProvider(),
    openai: new OpenAiProvider(),
    ollama: new OllamaProvider(),
  };
}

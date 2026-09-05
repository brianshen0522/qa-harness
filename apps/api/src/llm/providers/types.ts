import type { LlmProvider } from "@prisma/client";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; base64: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /** When set, the provider is asked for JSON matching this schema (native mode when supported). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  timeoutMs?: number;
  /**
   * How much the model should think before answering, for endpoints that expose
   * it. Thinking is billed against the same token budget as the answer and the
   * same wall clock, so a big structured request can spend its whole budget
   * reasoning and return nothing. Providers that do not understand it ignore it.
   */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
}

export interface LlmResponse {
  text: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** true if the provider enforced the schema natively (structured output). */
  nativeJson: boolean;
  /** Provider stop reason, e.g. "stop" | "length"; lets the gateway detect truncation. */
  finishReason?: string;
}

export interface ResolvedLlmConfig {
  id: string;
  name: string;
  provider: LlmProvider;
  endpoint: string | null;
  apiKey: string | null;
  model: string;
  supportsVision: boolean;
}

export type LlmErrorKind =
  | "timeout"
  | "rate_limit"
  | "server"
  | "network"
  | "auth"
  | "bad_request"
  /** Output budget spent before content emerged (usually reasoning eating tokens). Retriable with a bigger budget. */
  | "budget"
  | "refusal"
  | "unknown";

/** Kinds that trigger fallback to the next config in the chain (spec §4.8). */
export const FALLBACK_KINDS: ReadonlySet<LlmErrorKind> = new Set([
  "timeout", "rate_limit", "server", "network", "refusal", "auth", "bad_request", "unknown",
]);

export class LlmProviderError extends Error {
  constructor(public readonly kind: LlmErrorKind, message: string, public readonly status?: number) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export interface LlmProviderAdapter {
  complete(cfg: ResolvedLlmConfig, req: LlmRequest): Promise<LlmResponse>;
}

// Just under the proxy's 90s ceiling so a hung call surfaces at the real limit,
// not 30s later.
export const DEFAULT_TIMEOUT_MS = 95_000;
export const DEFAULT_MAX_TOKENS = 8192;

import { Injectable, Logger } from "@nestjs/common";
import { LlmPurpose } from "@prisma/client";
import {
  applyConstDefaults, describeErrors, extractJson, isBlankOutput, schemaForPrompt,
  SCHEMAS, toProviderSchema, validateSchema, type SchemaName, type SchemaTypeMap,
} from "@qa-harness/schemas";
import { PrismaService } from "../prisma/prisma.service";
import { LlmConfigsService } from "./llm-configs.service";
import { LlmHealthService } from "./llm-health.service";
import {
  createProviderRegistry, FALLBACK_KINDS, LlmProviderError,
  type LlmMessage, type LlmProviderAdapter, type LlmRequest, type LlmResponse, type ResolvedLlmConfig,
} from "./providers";

export interface AttemptLog {
  configId: string;
  configName: string;
  model: string;
  attempt: number;
  outcome: "ok" | "invalid_output" | "provider_error";
  errorKind?: string;
  error?: string;
  durationMs: number;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  configId: string;
  configName: string;
  attempts: AttemptLog[];
  /** Number of configs that were skipped before this one succeeded. */
  fallbacks: number;
  raw: string;
}

export interface StructuredOptions {
  /** Retries per config on invalid output (default 2 → up to 3 tries). */
  maxRetries?: number;
  /** Pin to one config (skips the chain). Used by the admin test button. */
  configId?: string;
  /** Require the config to support vision (execute purpose). */
  requireVision?: boolean;
}

/**
 * Why no model could serve the request. All three are recoverable: a config may
 * come back on its own, or an admin may fix or add one, so long-running work
 * should wait rather than give up (§4.9 fallback, extended to whole-chain loss).
 */
export type UnavailableReason = "not_configured" | "all_down" | "all_failed";

export class LlmExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: AttemptLog[],
    public readonly reason: UnavailableReason = "all_failed",
  ) {
    super(message);
    this.name = "LlmExhaustedError";
  }

  /** Always true today, but callers should ask rather than assume. */
  get recoverable(): boolean {
    return true;
  }
}

type ProviderRegistry = ReturnType<typeof createProviderRegistry>;

@Injectable()
export class LlmGatewayService {
  private readonly log = new Logger(LlmGatewayService.name);
  private providers: ProviderRegistry;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configs: LlmConfigsService,
    private readonly health: LlmHealthService,
  ) {
    this.providers = createProviderRegistry();
  }

  /** Test hook: swap provider adapters. */
  setProviders(p: Partial<ProviderRegistry>) {
    this.providers = { ...this.providers, ...p } as ProviderRegistry;
  }

  /**
   * Call the LLM for `purpose`, forcing output to match `schemaName`.
   * Validation failure → retry with errors (up to maxRetries); provider error or retries exhausted → next config in chain.
   */
  async structured<N extends SchemaName>(
    purpose: LlmPurpose,
    schemaName: N,
    req: Omit<LlmRequest, "jsonSchema">,
    opts: StructuredOptions = {},
  ): Promise<StructuredResult<SchemaTypeMap[N]>> {
    const maxRetries = opts.maxRetries ?? 2;
    const chain = await this.chainFor(purpose, opts);
    const providerSchema = toProviderSchema(SCHEMAS[schemaName] as unknown as object);
    const system = [req.system ?? "", jsonInstruction(schemaName)].filter(Boolean).join("\n\n");
    const attempts: AttemptLog[] = [];

    for (let ci = 0; ci < chain.length; ci++) {
      const cfg = chain[ci];
      const adapter = this.adapterFor(cfg);
      let messages: LlmMessage[] = [...req.messages];

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const started = Date.now();
        let res: LlmResponse;
        try {
          res = await adapter.complete(cfg, {
            ...req, system, messages,
            jsonSchema: { name: schemaName, schema: providerSchema },
          });
        } catch (err) {
          const e = err instanceof LlmProviderError ? err : new LlmProviderError("unknown", String(err));
          const a: AttemptLog = { configId: cfg.id, configName: cfg.name, model: cfg.model, attempt, outcome: "provider_error", errorKind: e.kind, error: e.message, durationMs: Date.now() - started };
          attempts.push(a);
          await this.record(purpose, schemaName, cfg, a, null, null);
          await this.health.recordFailure(cfg.id, e.kind, e.message);
          this.log.warn(`[${purpose}/${schemaName}] ${cfg.name} attempt ${attempt} provider_error(${e.kind}): ${e.message}`);
          if (FALLBACK_KINDS.has(e.kind)) break; // next config
          continue;
        }

        let parsed: unknown;
        let parseError: string | null = null;
        try {
          parsed = applyConstDefaults(schemaName, extractJson(res.text));
        } catch (err) {
          parseError = (err as Error).message;
        }
        const validation = parseError ? null : validateSchema(schemaName, parsed);

        if (validation?.ok) {
          const a: AttemptLog = { configId: cfg.id, configName: cfg.name, model: res.model, attempt, outcome: "ok", durationMs: Date.now() - started };
          attempts.push(a);
          await this.record(purpose, schemaName, cfg, a, res, null);
          await this.health.recordSuccess(cfg.id);
          return { data: validation.data, model: res.model, configId: cfg.id, configName: cfg.name, attempts, fallbacks: ci, raw: res.text };
        }

        const errorText = parseError ?? describeErrors(validation!.errors);
        const a: AttemptLog = { configId: cfg.id, configName: cfg.name, model: res.model, attempt, outcome: "invalid_output", error: errorText, durationMs: Date.now() - started };
        attempts.push(a);
        await this.record(purpose, schemaName, cfg, a, res, res.text);
        this.log.warn(`[${purpose}/${schemaName}] ${cfg.name} attempt ${attempt} invalid_output: ${errorText.slice(0, 300)}`);

        if (isBlankOutput(res.text)) {
          // Nothing but reasoning, or nothing at all. Echoing an empty assistant
          // turn only makes the next attempt worse, so retry the request untouched.
          continue;
        }
        // Feed the validation errors back so the model can correct itself.
        messages = [
          ...messages,
          { role: "assistant", content: res.text },
          { role: "user", content: `Your previous output did not satisfy the required JSON schema:\n${errorText}\n\nReturn ONLY a corrected JSON object that satisfies the schema. Include every required field, even when the value seems obvious.` },
        ];
      }

      // Every retry on this config produced something unusable: it failed to
      // serve the request, so it counts against the breaker like any other failure.
      await this.health.recordFailure(cfg.id, "unknown", `無法產生合格的 ${schemaName} 輸出`);
    }

    throw new LlmExhaustedError(
      `「${purpose}」的所有 LLM 設定都無法產生合格的 ${schemaName} 輸出（共 ${attempts.length} 次嘗試）`,
      attempts,
      "all_failed",
    );
  }

  /** Free-text completion with fallback chain (no schema). */
  async complete(purpose: LlmPurpose, req: LlmRequest, opts: StructuredOptions = {}): Promise<LlmResponse & { configId: string; attempts: AttemptLog[] }> {
    const chain = await this.chainFor(purpose, opts);
    const attempts: AttemptLog[] = [];
    for (const cfg of chain) {
      const started = Date.now();
      try {
        const res = await this.adapterFor(cfg).complete(cfg, req);
        const a: AttemptLog = { configId: cfg.id, configName: cfg.name, model: res.model, attempt: 0, outcome: "ok", durationMs: Date.now() - started };
        attempts.push(a);
        await this.record(purpose, null, cfg, a, res, null);
        await this.health.recordSuccess(cfg.id);
        return { ...res, configId: cfg.id, attempts };
      } catch (err) {
        const e = err instanceof LlmProviderError ? err : new LlmProviderError("unknown", String(err));
        const a: AttemptLog = { configId: cfg.id, configName: cfg.name, model: cfg.model, attempt: 0, outcome: "provider_error", errorKind: e.kind, error: e.message, durationMs: Date.now() - started };
        attempts.push(a);
        await this.record(purpose, null, cfg, a, null, null);
        await this.health.recordFailure(cfg.id, e.kind, e.message);
      }
    }
    throw new LlmExhaustedError(`「${purpose}」的所有 LLM 設定都失敗了`, attempts, "all_failed");
  }

  /** Admin "send test prompt": one config, no chain, no retry. Returns latency and raw text. */
  async testConfig(configId: string, prompt: string) {
    const cfg = await this.configs.resolveOne(configId);
    const started = Date.now();
    try {
      const res = await this.adapterFor(cfg).complete(cfg, {
        messages: [{ role: "user", content: prompt }],
        maxTokens: 512,
        timeoutMs: 60_000,
      });
      return { ok: true as const, text: res.text, model: res.model, usage: res.usage, latencyMs: Date.now() - started };
    } catch (err) {
      const e = err instanceof LlmProviderError ? err : new LlmProviderError("unknown", String(err));
      return { ok: false as const, errorKind: e.kind, error: e.message, status: e.status, latencyMs: Date.now() - started };
    }
  }

  /**
   * The configs to try, in order, skipping any the breaker has taken out.
   * Distinguishes "nothing configured" from "everything is currently down" so
   * the caller can tell the user which it is while it waits.
   */
  private async chainFor(purpose: LlmPurpose, opts: StructuredOptions): Promise<ResolvedLlmConfig[]> {
    const requireVision = !!opts.requireVision || purpose === "execute";
    if (opts.configId) {
      // An explicit config (the admin test button) bypasses the breaker on purpose.
      return [await this.configs.resolveOne(opts.configId)];
    }

    let chain = await this.configs.resolveChain(purpose);
    if (requireVision) chain = chain.filter((c) => c.supportsVision);
    if (!chain.length) {
      throw new LlmExhaustedError(
        `目前沒有為「${purpose}」設定任何可用的 LLM${requireVision ? "（此用途需要支援 vision）" : ""}。請到 Admin → LLM Providers 新增一組。`,
        [],
        "not_configured",
      );
    }

    const usable = new Set(await this.health.usableConfigIds(purpose, requireVision));
    const healthy = chain.filter((c) => usable.has(c.id));
    if (!healthy.length) {
      throw new LlmExhaustedError(
        `「${purpose}」的 ${chain.length} 組 LLM 目前全部無法使用，等待恢復中。`,
        [],
        "all_down",
      );
    }
    return healthy;
  }

  private adapterFor(cfg: ResolvedLlmConfig): LlmProviderAdapter {
    return this.providers[cfg.provider];
  }

  private async record(purpose: LlmPurpose, schemaName: string | null, cfg: ResolvedLlmConfig, a: AttemptLog, res: LlmResponse | null, rawOutput: string | null) {
    try {
      await this.prisma.llmCallLog.create({
        data: {
          purpose,
          schemaName,
          llmConfigId: cfg.id,
          model: a.model,
          attempt: a.attempt,
          outcome: a.outcome === "provider_error" ? (a.errorKind ?? "provider_error") : a.outcome,
          errorMessage: a.error?.slice(0, 2000),
          rawOutput: rawOutput?.slice(0, 20_000),
          inputTokens: res?.usage.inputTokens ?? null,
          outputTokens: res?.usage.outputTokens ?? null,
          durationMs: a.durationMs,
        },
      });
    } catch (err) {
      this.log.error(`failed to write llm_call_log: ${(err as Error).message}`);
    }
  }
}

function jsonInstruction(schemaName: SchemaName): string {
  return [
    `# Output contract`,
    `Respond with exactly one JSON object and nothing else — no prose, no markdown code fences.`,
    `The object MUST validate against this JSON schema (name: "${schemaName}"); set "schema_version" to "1.0".`,
    schemaForPrompt(schemaName),
  ].join("\n");
}

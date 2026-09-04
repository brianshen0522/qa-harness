import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { LlmHealth, LlmPurpose, type LlmConfig } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import {
  createProviderRegistry, LlmProviderError,
  type LlmErrorKind, type ResolvedLlmConfig,
} from "./providers";

/** Consecutive failures before a config is taken out of the rotation. */
export const FAILURE_THRESHOLD = 3;
/** Probe backoff: 30s, 60s, 120s, 240s, capped at 5 minutes. */
const PROBE_BASE_MS = 30_000;
const PROBE_MAX_MS = 300_000;
const PROBE_TICK_MS = Number(process.env.LLM_PROBE_TICK_MS ?? 15_000);
const PROBE_PROMPT = "Reply with the single word: ok";

export interface HealthChange {
  configId: string;
  name: string;
  from: LlmHealth;
  to: LlmHealth;
  purposes: LlmPurpose[];
  reason: string;
}

type Registry = ReturnType<typeof createProviderRegistry>;

/**
 * Circuit breaker and recovery watchdog for LLM configs.
 *
 * A config that keeps failing is marked `down` and skipped when a chain is
 * chosen, so one broken provider cannot take a whole run with it. A probe loop
 * keeps testing every `down` config on a backoff and puts it straight back into
 * rotation the moment it answers. The loop runs for the lifetime of the process
 * and never gives up on a config.
 */
@Injectable()
export class LlmHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LlmHealthService.name);
  private readonly emitter = new EventEmitter();
  private providers: Registry = createProviderRegistry();
  private timer?: NodeJS.Timeout;
  private probing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {
    // Many runs can wait on the same recovery.
    this.emitter.setMaxListeners(0);
  }

  onModuleInit() {
    this.timer = setInterval(() => void this.probeOnce(), PROBE_TICK_MS);
    this.timer.unref?.();
    // Anything left `down` from a previous process is due for a probe right away.
    void this.prisma.llmConfig
      .updateMany({ where: { health: LlmHealth.down }, data: { nextProbeAt: new Date() } })
      .catch(() => undefined);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Test hook: swap provider adapters used by the probe. */
  setProviders(p: Partial<Registry>) {
    this.providers = { ...this.providers, ...p } as Registry;
  }

  onHealthChange(listener: (change: HealthChange) => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  // ---------- breaker ----------

  /** Provider-level failures trip the breaker; a bad JSON body does not. */
  async recordFailure(configId: string, kind: LlmErrorKind, message: string) {
    const config = await this.prisma.llmConfig.findUnique({ where: { id: configId } });
    if (!config) return;
    // Snapshot before the write: the row object must not be read back afterwards.
    const previous = { id: config.id, name: config.name, health: config.health, purposes: config.purposes };
    const failures = config.consecutiveFailures + 1;
    const shouldTrip = failures >= FAILURE_THRESHOLD && previous.health !== LlmHealth.down;

    const updated = await this.prisma.llmConfig.update({
      where: { id: configId },
      data: {
        consecutiveFailures: failures,
        lastFailureAt: new Date(),
        lastFailureKind: kind,
        lastFailureMessage: message.slice(0, 1000),
        // Once down, stay down. Anything else lets a broken config back into the
        // chain on its very next failure, which turns a pause into a hot loop.
        health: previous.health === LlmHealth.down || shouldTrip ? LlmHealth.down : LlmHealth.degraded,
        ...(shouldTrip
          ? { downSince: new Date(), probeAttempts: 0, nextProbeAt: new Date(Date.now() + PROBE_BASE_MS) }
          : {}),
      },
    });

    if (shouldTrip) {
      this.log.warn(`LLM config "${previous.name}" marked down after ${failures} failures (${kind}): ${message.slice(0, 200)}`);
      this.emit(previous, LlmHealth.down, `連續 ${failures} 次失敗（${kind}）`);
    }
    return updated;
  }

  async recordSuccess(configId: string) {
    const config = await this.prisma.llmConfig.findUnique({ where: { id: configId } });
    if (!config) return;
    if (config.health === LlmHealth.healthy && config.consecutiveFailures === 0) return;
    const previous = { id: config.id, name: config.name, health: config.health, purposes: config.purposes };

    await this.prisma.llmConfig.update({
      where: { id: configId },
      data: {
        health: LlmHealth.healthy,
        consecutiveFailures: 0,
        downSince: null,
        probeAttempts: 0,
        nextProbeAt: null,
        ...(previous.health === LlmHealth.down ? { lastRecoveredAt: new Date() } : {}),
      },
    });
    if (previous.health === LlmHealth.down) {
      this.log.log(`LLM config "${previous.name}" recovered`);
      this.emit(previous, LlmHealth.healthy, "重新可用");
    }
  }

  /** Called when an admin edits a config: give it another chance immediately. */
  async resetAfterEdit(configId: string) {
    const config = await this.prisma.llmConfig.findUnique({ where: { id: configId } });
    if (!config) return;
    const previous = { id: config.id, name: config.name, health: config.health, purposes: config.purposes };
    await this.prisma.llmConfig.update({
      where: { id: configId },
      data: { health: LlmHealth.healthy, consecutiveFailures: 0, downSince: null, probeAttempts: 0, nextProbeAt: null },
    });
    this.emit(previous, LlmHealth.healthy, "管理者已更新設定");
  }

  // ---------- availability ----------

  /** Enabled, healthy-or-degraded configs for a purpose, in chain order. */
  async usableConfigIds(purpose: LlmPurpose, requireVision = false): Promise<string[]> {
    const rows = await this.prisma.llmFallbackChain.findMany({
      where: {
        purpose,
        llmConfig: {
          enabled: true,
          health: { not: LlmHealth.down },
          ...(requireVision ? { supportsVision: true } : {}),
        },
      },
      orderBy: { order: "asc" },
      select: { llmConfigId: true },
    });
    return rows.map((r) => r.llmConfigId);
  }

  /** True when at least one config could serve this purpose right now. */
  async hasUsable(purpose: LlmPurpose, requireVision = false): Promise<boolean> {
    return (await this.usableConfigIds(purpose, requireVision)).length > 0;
  }

  /** Whether any config is configured for a purpose at all, healthy or not. */
  async hasAnyConfigured(purpose: LlmPurpose, requireVision = false): Promise<boolean> {
    const count = await this.prisma.llmFallbackChain.count({
      where: { purpose, llmConfig: { enabled: true, ...(requireVision ? { supportsVision: true } : {}) } },
    });
    return count > 0;
  }

  /**
   * Resolves once a config for this purpose is usable again. Used by long-running
   * work to wait instead of failing, so it continues the moment the LLM returns.
   */
  async waitForPurpose(purpose: LlmPurpose, requireVision: boolean, signal?: AbortSignal): Promise<boolean> {
    if (await this.hasUsable(purpose, requireVision)) return true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        off();
        clearInterval(poll);
        signal?.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const check = async () => {
        if (await this.hasUsable(purpose, requireVision)) finish(true);
      };
      const onAbort = () => finish(false);
      const off = this.onHealthChange(() => void check());
      // A safety net: an admin can add a whole new config, which is not a health
      // change on an existing one.
      const poll = setInterval(() => void check(), PROBE_TICK_MS);
      poll.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      // The signal may already have fired while the first availability check awaited.
      if (signal?.aborted) return finish(false);
      void check();
    });
  }

  // ---------- probing ----------

  async status() {
    const configs = await this.prisma.llmConfig.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true, name: true, provider: true, model: true, enabled: true, purposes: true,
        health: true, consecutiveFailures: true, downSince: true, lastFailureAt: true,
        lastFailureKind: true, lastFailureMessage: true, lastProbeAt: true, nextProbeAt: true,
        probeAttempts: true, lastRecoveredAt: true,
      },
    });
    const coverage: Record<LlmPurpose, { configured: number; usable: number }> = {
      discuss: { configured: 0, usable: 0 },
      generate: { configured: 0, usable: 0 },
      execute: { configured: 0, usable: 0 },
    };
    for (const c of configs) {
      if (!c.enabled) continue;
      for (const p of c.purposes) {
        coverage[p].configured++;
        if (c.health !== LlmHealth.down) coverage[p].usable++;
      }
    }
    return { configs, coverage, probeIntervalMs: PROBE_TICK_MS };
  }

  /** Probe one config on demand (admin "test again" button). */
  async probeConfig(configId: string): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
    const config = await this.prisma.llmConfig.findUnique({ where: { id: configId } });
    if (!config) return { ok: false, error: "設定不存在", latencyMs: 0 };
    return this.probe(config);
  }

  /**
   * One sweep of the probe loop. Runs forever on a timer; every error is
   * swallowed so a single bad config can never stop the watchdog.
   */
  async probeOnce(): Promise<number> {
    if (this.probing) return 0;
    this.probing = true;
    let recovered = 0;
    try {
      const due = await this.prisma.llmConfig.findMany({
        where: {
          enabled: true,
          health: LlmHealth.down,
          OR: [{ nextProbeAt: null }, { nextProbeAt: { lte: new Date() } }],
        },
      });
      for (const config of due) {
        const result = await this.probe(config);
        if (result.ok) recovered++;
      }
    } catch (err) {
      this.log.error(`probe sweep failed: ${(err as Error).message}`);
    } finally {
      this.probing = false;
    }
    return recovered;
  }

  private async probe(config: LlmConfig): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
    const resolved: ResolvedLlmConfig = {
      id: config.id,
      name: config.name,
      provider: config.provider,
      endpoint: config.endpoint,
      apiKey: config.apiKeyEncrypted ? this.crypto.decrypt(config.apiKeyEncrypted) : null,
      model: config.model,
      supportsVision: config.supportsVision,
    };
    const started = Date.now();
    try {
      await this.providers[config.provider].complete(resolved, {
        messages: [{ role: "user", content: PROBE_PROMPT }],
        maxTokens: 16,
        timeoutMs: 20_000,
      });
      await this.prisma.llmConfig.update({
        where: { id: config.id },
        data: { lastProbeAt: new Date() },
      });
      await this.recordSuccess(config.id);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      const kind = err instanceof LlmProviderError ? err.kind : "unknown";
      const wasDown = config.health === LlmHealth.down;
      const attempts = config.probeAttempts + 1;
      const delay = Math.min(PROBE_BASE_MS * 2 ** (attempts - 1), PROBE_MAX_MS);
      await this.prisma.llmConfig.update({
        where: { id: config.id },
        data: {
          lastProbeAt: new Date(),
          probeAttempts: attempts,
          nextProbeAt: new Date(Date.now() + delay),
          ...(wasDown
            ? // Already out of rotation: record why, but this is not a new failure.
              { lastFailureKind: kind, lastFailureMessage: (err as Error).message.slice(0, 1000) }
            : {}),
        },
      });
      // A healthy config that fails a hand-run probe goes through the same
      // threshold as any other failure, rather than dropping out on one bad call.
      if (!wasDown) await this.recordFailure(config.id, kind, (err as Error).message);
      return { ok: false, error: (err as Error).message, latencyMs: Date.now() - started };
    }
  }

  private emit(config: { id: string; name: string; health: LlmHealth; purposes: LlmPurpose[] }, to: LlmHealth, reason: string) {
    const change: HealthChange = {
      configId: config.id,
      name: config.name,
      from: config.health,
      to,
      purposes: config.purposes,
      reason,
    };
    this.emitter.emit("change", change);
  }
}

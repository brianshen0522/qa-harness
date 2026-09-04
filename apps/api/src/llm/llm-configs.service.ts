import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { LlmProvider, LlmPurpose, type LlmConfig, type LlmFallbackChain } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import type { ResolvedLlmConfig } from "./providers/types";

export interface LlmConfigInput {
  name: string;
  provider: LlmProvider;
  endpoint?: string | null;
  apiKey?: string | null; // undefined = keep existing; null/"" = clear
  model: string;
  purposes: LlmPurpose[];
  supportsVision: boolean;
  enabled: boolean;
}

export const ALL_PURPOSES: LlmPurpose[] = ["discuss", "generate", "execute"];

@Injectable()
export class LlmConfigsService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService) {}

  /** Public view: API key masked. */
  async list() {
    const rows = await this.prisma.llmConfig.findMany({ orderBy: { createdAt: "asc" }, include: { fallbackEntries: true } });
    return rows.map((r) => this.toPublic(r));
  }

  async get(id: string) {
    const row = await this.prisma.llmConfig.findUnique({ where: { id }, include: { fallbackEntries: true } });
    if (!row) throw new NotFoundException("LLM config not found");
    return this.toPublic(row);
  }

  async create(input: LlmConfigInput) {
    this.validate(input);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.llmConfig.create({
        data: {
          name: input.name,
          provider: input.provider,
          endpoint: input.endpoint || null,
          apiKeyEncrypted: input.apiKey ? this.crypto.encrypt(input.apiKey) : null,
          model: input.model,
          purposes: input.purposes,
          supportsVision: input.supportsVision,
          enabled: input.enabled,
        },
      });
      for (const purpose of input.purposes) {
        const max = await tx.llmFallbackChain.aggregate({ where: { purpose }, _max: { order: true } });
        await tx.llmFallbackChain.create({ data: { purpose, llmConfigId: created.id, order: (max._max.order ?? -1) + 1 } });
      }
      return created;
    });
    return this.get(row.id);
  }

  async update(id: string, input: Partial<LlmConfigInput>) {
    const existing = await this.prisma.llmConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("LLM config not found");
    const merged: LlmConfigInput = {
      name: input.name ?? existing.name,
      provider: input.provider ?? existing.provider,
      endpoint: input.endpoint === undefined ? existing.endpoint : input.endpoint,
      model: input.model ?? existing.model,
      purposes: input.purposes ?? existing.purposes,
      supportsVision: input.supportsVision ?? existing.supportsVision,
      enabled: input.enabled ?? existing.enabled,
    };
    this.validate(merged);
    if (!merged.enabled || merged.purposes.length < existing.purposes.length) {
      await this.assertPurposesStillCovered(id, merged.enabled ? merged.purposes : []);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.llmConfig.update({
        where: { id },
        data: {
          name: merged.name,
          provider: merged.provider,
          endpoint: merged.endpoint || null,
          model: merged.model,
          purposes: merged.purposes,
          supportsVision: merged.supportsVision,
          enabled: merged.enabled,
          ...(input.apiKey !== undefined
            ? { apiKeyEncrypted: input.apiKey ? this.crypto.encrypt(input.apiKey) : null }
            : {}),
        },
      });
      const removed = existing.purposes.filter((p) => !merged.purposes.includes(p));
      const added = merged.purposes.filter((p) => !existing.purposes.includes(p));
      if (removed.length) await tx.llmFallbackChain.deleteMany({ where: { llmConfigId: id, purpose: { in: removed } } });
      for (const purpose of added) {
        const max = await tx.llmFallbackChain.aggregate({ where: { purpose }, _max: { order: true } });
        await tx.llmFallbackChain.create({ data: { purpose, llmConfigId: id, order: (max._max.order ?? -1) + 1 } });
      }
    });
    return this.get(id);
  }

  async remove(id: string) {
    const existing = await this.prisma.llmConfig.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("LLM config not found");
    await this.assertPurposesStillCovered(id, []);
    await this.prisma.llmConfig.delete({ where: { id } });
    return { ok: true };
  }

  /** Ordered chain for a purpose (enabled configs only), with decrypted keys. Internal use. */
  async resolveChain(purpose: LlmPurpose): Promise<ResolvedLlmConfig[]> {
    const entries = await this.prisma.llmFallbackChain.findMany({
      where: { purpose, llmConfig: { enabled: true } },
      include: { llmConfig: true },
      orderBy: { order: "asc" },
    });
    return entries.map((e) => this.resolve(e.llmConfig));
  }

  async resolveOne(id: string): Promise<ResolvedLlmConfig> {
    const row = await this.prisma.llmConfig.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("LLM config not found");
    return this.resolve(row);
  }

  async chains() {
    const entries = await this.prisma.llmFallbackChain.findMany({
      include: { llmConfig: { select: { id: true, name: true, model: true, provider: true, enabled: true, supportsVision: true } } },
      orderBy: [{ purpose: "asc" }, { order: "asc" }],
    });
    const out: Record<LlmPurpose, typeof entries> = { discuss: [], generate: [], execute: [] };
    for (const e of entries) out[e.purpose].push(e);
    return out;
  }

  /** Replace the order of a purpose's chain. Every id must already carry that purpose. */
  async setChain(purpose: LlmPurpose, configIds: string[]) {
    const configs = await this.prisma.llmConfig.findMany({ where: { id: { in: configIds } } });
    if (configs.length !== new Set(configIds).size) throw new BadRequestException("Unknown config id in chain");
    for (const c of configs) {
      if (!c.purposes.includes(purpose)) throw new BadRequestException(`${c.name} does not have purpose ${purpose}`);
    }
    const current = await this.prisma.llmFallbackChain.findMany({ where: { purpose } });
    const missing = current.filter((c) => !configIds.includes(c.llmConfigId));
    if (missing.length) throw new BadRequestException("Chain must include every config with this purpose");
    await this.prisma.$transaction([
      this.prisma.llmFallbackChain.deleteMany({ where: { purpose } }),
      this.prisma.llmFallbackChain.createMany({
        data: configIds.map((llmConfigId, order) => ({ purpose, llmConfigId, order })),
      }),
    ]);
    return (await this.chains())[purpose];
  }

  /** Which purposes have at least one enabled config (spec: every purpose needs one). */
  async coverage(): Promise<Record<LlmPurpose, number>> {
    const rows = await this.prisma.llmFallbackChain.groupBy({
      by: ["purpose"],
      where: { llmConfig: { enabled: true } },
      _count: { _all: true },
    });
    const out: Record<LlmPurpose, number> = { discuss: 0, generate: 0, execute: 0 };
    for (const r of rows) out[r.purpose] = r._count._all;
    return out;
  }

  private validate(input: LlmConfigInput) {
    if (!input.purposes.length) throw new BadRequestException("Select at least one purpose");
    if (input.purposes.includes("execute") && !input.supportsVision) {
      throw new BadRequestException("Configs used for 'execute' must support vision");
    }
    if (input.provider !== "ollama" && !input.endpoint && !input.apiKey && input.provider === "openai") {
      // OpenAI cloud needs a key; compatible endpoints may not.
      throw new BadRequestException("OpenAI provider needs an API key or a custom endpoint");
    }
  }

  private async assertPurposesStillCovered(excludeId: string, keptPurposes: LlmPurpose[]) {
    const existing = await this.prisma.llmConfig.findUnique({ where: { id: excludeId } });
    if (!existing?.enabled) return;
    const losing = existing.purposes.filter((p) => !keptPurposes.includes(p));
    for (const purpose of losing) {
      const others = await this.prisma.llmFallbackChain.count({
        where: { purpose, llmConfigId: { not: excludeId }, llmConfig: { enabled: true } },
      });
      if (others === 0) {
        throw new BadRequestException(`This is the only enabled config for '${purpose}'. Add another before removing it.`);
      }
    }
  }

  private resolve(row: { id: string; name: string; provider: LlmProvider; endpoint: string | null; apiKeyEncrypted: string | null; model: string; supportsVision: boolean }): ResolvedLlmConfig {
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      endpoint: row.endpoint,
      apiKey: row.apiKeyEncrypted ? this.crypto.decrypt(row.apiKeyEncrypted) : null,
      model: row.model,
      supportsVision: row.supportsVision,
    };
  }

  private toPublic(row: LlmConfig & { fallbackEntries: LlmFallbackChain[] }) {
    const { apiKeyEncrypted, fallbackEntries, ...rest } = row;
    return {
      ...rest,
      hasApiKey: !!apiKeyEncrypted,
      apiKeyMasked: apiKeyEncrypted ? CryptoService.mask(this.crypto.decrypt(apiKeyEncrypted)) : null,
      chainPositions: Object.fromEntries(fallbackEntries.map((e) => [e.purpose, e.order])),
    };
  }
}

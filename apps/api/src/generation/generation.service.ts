import { BadRequestException, ConflictException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import {
  CaseSource, CaseStatus, GenerationMode, Prisma, Priority, Role, type CaseType, type TargetKind,
} from "@prisma/client";
import type { FeatureList, TestCaseOutput } from "@qa-harness/schemas";
import { PrismaService } from "../prisma/prisma.service";
import { acquireTargetLock, busyMessage, releaseTargetLock, targetLockHolder } from "../targets/target-lock";
import { PermissionsService } from "../permissions/permissions.service";
import { LlmExhaustedError, LlmGatewayService } from "../llm/llm-gateway.service";
import { LlmHealthService } from "../llm/llm-health.service";
import { AuditService } from "../audit/audit.service";
import { DiscoveryService, type DiscoveryResult } from "./discovery.service";
import { DesktopDiscoveryService } from "./desktop-discovery.service";
import { SkillsService } from "../skills/skills.service";

export type GenerationEvent =
  | { type: "started"; runId: string; target: string; kind: TargetKind; mode: GenerationMode; descriptionVersion: number }
  | { type: "discovery"; ok: boolean; source: string | null; note: string }
  | { type: "features"; features: { name: string; description: string }[]; model: string }
  | { type: "feature_started"; index: number; total: number; name: string }
  | { type: "feature_cases"; index: number; total: number; name: string; count: number; model: string }
  | { type: "deduped"; kept: number; dropped: number }
  | { type: "saved"; featureCount: number; caseCount: number }
  | { type: "error"; message: string; detail?: unknown }
  /** No usable model; the run is waiting and will pick up where it stopped. */
  | { type: "paused"; reason: string; message: string; featureIndex: number; total: number }
  | { type: "resumed"; message: string }
  | { type: "finished"; runId: string; featureCount: number; caseCount: number; durationMs: number };

/** Partial results kept on the run row so a paused run resumes mid-pipeline. */
export interface GenerationProgress {
  features: { name: string; description: string }[];
  /** Index of the next feature to expand. */
  featureIndex: number;
  cases: GeneratedCase[];
  discovery: { ok: boolean; source: string | null; note: string; summary: string };
  lastModel: string | null;
}

/** Cases per feature we ask for; more than this and quality drops off. */
const MAX_CASES_PER_FEATURE = 12;
const MAX_FEATURES = 40;

type Subscriber = (event: GenerationEvent) => void;

interface ActiveRun {
  runId: string;
  targetId: string;
  events: GenerationEvent[];
  subscribers: Set<Subscriber>;
  abort: AbortController;
  /** Set once the run reaches a terminal event; the record is evicted later. */
  finished: boolean;
}

/**
 * A finished run stays readable for a while. Without this, a fast run can be
 * over before the browser's stream attaches, and its events would be lost.
 */
const RETAIN_FINISHED_MS = 120_000;

@Injectable()
export class GenerationService implements OnModuleInit {
  private readonly log = new Logger(GenerationService.name);
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly gateway: LlmGatewayService,
    private readonly discovery: DiscoveryService,
    private readonly health: LlmHealthService,
    private readonly audit: AuditService,
    private readonly skills: SkillsService,
    private readonly desktopDiscovery: DesktopDiscoveryService,
  ) {}

  /**
   * A run left mid-flight by a restart is picked up again from its stored
   * progress, so a crash or deploy does not silently abandon it.
   */
  async onModuleInit() {
    const orphans = await this.prisma.generationRun
      .findMany({ where: { status: { in: ["running", "paused"] } } })
      .catch(() => []);
    for (const run of orphans) {
      this.log.log(`resuming generation run ${run.id} after restart`);
      this.spawn(run.id, run.targetId, run.triggeredById);
    }
  }

  /**
   * Starts a run in the background and returns immediately. Progress is streamed
   * to subscribers, but the run does not depend on anyone listening: closing the
   * browser does not stop it.
   */
  async start(
    targetId: string,
    userId: string,
    mode: GenerationMode,
    opts: { onlyFeatureIds?: string[] } = {},
  ): Promise<{ runId: string }> {
    await this.perms.requireTarget(targetId, userId, Role.editor);

    const target = await this.prisma.qaTarget.findUniqueOrThrow({
      where: { id: targetId },
      select: { status: true, descriptionVersion: true },
    });
    if (this.isInFlight(targetId)) throw new ConflictException("已經有一個生成流程在進行中。");
    const inFlight = await this.prisma.generationRun.findFirst({
      where: { targetId, status: { in: ["running", "paused"] } },
    });
    if (inFlight) throw new ConflictException("已經有一個生成流程在進行中。");
    if (!(await acquireTargetLock(this.prisma, targetId))) {
      const holder = await targetLockHolder(this.prisma, targetId);
      throw new ConflictException(`${busyMessage(holder)},無法同時生成測試清單。`);
    }

    // Regenerating one feature is not "replace the world": only that feature's
    // generated cases go (§4.4 只針對受影響 feature 重生成).
    const onlyFeatureIds = opts.onlyFeatureIds?.length
      ? (
          await this.prisma.feature.findMany({
            where: { targetId, id: { in: opts.onlyFeatureIds } },
            select: { id: true },
          })
        ).map((f) => f.id)
      : [];
    if (opts.onlyFeatureIds?.length && !onlyFeatureIds.length) {
      throw new BadRequestException("指定的功能都不屬於這個 Target。");
    }

    try {
      const run = await this.prisma.generationRun.create({
        data: {
          targetId, mode, descriptionVersion: target.descriptionVersion,
          triggeredById: userId, onlyFeatureIds,
        },
      });
      this.spawn(run.id, targetId, userId);
      return { runId: run.id };
    } catch (err) {
      await releaseTargetLock(this.prisma, targetId);
      throw err;
    }
  }

  /** Replays what has happened so far, then streams the rest. */
  subscribe(targetId: string, subscriber: Subscriber): () => void {
    const run = this.active.get(targetId);
    if (!run) return () => undefined;
    for (const event of run.events) subscriber(event);
    if (run.finished) return () => undefined;
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  /** A run that is still going, or finished recently enough to replay. */
  activeRun(targetId: string) {
    const run = this.active.get(targetId);
    return run ? { runId: run.runId, events: run.events, finished: run.finished } : null;
  }

  /** True while a run is actually in flight, which is what blocks a new start. */
  private isInFlight(targetId: string): boolean {
    const run = this.active.get(targetId);
    return !!run && !run.finished;
  }

  async cancel(targetId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const run = this.active.get(targetId);
    if (!run) return { cancelled: false };
    run.abort.abort();
    return { cancelled: true };
  }

  private spawn(runId: string, targetId: string, userId: string) {
    const record: ActiveRun = {
      runId, targetId, events: [], subscribers: new Set(), abort: new AbortController(), finished: false,
    };
    this.active.set(targetId, record);
    // The run itself is deliberately not awaited: it outlives the request that
    // started it, so closing the browser does not stop it.
    void this.execute(record, userId)
      .catch(async (err) => {
        this.log.error(`generation run ${runId} crashed: ${(err as Error).message}`);
        this.publish(record, { type: "error", message: (err as Error).message });
        await this.prisma.generationRun
          .update({ where: { id: runId }, data: { status: "failed", error: String(err).slice(0, 2000), endedAt: new Date() } })
          .catch(() => undefined);
      })
      .finally(() => {
        void releaseTargetLock(this.prisma, record.targetId);
        record.finished = true;
        record.subscribers.clear();
        const evict = setTimeout(() => {
          if (this.active.get(targetId) === record) this.active.delete(targetId);
        }, RETAIN_FINISHED_MS);
        evict.unref?.();
      });
  }

  /**
   * Spec §4.3: description + config + attachments + handoff + discovery
   * → feature inventory → cases per feature → dedupe and order → persist.
   *
   * Every model call goes through `withLlm`, which pauses the run instead of
   * failing it when no model can serve the request.
   */
  private async execute(record: ActiveRun, userId: string) {
    const startedAt = Date.now();
    const run = await this.prisma.generationRun.findUniqueOrThrow({ where: { id: record.runId } });
    const target = await this.prisma.qaTarget.findUniqueOrThrow({
      where: { id: record.targetId },
      include: { project: { select: { name: true, description: true } } },
    });

    await this.prisma.generationRun.update({
      where: { id: run.id },
      data: { status: "running", pausedReason: null, pausedAt: null },
    });

    this.publish(record, {
      type: "started", runId: run.id, target: target.name, kind: target.kind,
      mode: run.mode, descriptionVersion: run.descriptionVersion,
    });

    try {
      const saved = (run.progress as unknown as GenerationProgress | null) ?? null;

      // ----- discovery (recomputed only on a fresh run) -----
      let discovery: DiscoveryResult;
      if (saved?.discovery) {
        discovery = { ...saved.discovery, kind: target.kind } as DiscoveryResult;
      } else {
        discovery = target.kind === "desktop"
          ? await this.desktopDiscovery.discover((target.config ?? {}) as Record<string, unknown>, userId)
          : await this.discovery.discover(target.kind, (target.config ?? {}) as Record<string, unknown>);
      }
      this.publish(record, { type: "discovery", ok: discovery.ok, source: discovery.source, note: discovery.note });

      const context = await this.buildRunContext(target, discovery);
      // §4.5: house rules (global + project) fold into every generate prompt.
      const skillsBlock = await this.skills.promptBlock(target.projectId);
      const withSkills = (sys: string) => [skillsBlock, sys].filter(Boolean).join("\n\n");

      // ----- step 1: feature inventory -----
      let features = saved?.features ?? [];
      let lastModel = saved?.lastModel ?? null;
      if (!features.length && run.onlyFeatureIds.length) {
        // A targeted regeneration already knows which features it is about;
        // asking the model to re-derive the inventory would only invite drift.
        const rows = await this.prisma.feature.findMany({
          where: { id: { in: run.onlyFeatureIds } },
          orderBy: { order: "asc" },
          select: { name: true, description: true },
        });
        features = rows.map((f) => ({ name: f.name, description: f.description }));
        if (!features.length) throw new BadRequestException("要重生成的功能已經不存在了。");
      }
      if (!features.length) {
        const res = await this.withLlm(record, run.id, () =>
          this.gateway.structured("generate", "feature_list", {
            system: withSkills(FEATURE_SYSTEM),
            messages: [{ role: "user", content: context }],
            maxTokens: 4096,
            reasoningEffort: "low",
          }, { context: { projectId: target.projectId, targetId: target.id } }),
        );
        if (!res) return; // cancelled while paused
        features = dedupeFeatures(res.data).slice(0, MAX_FEATURES);
        lastModel = res.model;
        if (!features.length) throw new BadRequestException("模型沒有產出任何功能，請先補充描述再試一次。");
      }
      this.publish(record, { type: "features", features, model: lastModel ?? "" });

      // ----- step 2: cases per feature, resumable -----
      const collected: GeneratedCase[] = saved?.cases ?? [];
      let index = saved?.featureIndex ?? 0;
      while (index < features.length) {
        if (record.abort.signal.aborted) return this.markCancelled(record, run.id);
        const feature = features[index];
        this.publish(record, { type: "feature_started", index: index + 1, total: features.length, name: feature.name });

        const res = await this.withLlm(record, run.id, () =>
          this.gateway.structured("generate", "test_case", {
            system: withSkills(caseSystem(target.kind)),
            messages: [
              { role: "user", content: context },
              { role: "user", content: featurePrompt(feature, features) },
            ],
            maxTokens: 8192,
            reasoningEffort: "low",
          }, { context: { projectId: target.projectId, targetId: target.id } }),
          { features, featureIndex: index, cases: collected, discovery: toStoredDiscovery(discovery), lastModel },
        );
        if (!res) return; // cancelled while paused

        lastModel = res.model;
        const cases = normaliseCases(res.data, feature.name).slice(0, MAX_CASES_PER_FEATURE);
        collected.push(...cases);
        index++;
        this.publish(record, {
          type: "feature_cases", index, total: features.length,
          name: feature.name, count: cases.length, model: res.model,
        });
        await this.saveProgress(run.id, {
          features, featureIndex: index, cases: collected,
          discovery: toStoredDiscovery(discovery), lastModel,
        });
      }

      // ----- step 3: dedupe, order, persist -----
      const { kept, dropped } = dedupeCases(collected, features.map((f) => f.name));
      this.publish(record, { type: "deduped", kept: kept.length, dropped });
      if (!kept.length) throw new BadRequestException("模型沒有產出任何測試案例。");

      const persisted = await this.persist(
        record.targetId, userId, run.mode, run.descriptionVersion, features, kept, run.onlyFeatureIds,
      );
      this.publish(record, { type: "saved", featureCount: persisted.featureCount, caseCount: persisted.caseCount });

      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: "succeeded",
          featureCount: persisted.featureCount,
          caseCount: persisted.caseCount,
          duplicatesDropped: dropped,
          discovery: toStoredDiscovery(discovery) as unknown as Prisma.InputJsonObject,
          model: lastModel,
          progress: Prisma.DbNull,
          endedAt: new Date(),
        },
      });
      await this.audit.log("user", userId, "generation.run", record.targetId, {
        runId: run.id, mode: run.mode, features: persisted.featureCount, cases: persisted.caseCount,
      });
      this.publish(record, {
        type: "finished", runId: run.id, featureCount: persisted.featureCount,
        caseCount: persisted.caseCount, durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`generation failed for ${record.targetId}: ${message}`);
      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: { status: "failed", error: message.slice(0, 2000), endedAt: new Date() },
      });
      this.publish(record, { type: "error", message });
    }
  }

  /**
   * Runs one model call. If every config is unusable the run is parked rather
   * than failed: progress is saved, the row is marked paused, and the call is
   * retried the moment a model is available again. Returns null only if the run
   * was cancelled while waiting.
   */
  private async withLlm<T>(
    record: ActiveRun,
    runId: string,
    call: () => Promise<T>,
    progress?: GenerationProgress,
  ): Promise<T | null> {
    for (;;) {
      if (record.abort.signal.aborted) {
        await this.markCancelled(record, runId);
        return null;
      }
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof LlmExhaustedError) || !err.recoverable) throw err;
        if (progress) await this.saveProgress(runId, progress);

        const featureIndex = progress?.featureIndex ?? 0;
        const total = progress?.features.length ?? 0;
        await this.prisma.generationRun.update({
          where: { id: runId },
          data: { status: "paused", pausedReason: err.message.slice(0, 1000), pausedAt: new Date() },
        });
        this.publish(record, {
          type: "paused",
          reason: err.reason,
          message: `${err.message} 已保留進度，有可用的 LLM 之後會自動接續。`,
          featureIndex,
          total,
        });

        const ok = await this.health.waitForPurpose("generate", false, record.abort.signal);
        if (!ok) {
          await this.markCancelled(record, runId);
          return null;
        }
        await this.prisma.generationRun.update({
          where: { id: runId },
          data: { status: "running", pausedReason: null, pausedAt: null },
        });
        this.publish(record, { type: "resumed", message: "LLM 已恢復，從中斷的地方繼續。" });
      }
    }
  }

  private saveProgress(runId: string, progress: GenerationProgress) {
    return this.prisma.generationRun.update({
      where: { id: runId },
      data: { progress: progress as unknown as Prisma.InputJsonObject },
    });
  }

  private async markCancelled(record: ActiveRun, runId: string) {
    await this.prisma.generationRun.update({
      where: { id: runId },
      data: { status: "failed", error: "已取消", endedAt: new Date() },
    });
    this.publish(record, { type: "error", message: "生成已取消。" });
  }

  private publish(record: ActiveRun, event: GenerationEvent) {
    record.events.push(event);
    for (const subscriber of record.subscribers) {
      try {
        subscriber(event);
      } catch {
        record.subscribers.delete(subscriber);
      }
    }
  }

  /** Context is rebuilt rather than stored: it can be large and is cheap to redo. */
  private async buildRunContext(
    target: { projectId: string; id: string; name: string; kind: TargetKind; config: Prisma.JsonValue; description: string; project: { name: string; description: string } },
    discovery: DiscoveryResult,
  ): Promise<string> {
    const [attachments, handoffs] = await Promise.all([
      this.prisma.projectAttachment.findMany({
        where: { projectId: target.projectId },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { filename: true, url: true, textContent: true },
      }),
      this.prisma.handoffDocument.findMany({
        where: { OR: [{ targetId: target.id }, { projectId: target.projectId, scope: "project" }] },
        orderBy: { importedAt: "desc" },
        take: 2,
        select: { parsed: true, scope: true },
      }),
    ]);
    return buildContext({
      projectName: target.project.name,
      projectDescription: target.project.description,
      targetName: target.name,
      kind: target.kind,
      config: (target.config ?? {}) as Record<string, unknown>,
      targetDescription: target.description,
      discovery,
      attachments,
      suggested: collectSuggestedCases(handoffs),
    });
  }

  private async persist(
    targetId: string,
    userId: string,
    mode: GenerationMode,
    descriptionVersion: number,
    features: { name: string; description: string }[],
    cases: GeneratedCase[],
    onlyFeatureIds: string[] = [],
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (onlyFeatureIds.length) {
        // Scoped regeneration: clear out only the generated cases of the features
        // being redone, and leave everything else in the list untouched.
        await tx.testCase.deleteMany({
          where: { targetId, featureId: { in: onlyFeatureIds }, source: { not: CaseSource.manual } },
        });
      } else if (mode === GenerationMode.replace) {
        await tx.testCase.deleteMany({ where: { targetId, source: CaseSource.generated } });
        const orphanFeatures = await tx.feature.findMany({
          where: { targetId },
          select: { id: true, _count: { select: { testCases: true } } },
        });
        await tx.feature.deleteMany({
          where: { id: { in: orphanFeatures.filter((f) => f._count.testCases === 0).map((f) => f.id) } },
        });
      }

      const featureIds = new Map<string, string>();
      let featureOrder = (await tx.feature.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1;
      for (const feature of features) {
        featureOrder++;
        const row = await tx.feature.upsert({
          where: { targetId_name: { targetId, name: feature.name } },
          create: {
            targetId, name: feature.name, description: feature.description,
            basedOnDescriptionVersion: descriptionVersion, order: featureOrder,
          },
          update: {
            description: feature.description,
            status: "active",
            basedOnDescriptionVersion: descriptionVersion,
          },
        });
        featureIds.set(feature.name, row.id);
      }

      let caseOrder = (await tx.testCase.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1;
      let caseCount = 0;
      for (const c of cases) {
        caseOrder++;
        const created = await tx.testCase.create({
          data: {
            targetId,
            featureId: featureIds.get(c.feature_ref) ?? null,
            title: c.title,
            precondition: c.precondition,
            steps: c.steps as Prisma.InputJsonValue,
            expected: c.expected,
            priority: c.priority as Priority,
            type: c.type as CaseType,
            source: CaseSource.generated,
            status: CaseStatus.active,
            order: caseOrder,
            basedOnDescriptionVersion: descriptionVersion,
            createdById: userId,
          },
        });
        await tx.testCaseVersion.create({
          data: {
            testCaseId: created.id,
            version: 1,
            content: snapshot(created) as Prisma.InputJsonObject,
            createdBy: userId,
          },
        });
        caseCount++;
      }
      return { featureCount: featureIds.size, caseCount };
    }, { timeout: 120_000 });
  }

  /** Discovery fields kept on the run row, without the bulky endpoint list. */

  runs(targetId: string, userId: string) {
    return this.perms.requireTarget(targetId, userId, Role.viewer).then(() =>
      this.prisma.generationRun.findMany({
        where: { targetId },
        orderBy: { startedAt: "desc" },
        take: 20,
      }),
    );
  }
}

// ---------- shaping ----------

export interface GeneratedCase {
  feature_ref: string;
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
  priority: string;
  type: string;
}

export function snapshot(c: {
  title: string; precondition: string; steps: unknown; expected: string;
  priority: string; type: string; featureId: string | null;
}) {
  return {
    title: c.title, precondition: c.precondition, steps: c.steps,
    expected: c.expected, priority: c.priority, type: c.type, featureId: c.featureId,
  };
}

export function dedupeFeatures(list: FeatureList): { name: string; description: string }[] {
  const seen = new Set<string>();
  const out: { name: string; description: string }[] = [];
  for (const f of list.features ?? []) {
    const name = f.name?.trim();
    if (!name) continue;
    const key = normalise(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, description: (f.description ?? "").trim() });
  }
  return out;
}

/** Keep only cases the schema allows, and pin them to a known feature. */
export function normaliseCases(output: TestCaseOutput, featureName: string): GeneratedCase[] {
  return (output.cases ?? [])
    .filter((c) => c.title?.trim() && c.expected?.trim() && Array.isArray(c.steps) && c.steps.length)
    .map((c) => ({
      feature_ref: featureName,
      title: c.title.trim(),
      precondition: (c.precondition ?? "").trim(),
      steps: c.steps.map((s) => String(s).trim()).filter(Boolean),
      expected: c.expected.trim(),
      priority: c.priority,
      type: c.type,
    }));
}

const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const TYPE_ORDER: Record<string, number> = { happy: 0, edge: 1, negative: 2 };

/**
 * Similarity above which two cases count as the same. Calibrated on real and
 * synthetic pairs: rewordings of one case score 0.81-0.93, while genuinely
 * different cases top out around 0.61. Deliberately biased towards keeping —
 * a stray duplicate is a click to delete, a dropped case is silent lost coverage.
 */
export const DUPLICATE_THRESHOLD = 0.75;

/**
 * Spec §4.3 step 3. Done in code rather than with another model call: it is
 * deterministic, costs nothing, and near-duplicate cases are the failure mode
 * that actually shows up when each feature is generated independently.
 *
 * The fingerprint is title plus expected result, because the title alone cannot
 * separate "Create todo succeeds" from "Delete todo succeeds".
 */
export function dedupeCases(
  cases: GeneratedCase[],
  featureOrder: string[],
): { kept: GeneratedCase[]; dropped: number } {
  const featureRank = new Map(featureOrder.map((name, i) => [name, i]));
  const kept: GeneratedCase[] = [];
  const fingerprints: Set<string>[] = [];

  for (const c of cases) {
    const tokens = tokenise(`${c.title} ${c.expected}`);
    const duplicate = fingerprints.some((prev) => jaccard(prev, tokens) >= DUPLICATE_THRESHOLD);
    if (duplicate) continue;
    fingerprints.push(tokens);
    kept.push(c);
  }

  kept.sort((a, b) => {
    const fa = featureRank.get(a.feature_ref) ?? 999;
    const fb = featureRank.get(b.feature_ref) ?? 999;
    if (fa !== fb) return fa - fb;
    const pa = PRIORITY_ORDER[a.priority] ?? 9;
    const pb = PRIORITY_ORDER[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9);
  });

  return { kept, dropped: cases.length - kept.length };
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

/**
 * Character bigrams over the whole normalised string. Uniform across scripts:
 * word tokens do not work for Chinese, which has no spaces, and word-level
 * comparison in English weighs a single differing verb far too lightly.
 */
export function tokenise(s: string): Set<string> {
  const compact = s.toLowerCase().replace(/[\p{P}\s]+/gu, "");
  if (compact.length < 2) return new Set([compact]);
  const grams = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) grams.add(compact.slice(i, i + 2));
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// ---------- prompts ----------

const FEATURE_SYSTEM = [
  "你是資深 QA 分析師。根據提供的資料，整理出這個被測目標的「功能清單」。",
  "",
  "規則：",
  "- 一個功能是使用者看得到、可以被測的能力，不是程式內部的模組或檔案。",
  "- 名稱用簡短的名詞短語，例如「使用者登入」「待辦清單篩選」，不要寫成句子。",
  "- description 說明這個功能做什麼、涵蓋哪些行為，一到三句。",
  "- 只列出資料裡真的存在的功能，不要憑空補上常見功能。",
  "- 不確定是否存在的功能不要列。寧可少也不要猜。",
  "- 用繁體中文。",
].join("\n");

function caseSystem(kind: TargetKind): string {
  const executor =
    kind === "api"
      ? "測試會由程式直接打 HTTP API，步驟要寫成可以照做的請求描述（方法、路徑、關鍵參數、要檢查的回應欄位或狀態碼）。"
      : kind === "web"
        ? "測試會由一個看著畫面操作瀏覽器的 agent 執行，步驟要寫成人看得懂的操作（點什麼、輸入什麼、預期畫面出現什麼）。"
        : "測試會由一個操作桌面應用程式的 agent 執行，步驟要寫成具體的視窗操作。";

  return [
    "你是資深 QA 工程師。針對指定的「單一功能」寫出測試案例。",
    "",
    executor,
    "",
    "規則：",
    "- 只針對這一個功能出題，其他功能會另外處理，不要重複別的功能的內容。",
    "- 覆蓋三種類型：happy（正常流程）、edge（邊界，例如空值、極長、極限數量）、negative（錯誤處理，例如無權限、格式錯誤）。",
    "- 優先級 P0 是壞掉就無法使用的核心流程，P1 重要，P2 一般，P3 邊緣。",
    "- 每條案例要能獨立執行：precondition 寫清楚執行前需要什麼狀態或資料。",
    "- steps 是有序的具體動作，每步一件事，不要把多個動作塞在一行。",
    "- expected 要可判定，寫出具體可觀察的結果，不要寫「正常運作」這種無法驗證的敘述。",
    `- 一個功能最多 ${MAX_CASES_PER_FEATURE} 條，重要的功能才需要接近上限。`,
    "- feature_ref 必須完全等於指定的功能名稱。",
    "- 用繁體中文。",
  ].join("\n");
}

function featurePrompt(feature: { name: string; description: string }, all: { name: string }[]): string {
  return [
    `# 現在要出題的功能：${feature.name}`,
    feature.description ? `說明：${feature.description}` : "",
    "",
    "這個目標的完整功能清單（避免和其他功能重複出題）：",
    all.map((f) => `- ${f.name}`).join("\n"),
  ].filter(Boolean).join("\n");
}

const SECRET_KEY = /(pass(word|wd)?|token|api[_-]?key|apikey|secret|credential|authorization|bearer)/i;

/** Config can hold an Authorization header; never let it reach the model. */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown, key = ""): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, walk(val, k)]));
    }
    if (typeof v === "string" && SECRET_KEY.test(key) && v.length > 0) return "****（已遮蔽）";
    return v;
  };
  return walk(config) as Record<string, unknown>;
}

function collectSuggestedCases(
  handoffs: { parsed: Prisma.JsonValue; scope: string }[],
): { title: string; steps?: string[]; expected?: string }[] {
  const out: { title: string; steps?: string[]; expected?: string }[] = [];
  for (const doc of handoffs) {
    const parsed = doc.parsed as { suggestedTestCases?: { title: string; steps?: string[]; expected?: string }[] } | null;
    for (const c of parsed?.suggestedTestCases ?? []) if (c?.title) out.push(c);
  }
  return out.slice(0, 40);
}

function buildContext(input: {
  projectName: string;
  projectDescription: string;
  targetName: string;
  kind: TargetKind;
  config: Record<string, unknown>;
  targetDescription: string;
  discovery: DiscoveryResult;
  attachments: { filename: string; url: string | null; textContent: string | null }[];
  suggested: { title: string; steps?: string[]; expected?: string }[];
}): string {
  const parts: string[] = [
    `# 被測目標`,
    `專案：${input.projectName}`,
    `目標：${input.targetName}（種類：${input.kind}）`,
    "",
    "## 目標設定",
    "```json",
    JSON.stringify(redactConfig(input.config), null, 2).slice(0, 3000),
    "```",
  ];

  if (input.targetDescription.trim()) {
    parts.push("", "## 目標描述", input.targetDescription.trim().slice(0, 20_000));
  }
  if (input.projectDescription.trim()) {
    parts.push("", "## 專案描述", input.projectDescription.trim().slice(0, 8000));
  }
  if (input.discovery.summary) {
    parts.push("", input.discovery.summary);
  }
  if (input.suggested.length) {
    parts.push("", "## coding agent 交接文件建議的測試案例（可以參考，但要自己判斷是否合理）");
    parts.push(
      ...input.suggested.map((c) =>
        [`- ${c.title}`, ...(c.steps ?? []).map((s) => `  - ${s}`), c.expected ? `  預期：${c.expected}` : ""]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  }
  for (const a of input.attachments) {
    if (!a.textContent?.trim()) continue;
    parts.push("", `## 參考資料：${a.filename}${a.url ? `（${a.url}）` : ""}`, a.textContent.slice(0, 4000));
  }
  return parts.join("\n");
}

function toStoredDiscovery(d: DiscoveryResult) {
  return { ok: d.ok, source: d.source, note: d.note, summary: d.summary };
}

import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import {
  CaseSource, CaseStatus, GenerationMode, Prisma, Priority, Role, type CaseType, type TargetKind,
} from "@prisma/client";
import type { FeatureList, TestCaseOutput } from "@qa-harness/schemas";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { LlmExhaustedError, LlmGatewayService } from "../llm/llm-gateway.service";
import { AuditService } from "../audit/audit.service";
import { DiscoveryService, type DiscoveryResult } from "./discovery.service";

export type GenerationEvent =
  | { type: "started"; runId: string; target: string; kind: TargetKind; mode: GenerationMode; descriptionVersion: number }
  | { type: "discovery"; ok: boolean; source: string | null; note: string }
  | { type: "features"; features: { name: string; description: string }[]; model: string }
  | { type: "feature_started"; index: number; total: number; name: string }
  | { type: "feature_cases"; index: number; total: number; name: string; count: number; model: string }
  | { type: "deduped"; kept: number; dropped: number }
  | { type: "saved"; featureCount: number; caseCount: number }
  | { type: "error"; message: string; detail?: unknown }
  | { type: "finished"; runId: string; featureCount: number; caseCount: number; durationMs: number };

/** Cases per feature we ask for; more than this and quality drops off. */
const MAX_CASES_PER_FEATURE = 12;
const MAX_FEATURES = 40;

@Injectable()
export class GenerationService {
  private readonly log = new Logger(GenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly gateway: LlmGatewayService,
    private readonly discovery: DiscoveryService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Spec §4.3: description + config + attachments + handoff + discovery
   * → feature inventory → cases per feature → dedupe and order → persist.
   */
  async *run(targetId: string, userId: string, mode: GenerationMode): AsyncGenerator<GenerationEvent> {
    await this.perms.requireTarget(targetId, userId, Role.editor);

    const target = await this.prisma.qaTarget.findUniqueOrThrow({
      where: { id: targetId },
      include: { project: { select: { name: true, description: true, id: true } } },
    });
    if (target.status === "running") {
      throw new ConflictException("Target 執行中，無法重新生成測試清單。");
    }
    const inFlight = await this.prisma.generationRun.findFirst({ where: { targetId, status: "running" } });
    if (inFlight) throw new ConflictException("已經有一個生成流程在進行中。");

    const startedAt = Date.now();
    const run = await this.prisma.generationRun.create({
      data: { targetId, mode, descriptionVersion: target.descriptionVersion, triggeredById: userId },
    });

    yield {
      type: "started", runId: run.id, target: target.name, kind: target.kind,
      mode, descriptionVersion: target.descriptionVersion,
    };

    try {
      // ----- context -----
      const [attachments, handoffs] = await Promise.all([
        this.prisma.projectAttachment.findMany({
          where: { projectId: target.projectId },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { filename: true, url: true, textContent: true },
        }),
        this.prisma.handoffDocument.findMany({
          where: { OR: [{ targetId }, { projectId: target.projectId, scope: "project" }] },
          orderBy: { importedAt: "desc" },
          take: 2,
          select: { parsed: true, scope: true },
        }),
      ]);

      const discovery = await this.discovery.discover(
        target.kind,
        (target.config ?? {}) as Record<string, unknown>,
      );
      yield { type: "discovery", ok: discovery.ok, source: discovery.source, note: discovery.note };

      const suggested = collectSuggestedCases(handoffs);
      const context = buildContext({
        projectName: target.project.name,
        projectDescription: target.project.description,
        targetName: target.name,
        kind: target.kind,
        config: (target.config ?? {}) as Record<string, unknown>,
        targetDescription: target.description,
        discovery,
        attachments,
        suggested,
      });

      // ----- step 1: feature inventory -----
      const featureRes = await this.gateway.structured("generate", "feature_list", {
        system: FEATURE_SYSTEM,
        messages: [{ role: "user", content: context }],
        maxTokens: 4096,
      });
      const features = dedupeFeatures(featureRes.data).slice(0, MAX_FEATURES);
      if (!features.length) throw new BadRequestException("模型沒有產出任何功能，請先補充描述再試一次。");
      yield { type: "features", features, model: featureRes.model };

      // ----- step 2: cases per feature -----
      const collected: GeneratedCase[] = [];
      let lastModel = featureRes.model;
      for (const [index, feature] of features.entries()) {
        yield { type: "feature_started", index: index + 1, total: features.length, name: feature.name };
        const caseRes = await this.gateway.structured("generate", "test_case", {
          system: caseSystem(target.kind),
          messages: [
            { role: "user", content: context },
            { role: "user", content: featurePrompt(feature, features) },
          ],
          maxTokens: 8192,
        });
        lastModel = caseRes.model;
        const cases = normaliseCases(caseRes.data, feature.name).slice(0, MAX_CASES_PER_FEATURE);
        collected.push(...cases);
        yield {
          type: "feature_cases", index: index + 1, total: features.length,
          name: feature.name, count: cases.length, model: caseRes.model,
        };
      }

      // ----- step 3: dedupe and order -----
      const { kept, dropped } = dedupeCases(collected, features.map((f) => f.name));
      yield { type: "deduped", kept: kept.length, dropped };
      if (!kept.length) throw new BadRequestException("模型沒有產出任何測試案例。");

      const saved = await this.persist(targetId, userId, mode, target.descriptionVersion, features, kept);
      yield { type: "saved", featureCount: saved.featureCount, caseCount: saved.caseCount };

      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: "succeeded",
          featureCount: saved.featureCount,
          caseCount: saved.caseCount,
          duplicatesDropped: dropped,
          discovery: { ok: discovery.ok, source: discovery.source, note: discovery.note } as Prisma.InputJsonObject,
          model: lastModel,
          endedAt: new Date(),
        },
      });
      await this.audit.log("user", userId, "generation.run", targetId, {
        runId: run.id, mode, features: saved.featureCount, cases: saved.caseCount,
      });

      yield {
        type: "finished", runId: run.id, featureCount: saved.featureCount,
        caseCount: saved.caseCount, durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err instanceof LlmExhaustedError
          ? `${err.message}（${err.attempts.map((a) => `${a.configName}:${a.outcome}`).join(", ")}）`
          : (err as Error).message;
      this.log.warn(`generation failed for ${targetId}: ${message}`);
      await this.prisma.generationRun.update({
        where: { id: run.id },
        data: { status: "failed", error: message.slice(0, 2000), endedAt: new Date() },
      });
      yield { type: "error", message, detail: err instanceof LlmExhaustedError ? err.attempts : undefined };
    }
  }

  /** Replace drops previously generated rows; manual and proposal-sourced cases always survive. */
  private async persist(
    targetId: string,
    userId: string,
    mode: GenerationMode,
    descriptionVersion: number,
    features: { name: string; description: string }[],
    cases: GeneratedCase[],
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (mode === GenerationMode.replace) {
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
function tokenise(s: string): Set<string> {
  const compact = s.toLowerCase().replace(/[\p{P}\s]+/gu, "");
  if (compact.length < 2) return new Set([compact]);
  const grams = new Set<string>();
  for (let i = 0; i < compact.length - 1; i++) grams.add(compact.slice(i, i + 2));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
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

import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit,
} from "@nestjs/common";
import {
  CaseStatus, Prisma, QueueStatus, Role, RunStatus, Severity, Verdict, type TargetKind,
} from "@prisma/client";
import type { CaseVerdict, ExecutionStep } from "@qa-harness/schemas";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { AuditService } from "../audit/audit.service";
import { LlmExhaustedError, LlmGatewayService, type AttemptLog } from "../llm/llm-gateway.service";
import { LlmHealthService } from "../llm/llm-health.service";
import type { ContentPart, LlmMessage } from "../llm/providers";
import { SandboxService, parseResolution, toSandboxUrl } from "../sandbox/sandbox.service";
import { ComputerService } from "../sandbox/computer.service";
import { TargetsService } from "../targets/targets.service";
import { SkillsService } from "../skills/skills.service";
import { McpService } from "../mcp/mcp.service";
import type { McpToolForPrompt } from "./run-prompts";
import { EvidenceService } from "./evidence.service";
import { HttpExecutorService, fillCredentials, type HttpLog } from "./http-executor.service";
import { ApiSetupService, type SetupStep } from "./api-setup.service";
import { acquireTargetLock, busyMessage, targetLockHolder } from "../targets/target-lock";
import { fenceUntrusted } from "../common/untrusted";
import { SCREENSHOT_WINDOW, buildMessages, maskSecrets } from "./run-utils";
import {
  caseSystemPrompt, verdictSystemPrompt, verdictTranscript,
  type CaseForPrompt, type TargetForPrompt,
} from "./run-prompts";

export type RunEvent =
  | { type: "run_started"; runId: string; target: string; kind: TargetKind; total: number }
  | { type: "sandbox"; sandboxId: string | null; name: string | null; viewUrl: string | null; note: string }
  | { type: "setup_step"; seq: number; label: string; method: string; path: string; result: { ok: boolean; status: number | null; durationMs: number; error?: string }; captured: string[]; scope: "target" | "feature"; featureName?: string }
  | { type: "setup_done"; captured: string[]; stepCount: number; scope: "target" | "feature"; featureName?: string }
  | { type: "setup_failed"; message: string; scope: "target" | "feature"; featureName?: string }
  | { type: "case_started"; caseId: string; title: string; index: number; total: number; caseVersion: number }
  | {
      type: "step"; caseId: string; seq: number; phase: ExecutionStep["phase"];
      action: ExecutionStep["action"]; intent: string; observation: string;
      result: { ok: boolean; durationMs: number; error?: string };
      model: string; screenshotKey: string | null;
    }
  | { type: "finding"; id: string; caseId: string | null; severity: Severity; title: string; description: string }
  | {
      type: "case_finished"; caseId: string; verdict: Verdict; reasoning: string;
      possiblyChanged: boolean; stepCount: number; durationMs: number;
    }
  | { type: "case_skipped"; caseId: string; title: string }
  | { type: "case_added"; caseId: string; title: string; total: number }
  | { type: "paused"; reason: string; message: string }
  | { type: "resumed"; message: string }
  | { type: "run_finished"; runId: string; status: RunStatus; counts: Record<string, number>; durationMs: number }
  | { type: "error"; message: string };

type Subscriber = (event: RunEvent) => void;

interface ActiveRun {
  runId: string;
  targetId: string;
  events: RunEvent[];
  subscribers: Set<Subscriber>;
  abort: AbortController;
  /** Cases the user asked to skip while the run is going. */
  skip: Set<string>;
  /** Project the run belongs to, for usage attribution (§4.8). Set once known. */
  projectId: string | null;
  /** Which models actually served this run, and where the chain fell over. */
  llm: LlmUsage;
  /** The case being executed, so a fallback can be pinned to where it happened. */
  currentCaseId: string | null;
  finished: boolean;
}

/** §4.7 「使用的 model（含 fallback 切換紀錄）」. */
export interface LlmUsage {
  configs: {
    configId: string;
    configName: string;
    models: string[];
    calls: number;
    failures: number;
  }[];
  switches: {
    at: string;
    fromConfigName: string;
    toConfigName: string;
    reason: string;
    caseId: string | null;
  }[];
  /** Times every config in the chain was exhausted and the run had to wait. */
  outages: { at: string; reason: string; caseId: string | null }[];
}

function emptyUsage(): LlmUsage {
  return { configs: [], switches: [], outages: [] };
}


/** A finished run stays readable so a late subscriber still sees how it went. */
const RETAIN_FINISHED_MS = 120_000;
/** Cap on the in-memory replay log per run, so a huge run does not balloon memory.
 *  A late subscriber still gets live state from the polled run detail. */
const MAX_EVENTS = 2000;

@Injectable()
export class RunService implements OnModuleInit {
  private readonly log = new Logger(RunService.name);
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly gateway: LlmGatewayService,
    private readonly health: LlmHealthService,
    private readonly sandbox: SandboxService,
    private readonly computer: ComputerService,
    private readonly http: HttpExecutorService,
    private readonly evidence: EvidenceService,
    private readonly targets: TargetsService,
    private readonly audit: AuditService,
    private readonly skills: SkillsService,
    private readonly mcp: McpService,
    private readonly apiSetup: ApiSetupService,
  ) {}

  /**
   * A process restart leaves the target locked and the run orphaned. The
   * in-memory agent state is gone, so the honest thing is to close the run out
   * and release the lock rather than pretend it is still going.
   */
  async onModuleInit() {
    const orphans = await this.prisma.testRun
      .findMany({ where: { status: { in: [RunStatus.running, RunStatus.paused, RunStatus.queued] } } })
      .catch(() => []);
    for (const run of orphans) {
      this.log.warn(`closing orphaned run ${run.id} after restart`);
      await this.prisma.testRun.update({
        where: { id: run.id },
        data: { status: RunStatus.failed, error: "API 重新啟動，這次執行已中斷。", endedAt: new Date() },
      }).catch(() => undefined);
      await this.releaseTarget(run.targetId, run.sandboxId);
    }
  }

  // ---------- lifecycle ----------

  /**
   * Spec §4.5: one run per target at a time, enforced with a conditional update
   * so two requests cannot both win. Nothing queues and nothing takes over.
   */
  async start(targetId: string, userId: string, caseIds?: string[]) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const target = await this.prisma.qaTarget.findUniqueOrThrow({ where: { id: targetId } });

    // Busy check first, so the message is accurate ("正在探索/生成") even when the
    // target happens to have no runnable cases. The atomic lock below still wins races.
    const busy = await targetLockHolder(this.prisma, targetId);
    if (busy) throw new ConflictException(`${busyMessage(busy)},無法同時執行 QA。`);

    const cases = await this.prisma.testCase.findMany({
      where: {
        targetId,
        ...(caseIds?.length ? { id: { in: caseIds } } : { status: CaseStatus.active }),
      },
      orderBy: { order: "asc" },
    });
    if (!cases.length) {
      throw new BadRequestException(
        caseIds?.length ? "選取的案例都不存在。" : "沒有狀態為「正常」的測試案例可以執行。",
      );
    }

    if (!(await acquireTargetLock(this.prisma, targetId))) {
      const holder = await targetLockHolder(this.prisma, targetId);
      throw new ConflictException(`${busyMessage(holder)},無法同時執行 QA。`);
    }

    try {
      const configs = await this.prisma.llmConfig.findMany({
        where: { enabled: true },
        select: { id: true, name: true, provider: true, model: true, purposes: true, health: true },
      });
      const run = await this.prisma.testRun.create({
        data: {
          targetId,
          status: RunStatus.running,
          triggeredById: userId,
          llmConfigSnapshot: configs as unknown as Prisma.InputJsonValue,
          queue: {
            create: cases.map((c, order) => ({ testCaseId: c.id, order })),
          },
        },
      });
      await this.audit.log("user", userId, "run.start", run.id, { targetId, cases: cases.length });
      this.spawn(run.id, targetId, target.name, target.kind, cases.length);
      return { runId: run.id, total: cases.length };
    } catch (err) {
      await this.releaseTarget(targetId, null);
      throw err;
    }
  }

  subscribe(targetId: string, subscriber: Subscriber): () => void {
    const run = this.active.get(targetId);
    if (!run) return () => undefined;
    for (const event of run.events) subscriber(event);
    if (run.finished) return () => undefined;
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  activeRun(targetId: string) {
    const run = this.active.get(targetId);
    return run ? { runId: run.runId, events: run.events, finished: run.finished } : null;
  }

  async abort(targetId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const run = this.active.get(targetId);
    if (!run || run.finished) return { aborted: false };
    run.abort.abort();
    await this.audit.log("user", userId, "run.abort", run.runId);
    return { aborted: true };
  }

  /** §4.6: skip a case that has not started yet. */
  async skipCase(targetId: string, caseId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const run = this.active.get(targetId);
    if (!run || run.finished) throw new BadRequestException("目前沒有進行中的執行。");
    const row = await this.prisma.runCaseQueue.findUnique({
      where: { runId_testCaseId: { runId: run.runId, testCaseId: caseId } },
    });
    if (!row) throw new NotFoundException("這條案例不在本次執行的清單裡。");
    if (row.status !== QueueStatus.queued) throw new BadRequestException("只能跳過還沒開始的案例。");
    run.skip.add(caseId);
    return { skipped: true };
  }

  /** §4.6: append a case to the end of the run that is already going. */
  async addCase(targetId: string, caseId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const run = this.active.get(targetId);
    if (!run || run.finished) throw new BadRequestException("目前沒有進行中的執行。");
    const testCase = await this.prisma.testCase.findUnique({ where: { id: caseId } });
    if (!testCase || testCase.targetId !== targetId) throw new NotFoundException("案例不屬於這個 Target。");

    const existing = await this.prisma.runCaseQueue.findUnique({
      where: { runId_testCaseId: { runId: run.runId, testCaseId: caseId } },
    });
    if (existing) throw new BadRequestException("這條案例已經在本次執行的清單裡。");

    const max = await this.prisma.runCaseQueue.aggregate({ where: { runId: run.runId }, _max: { order: true } });
    await this.prisma.runCaseQueue.create({
      data: { runId: run.runId, testCaseId: caseId, order: (max._max.order ?? -1) + 1 },
    });
    const total = await this.prisma.runCaseQueue.count({ where: { runId: run.runId } });
    this.publish(run, { type: "case_added", caseId, title: testCase.title, total });
    return { added: true, total };
  }

  // ---------- execution ----------

  private spawn(runId: string, targetId: string, targetName: string, kind: TargetKind, total: number) {
    const record: ActiveRun = {
      runId, targetId, events: [], subscribers: new Set(),
      abort: new AbortController(), skip: new Set(), projectId: null,
      llm: emptyUsage(), currentCaseId: null, finished: false,
    };
    this.active.set(targetId, record);
    this.publish(record, { type: "run_started", runId, target: targetName, kind, total });

    void this.execute(record)
      .catch(async (err) => {
        this.log.error(`run ${runId} crashed: ${(err as Error).message}`);
        this.publish(record, { type: "error", message: (err as Error).message });
        await this.prisma.testRun
          .update({ where: { id: runId }, data: { status: RunStatus.failed, error: String(err).slice(0, 2000), endedAt: new Date() } })
          .catch(() => undefined);
      })
      .finally(() => {
        record.finished = true;
        record.subscribers.clear();
        const evict = setTimeout(() => {
          if (this.active.get(targetId) === record) this.active.delete(targetId);
        }, RETAIN_FINISHED_MS);
        evict.unref?.();
      });
  }

  private async execute(record: ActiveRun) {
    const startedAt = Date.now();
    const settings = await this.sandbox.settings();
    const target = await this.prisma.qaTarget.findUniqueOrThrow({ where: { id: record.targetId } });
    record.projectId = target.projectId;
    const credentials = await this.targets.decryptedCredentials(record.targetId);
    // §4.5: global + project house rules fold into every case's system prompt.
    const skillsBlock = await this.skills.promptBlock(target.projectId);
    // §6.2 MCP: tools from enabled global + project servers, offered to the agent.
    const mcpTools = await this.mcp.toolsForProject(target.projectId).catch(() => []);
    const mcpForPrompt: McpToolForPrompt[] = mcpTools.map((t) => ({ serverId: t.serverId, server: t.server, name: t.tool.name, description: t.tool.description }));
    const needsSandbox = target.kind !== "api";

    let sandboxId: string | null = null;
    let agentPort: number | null = null;
    let screen = parseResolution(settings.resolution);

    try {
      if (needsSandbox) {
        const startUrl = typeof (target.config as Record<string, unknown>)?.url === "string"
          ? String((target.config as Record<string, unknown>).url)
          : undefined;
        const instance = await this.sandbox.create(record.runId, { purpose: "run", startUrl, ttlMinutes: 240 });
        sandboxId = instance.id;
        agentPort = instance.agentPort;
        screen = parseResolution(instance.resolution ?? settings.resolution);
        await this.prisma.testRun.update({
          where: { id: record.runId },
          data: { sandboxId: instance.id, sandboxName: instance.name, viewUrl: instance.viewUrl },
        });
        this.publish(record, {
          type: "sandbox", sandboxId: instance.id, name: instance.name,
          viewUrl: instance.viewUrl, note: `已啟動 sandbox（${instance.resolution}）`,
        });
      } else {
        this.publish(record, { type: "sandbox", sandboxId: null, name: null, viewUrl: null, note: "API 類型不需要 sandbox" });
      }

      // §4.4 前置流程 state。target 層級跑一次(login→token 這種全站共用);feature
      // 層級在該 feature 首條 case 前才跑一次,變數只給該 feature 的 case。
      let setupSeqUsed = 0;
      const featureCaptured = new Map<string, Record<string, string>>();
      const featureSetupFailed = new Map<string, string>();
      const setupConfig = () => {
        const cfg = (target.config ?? {}) as Record<string, unknown>;
        return { base_url: String(cfg.base_url ?? ""), headers: (cfg.headers as Record<string, string>) ?? undefined };
      };

      // target 層級 setup 失敗代表所有 case 的前置都不成立,直接把整趟 run 標為 failed。
      if (!needsSandbox) {
        const targetSteps = await this.apiSetup.stepsFor(target.id);
        if (targetSteps.length) {
          const r = await this.runSetupFlow(record, targetSteps, setupConfig(), credentials, setupSeqUsed, "target");
          setupSeqUsed += r.recorded;
          if (!r.ok) {
            this.publish(record, { type: "setup_failed", message: r.error ?? "前置流程失敗", scope: "target" });
            await this.prisma.testRun.update({ where: { id: record.runId }, data: { error: (r.error ?? "前置流程失敗").slice(0, 2000) } });
            await this.prisma.runCaseQueue.updateMany({ where: { runId: record.runId, status: QueueStatus.queued }, data: { status: QueueStatus.skipped } });
            await this.finish(record, RunStatus.failed, startedAt);
            return;
          }
          Object.assign(credentials, r.captured);
          this.publish(record, { type: "setup_done", captured: Object.keys(r.captured), stepCount: r.recorded, scope: "target" });
        }
      }

      const targetPrompt: TargetForPrompt = {
        name: target.name,
        kind: target.kind,
        description: target.description,
        config: (target.config ?? {}) as Record<string, unknown>,
        credentialKeys: Object.keys(credentials),
        screen: { width: screen[0], height: screen[1] },
      };

      // The queue is re-read each round so cases added mid-run are picked up.
      for (;;) {
        if (record.abort.signal.aborted) break;
        const next = await this.prisma.runCaseQueue.findFirst({
          where: { runId: record.runId, status: QueueStatus.queued },
          orderBy: { order: "asc" },
          include: { testCase: { include: { feature: { select: { name: true } } } } },
        });
        if (!next) break;

        if (record.skip.has(next.testCaseId)) {
          await this.prisma.runCaseQueue.update({
            where: { runId_testCaseId: { runId: record.runId, testCaseId: next.testCaseId } },
            data: { status: QueueStatus.skipped },
          });
          await this.writeResult(record.runId, next.testCaseId, next.testCase.currentVersion, {
            verdict: Verdict.skipped, reasoning: "使用者在執行中跳過。", possiblyChanged: false,
            reproSteps: [], evidence: {}, stepCount: 0, durationMs: 0,
          });
          this.publish(record, { type: "case_skipped", caseId: next.testCaseId, title: next.testCase.title });
          continue;
        }

        const total = await this.prisma.runCaseQueue.count({ where: { runId: record.runId } });
        const index = await this.prisma.runCaseQueue.count({
          where: { runId: record.runId, status: { not: QueueStatus.queued } },
        });

        // §4.5: the version is pinned the moment the case starts.
        await this.prisma.runCaseQueue.update({
          where: { runId_testCaseId: { runId: record.runId, testCaseId: next.testCaseId } },
          data: { status: QueueStatus.running, caseVersion: next.testCase.currentVersion },
        });
        this.publish(record, {
          type: "case_started", caseId: next.testCaseId, title: next.testCase.title,
          index: index + 1, total, caseVersion: next.testCase.currentVersion,
        });

        record.currentCaseId = next.testCaseId;

        // §4.4 feature 層級前置流程:在該 feature 第一條 case 前跑一次,擷取的變數只給
        // 這個 feature 的 case;失敗只擋這個 feature 的 case,不影響其他 feature。
        const featureId = next.testCase.featureId;
        let caseCreds = credentials;
        let casePrompt = targetPrompt;
        if (!needsSandbox && featureId) {
          if (!featureCaptured.has(featureId) && !featureSetupFailed.has(featureId)) {
            const fsteps = await this.apiSetup.featureStepsFor(featureId);
            if (fsteps.length) {
              const fname = next.testCase.feature?.name ?? undefined;
              const r = await this.runSetupFlow(record, fsteps, setupConfig(), credentials, setupSeqUsed, "feature", fname);
              setupSeqUsed += r.recorded;
              if (r.ok) {
                featureCaptured.set(featureId, r.captured);
                this.publish(record, { type: "setup_done", captured: Object.keys(r.captured), stepCount: r.recorded, scope: "feature", featureName: fname });
              } else {
                featureSetupFailed.set(featureId, r.error ?? "前置流程失敗");
                this.publish(record, { type: "setup_failed", message: r.error ?? "前置流程失敗", scope: "feature", featureName: fname });
              }
            } else {
              featureCaptured.set(featureId, {});
            }
          }
          const failMsg = featureSetupFailed.get(featureId);
          if (failMsg) {
            await this.writeResult(record.runId, next.testCaseId, next.testCase.currentVersion, {
              verdict: Verdict.blocked, reasoning: `所屬功能的前置流程失敗,無法執行:${failMsg}`,
              possiblyChanged: false, reproSteps: [], evidence: {}, stepCount: 0, durationMs: 0,
            });
            this.publish(record, {
              type: "case_finished", caseId: next.testCaseId, verdict: Verdict.blocked,
              reasoning: `所屬功能的前置流程失敗:${failMsg}`, possiblyChanged: false, stepCount: 0, durationMs: 0,
            });
            await this.prisma.runCaseQueue.update({
              where: { runId_testCaseId: { runId: record.runId, testCaseId: next.testCaseId } },
              data: { status: QueueStatus.done },
            });
            record.currentCaseId = null;
            continue;
          }
          const extra = featureCaptured.get(featureId);
          if (extra && Object.keys(extra).length) {
            caseCreds = { ...credentials, ...extra };
            casePrompt = { ...targetPrompt, credentialKeys: Object.keys(caseCreds) };
          }
        }

        await this.runCase(record, {
          target, targetPrompt: casePrompt, credentials: caseCreds, settings, agentPort, skillsBlock, mcpTools: mcpForPrompt,
          queueRow: next, needsSandbox,
        });

        await this.prisma.runCaseQueue.update({
          where: { runId_testCaseId: { runId: record.runId, testCaseId: next.testCaseId } },
          data: { status: QueueStatus.done },
        });
        record.currentCaseId = null;
        await this.saveUsage(record);
      }

      const aborted = record.abort.signal.aborted;
      if (aborted) {
        await this.prisma.runCaseQueue.updateMany({
          where: { runId: record.runId, status: QueueStatus.queued },
          data: { status: QueueStatus.skipped },
        });
      }
      await this.finish(record, aborted ? RunStatus.aborted : RunStatus.succeeded, startedAt);
    } finally {
      await this.releaseTarget(record.targetId, sandboxId);
    }
  }

  /** One case: drive the agent, then judge what happened. */
  private async runCase(
    record: ActiveRun,
    ctx: {
      target: { id: string; kind: TargetKind; config: Prisma.JsonValue };
      targetPrompt: TargetForPrompt;
      credentials: Record<string, string>;
      settings: { maxStepsPerCase: number; stepTimeoutSec: number; recordVideo: boolean };
      skillsBlock: string;
      mcpTools: McpToolForPrompt[];
      agentPort: number | null;
      queueRow: { testCaseId: string; testCase: { title: string; precondition: string; steps: Prisma.JsonValue; expected: string; priority: string; type: string; currentVersion: number; feature: { name: string } | null } };
      needsSandbox: boolean;
    },
  ) {
    const caseStarted = Date.now();
    const testCase = ctx.queueRow.testCase;
    const forPrompt: CaseForPrompt = {
      title: testCase.title,
      precondition: testCase.precondition,
      steps: (testCase.steps as string[]) ?? [],
      expected: testCase.expected,
      priority: testCase.priority,
      type: testCase.type,
      featureName: testCase.feature?.name ?? null,
    };
    const system = [ctx.skillsBlock, caseSystemPrompt(ctx.targetPrompt, forPrompt, ctx.mcpTools)].filter(Boolean).join("\n\n");
    const stepTimeoutMs = Math.max(ctx.settings.stepTimeoutSec * 1000, 60_000);
    const maxSteps = ctx.settings.maxStepsPerCase;

    // §4.7 錄影: one recording per case, so the video lines up with the verdict.
    const recording = ctx.needsSandbox && ctx.agentPort !== null && ctx.settings.recordVideo;
    if (recording) {
      const started = await this.computer.startRecording(ctx.agentPort!);
      if (!started.ok) this.log.warn(`recording did not start: ${started.error ?? "unknown"}`);
    }

    const turns: { assistant: string; user: ContentPart[] }[] = [];
    const transcript: { seq: number; phase: string; intent: string; observation: string; action: unknown; result?: unknown }[] = [];
    const screenshots: string[] = [];
    // Recent base64 frames (capped) so the judge can SEE the end state, not just the
    // agent's self-reported observations.
    const frames: string[] = [];
    const httpLogs: HttpLog[] = [];
    let seq = 0;
    let stopReason = `已達步數上限（${maxSteps}）`;

    while (seq < maxSteps) {
      if (record.abort.signal.aborted) {
        stopReason = "使用者中止執行";
        break;
      }
      seq++;

      // Screenshot first for anything with a screen; api targets have none.
      let screenshot: string | null = null;
      if (ctx.needsSandbox && ctx.agentPort) {
        const shot = await this.computer.screenshot(ctx.agentPort);
        if (!shot.ok || !shot.image) {
          stopReason = `截圖失敗：${shot.error ?? "沒有影像"}`;
          break;
        }
        screenshot = shot.image;
        frames.push(screenshot);
        if (frames.length > SCREENSHOT_WINDOW) frames.shift();
      }

      const decided = await this.withLlm(record, () =>
        this.gateway.structured(
          "execute",
          "execution_step",
          // Low reasoning effort: deciding one next action is not a hard reasoning
          // problem, and left free the model spends the 2048-token budget thinking
          // and returns nothing ("no content outside its reasoning block"), which
          // shows up as invalid_output retries — wasted latency and real cost.
          { system, messages: buildMessages(turns, screenshot, seq, maxSteps), maxTokens: 2048, timeoutMs: stepTimeoutMs, reasoningEffort: "low" },
          { maxRetries: 3, requireVision: ctx.needsSandbox, context: { projectId: record.projectId, targetId: record.targetId } },
        ),
      );
      if (!decided) {
        stopReason = "使用者中止執行";
        break;
      }
      const step = decided.data;

      if (step.action.type === "done") {
        stopReason = String(step.action.params?.summary ?? step.observation ?? "代理回報完成");
        // The frame at `done` proves the final state; earlier step shots are all
        // pre-action, so without this the outcome is never captured as evidence.
        const doneKey = screenshot
          ? (await this.evidence.putScreenshot(record.runId, ctx.queueRow.testCaseId, seq, screenshot))?.key ?? null
          : null;
        if (doneKey) screenshots.push(doneKey);
        transcript.push({ seq, phase: step.phase, intent: step.intent, observation: step.observation, action: step.action });
        await this.recordStep(record, ctx.queueRow.testCaseId, seq, step, null, decided.model, 0, doneKey);
        break;
      }

      if (step.action.type === "mcp_call") {
        const p = (step.action.params ?? {}) as { server_id?: string; tool?: string; arguments?: Record<string, unknown> };
        let feedback: string;
        let ok = true;
        try {
          const result = await this.mcp.callTool(String(p.server_id ?? ""), String(p.tool ?? ""), (p.arguments ?? {}) as Record<string, unknown>);
          ok = !result.isError;
          feedback = `MCP 工具「${p.tool}」回傳：\n${fenceUntrusted("MCP 工具回傳", result.text.slice(0, 4000))}`;
        } catch (err) {
          ok = false;
          feedback = `MCP 工具「${p.tool}」呼叫失敗：${(err as Error).message}`;
        }
        transcript.push({ seq, phase: step.phase, intent: step.intent, observation: step.observation, action: step.action, result: { ok, text: feedback.slice(0, 500) } });
        turns.push({
          assistant: JSON.stringify({ intent: step.intent, action: step.action }),
          user: [{ type: "text", text: feedback }],
        });
        await this.recordStep(record, ctx.queueRow.testCaseId, seq, step, { ok, durationMs: 0, detail: {} }, decided.model, 0, null);
        continue;
      }

      if (step.action.type === "report_finding") {
        await this.recordFinding(record, ctx.queueRow.testCaseId, step);
        transcript.push({ seq, phase: step.phase, intent: step.intent, observation: step.observation, action: step.action });
        turns.push({
          assistant: JSON.stringify({ intent: step.intent, action: step.action }),
          user: [{ type: "text", text: "Finding 已記下。請回到這條 case 原本的流程。" }],
        });
        await this.recordStep(record, ctx.queueRow.testCaseId, seq, step, null, decided.model, 0, null);
        continue;
      }

      const outcome = await this.performAction(step, ctx, stepTimeoutMs, httpLogs);
      const screenshotKey = screenshot
        ? (await this.evidence.putScreenshot(record.runId, ctx.queueRow.testCaseId, seq, screenshot))?.key ?? null
        : null;
      if (screenshotKey) screenshots.push(screenshotKey);

      transcript.push({
        seq, phase: step.phase, intent: step.intent, observation: step.observation,
        action: step.action, result: outcome.detail,
      });
      await this.recordStep(record, ctx.queueRow.testCaseId, seq, step, outcome, decided.model, outcome.durationMs, screenshotKey);

      turns.push({
        assistant: JSON.stringify({ phase: step.phase, intent: step.intent, action: step.action }),
        user: [
          ...(screenshot ? [{ type: "image" as const, mediaType: "image/png" as const, base64: screenshot }] : []),
          { type: "text" as const, text: describeOutcome(step, outcome) },
        ],
      });
    }

    // Stop before judging: the judge call takes a while and nothing happens on
    // screen during it, so recording through it would only pad the file.
    const videoKey = recording ? await this.storeRecording(record.runId, ctx.queueRow.testCaseId, ctx.agentPort!) : null;

    // ----- judge -----
    const verdict = await this.judge(record, forPrompt, transcript, stopReason, frames, ctx.needsSandbox);
    const durationMs = Date.now() - caseStarted;

    await this.writeResult(record.runId, ctx.queueRow.testCaseId, testCase.currentVersion, {
      verdict: (verdict?.verdict ?? Verdict.blocked) as Verdict,
      reasoning: verdict?.reasoning ?? "無法取得判定（模型不可用）。",
      possiblyChanged: verdict?.possibly_changed ?? false,
      reproSteps: verdict?.repro_steps ?? [],
      evidence: { screenshots, video: videoKey, httpLogs, evidenceRefs: verdict?.evidence_refs ?? [] },
      stepCount: seq,
      durationMs,
    });
    this.publish(record, {
      type: "case_finished",
      caseId: ctx.queueRow.testCaseId,
      verdict: (verdict?.verdict ?? Verdict.blocked) as Verdict,
      reasoning: verdict?.reasoning ?? "無法取得判定。",
      possiblyChanged: verdict?.possibly_changed ?? false,
      stepCount: seq,
      durationMs,
    });
  }

  /** Never throws: a missing video is a smaller loss than a lost verdict. */
  private async storeRecording(runId: string, caseId: string, agentPort: number): Promise<string | null> {
    try {
      const stopped = await this.computer.stopRecording(agentPort);
      if (!stopped.ok || !stopped.detail?.was_recording) return null;
      const bytes = await this.computer.fetchRecording(agentPort);
      if (!bytes) return null;
      const stored = await this.evidence.putVideo(runId, caseId, bytes);
      if (stored) this.log.log(`case ${caseId}: stored ${(stored.bytes / 1e6).toFixed(1)}MB recording`);
      return stored?.key ?? null;
    } catch (err) {
      this.log.warn(`failed to store recording for case ${caseId}: ${(err as Error).message}`);
      return null;
    }
  }

  private async judge(
    record: ActiveRun,
    testCase: CaseForPrompt,
    transcript: { seq: number; phase: string; intent: string; observation: string; action: unknown; result?: unknown }[],
    stopReason: string,
    frames: string[] = [],
    withVision = false,
  ): Promise<CaseVerdict | null> {
    // Show the judge the actual last frames, not just the agent's self-reported
    // observations, so it can catch a "登入成功" that the screen contradicts.
    const content: ContentPart[] = [
      ...(withVision ? frames.map((base64) => ({ type: "image" as const, mediaType: "image/png" as const, base64 })) : []),
      { type: "text" as const, text: verdictTranscript(transcript, stopReason) },
    ];
    const decided = await this.withLlm(record, () =>
      this.gateway.structured("execute", "case_verdict", {
        system: verdictSystemPrompt(testCase),
        messages: [{ role: "user", content }],
        // A judgment call deserves to think, but not so much it blanks the budget on
        // a 90s proxy; a generous ceiling lets it reason and still emit the object.
        maxTokens: 4096,
        reasoningEffort: "medium",
      }, { requireVision: withVision && frames.length > 0, context: { projectId: record.projectId, targetId: record.targetId } }),
    );
    if (!decided) return null;
    // Drop evidence refs that do not point at a real step, so the UI never shows a
    // citation like step-9 of a 5-step run.
    const validRefs = new Set(transcript.map((t) => `step-${t.seq}`));
    const verdict = decided.data;
    if (Array.isArray(verdict.evidence_refs)) {
      verdict.evidence_refs = verdict.evidence_refs.filter((r) => validRefs.has(r));
    }
    return verdict;
  }

  private async performAction(
    step: ExecutionStep,
    ctx: {
      target: { config: Prisma.JsonValue };
      credentials: Record<string, string>;
      agentPort: number | null;
      needsSandbox: boolean;
    },
    timeoutMs: number,
    httpLogs: HttpLog[],
  ): Promise<{ ok: boolean; durationMs: number; error?: string; detail: Record<string, unknown> }> {
    const { type, params } = step.action;
    const args = (params ?? {}) as Record<string, unknown>;

    if (type === "wait") {
      const ms = Math.max(100, Math.min(Number(args.ms ?? 1000) || 1000, 30_000));
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, durationMs: ms, detail: { waited_ms: ms } };
    }

    if (type === "http_request") {
      const result = await this.http.perform(
        args,
        (ctx.target.config ?? {}) as Record<string, string>,
        ctx.credentials,
        timeoutMs,
      );
      httpLogs.push(result.log);
      return { ok: result.ok, durationMs: result.durationMs, error: result.error, detail: result.detail };
    }

    if (!ctx.needsSandbox || !ctx.agentPort) {
      return { ok: false, durationMs: 0, error: `這個 Target 不支援「${type}」動作`, detail: {} };
    }

    // Credentials are filled in here so the real value never reaches the model,
    // and a loopback URL is pointed at the host the sandbox actually runs on.
    const filled =
      type === "type" && typeof args.text === "string"
        ? { ...args, text: fillCredentials(args.text, ctx.credentials) }
        : type === "navigate" && typeof args.url === "string"
          ? { ...args, url: toSandboxUrl(args.url) }
          : args;
    const res = await this.computer.perform(ctx.agentPort, type, filled, timeoutMs);
    return { ok: res.ok, durationMs: res.durationMs, error: res.error, detail: res.detail };
  }

  /**
   * Wraps every model call so losing the LLM parks the run instead of failing
   * it, and the same step is retaken once a model returns. Null means the user
   * aborted while it waited.
   */
  private async withLlm<T extends { attempts: AttemptLog[] }>(
    record: ActiveRun,
    call: () => Promise<T>,
  ): Promise<T | null> {
    for (;;) {
      if (record.abort.signal.aborted) return null;
      try {
        const result = await call();
        this.noteLlm(record, result.attempts);
        return result;
      } catch (err) {
        if (!(err instanceof LlmExhaustedError) || !err.recoverable) throw err;
        // Everything it tried on the way down still counts as usage.
        this.noteLlm(record, err.attempts);
        record.llm.outages.push({
          at: new Date().toISOString(),
          reason: err.message.slice(0, 300),
          caseId: record.currentCaseId,
        });
        await this.saveUsage(record);
        await this.prisma.testRun.update({
          where: { id: record.runId },
          data: { status: RunStatus.paused, pausedReason: err.message.slice(0, 1000) },
        });
        this.publish(record, {
          type: "paused",
          reason: err.reason,
          message: `${err.message} 執行已暫停並保留進度，有可用的 LLM 之後會自動接續。`,
        });

        const ok = await this.health.waitForPurpose("execute", false, record.abort.signal);
        if (!ok) return null;

        await this.prisma.testRun.update({
          where: { id: record.runId },
          data: { status: RunStatus.running, pausedReason: null },
        });
        this.publish(record, { type: "resumed", message: "LLM 已恢復，從中斷的那一步繼續。" });
      }
    }
  }

  /**
   * Folds one gateway call's attempts into the run's usage record. A run that
   * quietly finished on the third config looks identical to one that never
   * faltered unless the hand-off is written down somewhere.
   */
  private noteLlm(record: ActiveRun, attempts: AttemptLog[]) {
    let previous: AttemptLog | null = null;
    for (const a of attempts) {
      let entry = record.llm.configs.find((c) => c.configId === a.configId);
      if (!entry) {
        entry = { configId: a.configId, configName: a.configName, models: [], calls: 0, failures: 0 };
        record.llm.configs.push(entry);
      }
      if (a.model && !entry.models.includes(a.model)) entry.models.push(a.model);
      entry.calls++;
      if (a.outcome !== "ok") entry.failures++;

      if (previous && previous.configId !== a.configId) {
        record.llm.switches.push({
          at: new Date().toISOString(),
          fromConfigName: previous.configName,
          toConfigName: a.configName,
          reason: previous.error?.slice(0, 300) ?? previous.outcome,
          caseId: record.currentCaseId,
        });
      }
      previous = a;
    }
  }

  private saveUsage(record: ActiveRun) {
    return this.prisma.testRun
      .update({
        where: { id: record.runId },
        data: { llmUsage: record.llm as unknown as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
  }

  // ---------- persistence ----------

  private async recordStep(
    record: ActiveRun,
    caseId: string,
    seq: number,
    step: ExecutionStep,
    outcome: { ok: boolean; durationMs: number; error?: string; detail: Record<string, unknown> } | null,
    model: string,
    durationMs: number,
    screenshotKey: string | null,
  ) {
    await this.prisma.runStep.create({
      data: {
        runId: record.runId, testCaseId: caseId, seq,
        phase: step.phase, action: step.action as unknown as Prisma.InputJsonValue,
        intent: step.intent, observation: step.observation,
        result: (outcome ?? {}) as unknown as Prisma.InputJsonValue,
        screenshotKey, modelUsed: model, durationMs,
      },
    });
    await this.prisma.testRun.update({ where: { id: record.runId }, data: { stepCount: { increment: 1 } } });
    this.publish(record, {
      type: "step", caseId, seq, phase: step.phase, action: step.action,
      intent: step.intent, observation: step.observation,
      result: { ok: outcome?.ok ?? true, durationMs: outcome?.durationMs ?? durationMs, error: outcome?.error },
      model, screenshotKey,
    });
  }

  private async recordFinding(record: ActiveRun, caseId: string, step: ExecutionStep) {
    const p = (step.action.params ?? {}) as Record<string, unknown>;
    const severity = (["critical", "major", "minor", "info"] as const).includes(p.severity as never)
      ? (p.severity as Severity)
      : Severity.minor;
    const finding = await this.prisma.runFinding.create({
      data: {
        runId: record.runId,
        testCaseId: caseId,
        severity,
        title: String(p.title ?? step.intent ?? "未命名的發現").slice(0, 300),
        description: String(p.description ?? step.observation ?? "").slice(0, 5000),
      },
    });
    this.publish(record, {
      type: "finding", id: finding.id, caseId, severity,
      title: finding.title, description: finding.description,
    });
  }

  private writeResult(
    runId: string,
    testCaseId: string,
    caseVersion: number,
    data: {
      verdict: Verdict; reasoning: string; possiblyChanged: boolean;
      reproSteps: string[]; evidence: Record<string, unknown>; stepCount: number; durationMs: number;
    },
  ) {
    return this.prisma.testResult.upsert({
      where: { runId_testCaseId: { runId, testCaseId } },
      create: {
        runId, testCaseId, caseVersion,
        verdict: data.verdict, llmReasoning: data.reasoning, possiblyChanged: data.possiblyChanged,
        reproSteps: data.reproSteps, evidence: data.evidence as Prisma.InputJsonObject,
        stepCount: data.stepCount, durationMs: data.durationMs,
      },
      update: {
        verdict: data.verdict, llmReasoning: data.reasoning, possiblyChanged: data.possiblyChanged,
        reproSteps: data.reproSteps, evidence: data.evidence as Prisma.InputJsonObject,
        stepCount: data.stepCount, durationMs: data.durationMs,
      },
    });
  }

  /**
   * Run the target's shared API setup flow once (§4.4). Records each request as a
   * run-level step (no case), merges captured variables into `credentials`, and
   * returns false if the flow could not complete — in which case the caller fails
   * the run, since every case depends on the setup.
   */
  /**
   * Run one setup flow (target- or feature-level), record each request as a
   * run-level RunStep, publish setup_step events, and return the outcome. Does
   * not mutate credentials or finish the run — the caller decides what a
   * success/failure means for its scope.
   */
  private async runSetupFlow(
    record: ActiveRun,
    steps: SetupStep[],
    config: { base_url: string; headers?: Record<string, string> },
    baseCreds: Record<string, string>,
    seqStart: number,
    scope: "target" | "feature",
    featureName?: string,
  ): Promise<{ ok: boolean; captured: Record<string, string>; error?: string; recorded: number }> {
    const outcome = await this.apiSetup.run(steps, config, baseCreds);

    // Captured values are secrets we propagate as credentials — mask them in the
    // stored transcript (a login response is the one place a token appears before
    // it enters the credential map). Only long values count as secrets, so short
    // captures (ids, paths) do not clobber a matching URL path.
    const secrets = Object.values(outcome.captured).filter((v) => v && v.length >= 12);
    let i = 0;
    for (const st of outcome.steps) {
      i++;
      const status = (st.result.detail.status as number | undefined) ?? null;
      await this.prisma.runStep.create({
        data: {
          runId: record.runId, testCaseId: null, seq: -(seqStart + i), phase: "setup",
          action: { type: "http_request", params: st.request } as unknown as Prisma.InputJsonValue,
          intent: featureName ? `[${featureName}] ${st.label}` : st.label,
          observation: st.captured.length ? `擷取變數:${st.captured.join("、")}` : (st.error ?? ""),
          result: maskSecrets(st.result, secrets) as unknown as Prisma.InputJsonValue,
          modelUsed: null, durationMs: st.result.durationMs,
        },
      });
      this.publish(record, {
        type: "setup_step", seq: seqStart + i, label: st.label, method: st.request.method, path: st.request.path,
        result: { ok: st.result.ok && !st.error, status, durationMs: st.result.durationMs, error: st.error },
        captured: st.captured, scope, featureName,
      });
    }
    return { ok: outcome.ok, captured: outcome.captured, error: outcome.error, recorded: outcome.steps.length };
  }

  private async finish(record: ActiveRun, status: RunStatus, startedAt: number) {
    const results = await this.prisma.testResult.groupBy({
      by: ["verdict"], where: { runId: record.runId }, _count: { _all: true },
    });
    const counts: Record<string, number> = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
    for (const r of results) counts[r.verdict] = r._count._all;

    await this.prisma.testRun.update({
      where: { id: record.runId },
      data: {
        status, pausedReason: null, endedAt: new Date(),
        llmUsage: record.llm as unknown as Prisma.InputJsonValue,
      },
    });
    this.publish(record, {
      type: "run_finished", runId: record.runId, status, counts, durationMs: Date.now() - startedAt,
    });
  }

  /** Always runs: the target lock and the sandbox must not outlive the run. */
  private async releaseTarget(targetId: string, sandboxId: string | null) {
    if (sandboxId) {
      await this.sandbox.remove(sandboxId).catch((err) =>
        this.log.warn(`failed to reclaim sandbox ${sandboxId}: ${(err as Error).message}`),
      );
    }
    await this.prisma.qaTarget
      .updateMany({ where: { id: targetId }, data: { status: "idle" } })
      .catch((err) => this.log.error(`failed to unlock target ${targetId}: ${(err as Error).message}`));
  }

  private publish(record: ActiveRun, event: RunEvent) {
    record.events.push(event);
    if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
    for (const subscriber of record.subscribers) {
      try {
        subscriber(event);
      } catch {
        record.subscribers.delete(subscriber);
      }
    }
  }
}


function describeOutcome(
  step: ExecutionStep,
  outcome: { ok: boolean; error?: string; detail: Record<string, unknown> },
): string {
  const head = outcome.ok
    ? `動作 ${step.action.type} 執行完成。`
    : `動作 ${step.action.type} 失敗：${outcome.error ?? "未知錯誤"}`;
  const detail = Object.keys(outcome.detail).length
    ? `\n結果：${fenceUntrusted("回應內容", JSON.stringify(outcome.detail).slice(0, 4000))}`
    : "";
  return `${head}${detail}`;
}

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
import { typeLabel as credentialTypeLabel } from "../targets/credentials";
import { SkillsService } from "../skills/skills.service";
import { McpService } from "../mcp/mcp.service";
import type { McpToolForPrompt } from "./run-prompts";
import { EvidenceService } from "./evidence.service";
import { HttpExecutorService, fillCredentials, type HttpLog } from "./http-executor.service";
import { ApiSetupService, type SetupStep } from "./api-setup.service";
import {
  generateSecret, rotationPlaceholderKey, isRotationPlaceholderKey, usedRotationKeys, httpStatusOf, isAppliedStatus,
} from "./credential-rotation";
import { Crawler, type CrawlIdentity } from "../explore/crawler";
import { acquireTargetLock, busyMessage, targetLockHolder } from "../targets/target-lock";
import { fenceUntrusted } from "../common/untrusted";
import { SCREENSHOT_WINDOW, buildMessages, maskSecrets, summariseProbe } from "./run-utils";
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
  | { type: "credential_rotated"; caseId: string; credential: string; committed: boolean; verified: boolean | null; note: string }
  | { type: "run_aborted_fatal"; caseId: string; reason: string }
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
  /** Who started the run — attributed on any credential the run rotates. */
  triggeredById: string;
  events: RunEvent[];
  subscribers: Set<Subscriber>;
  abort: AbortController;
  /** Project the run belongs to, for usage attribution (§4.8). Set once known. */
  projectId: string | null;
  /** Which models actually served this run, and where the chain fell over. */
  llm: LlmUsage;
  /** The case being executed, so a fallback can be pinned to where it happened. */
  currentCaseId: string | null;
  /** Per-run override for api parallelism; falls back to the global setting. */
  concurrency?: number;
  /** Serialises credential-rotation commits so concurrent cases never race the
   *  shared credential map or double-write the same key. */
  rotationLock: Promise<void>;
  /** Identities whose login already failed this run, with the reason. Retrying a
   *  login we know is bad just hammers the target — and trips its rate limiter,
   *  which then blocks every later case including ones that would have passed. */
  loginFailures: Map<string, string>;
  /** Set when the agent hit a system-wide fatal error (target unreachable): the
   *  run is aborted as failed rather than run to the end against a dead system. */
  fatal: { reason: string; caseId: string } | null;
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
/** Default web/desktop parallelism when a run does not override it. Kept modest
 *  (one live view is shown) and always clamped to the global sandbox cap. */
const DEFAULT_WEB_CONCURRENCY = 2;
/** How often a running run re-reads its durable abort flag. */
const ABORT_POLL_MS = 5_000;

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
        // Interrupted, not failed: the environment cut it short. Completed case
        // results are kept and the rest can be continued.
        data: { status: RunStatus.interrupted, error: "API 重新啟動，這次執行已中斷。已完成的案例結果保留，可「繼續未完成的案例」。", endedAt: new Date() },
      }).catch(() => undefined);
      await this.releaseTarget(run.targetId, run.sandboxId);
    }
  }

  // ---------- lifecycle ----------

  /**
   * Spec §4.5: one run per target at a time, enforced with a conditional update
   * so two requests cannot both win. Nothing queues and nothing takes over.
   */
  async start(targetId: string, userId: string, caseIds?: string[], concurrency?: number) {
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
      this.spawn(run.id, targetId, userId, target.name, target.kind, cases.length, concurrency);
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

  /**
   * Stop the run. The flag is written to the database so the stop still lands
   * when the run is executing in a different process; if we happen to own it,
   * abort in-process too so it takes effect immediately rather than on the next
   * poll.
   */
  async abort(targetId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const active = await this.prisma.testRun.findFirst({
      where: { targetId, status: { in: [RunStatus.running, RunStatus.paused, RunStatus.queued] } },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (!active) return { aborted: false };
    await this.prisma.testRun.update({ where: { id: active.id }, data: { abortRequested: true } });
    const local = this.active.get(targetId);
    if (local && !local.finished) local.abort.abort();
    await this.audit.log("user", userId, "run.abort", active.id);
    return { aborted: true };
  }

  /** §4.6: skip a case that has not started yet. */
  /**
   * Skip a case that has not started. Written straight to the queue row so it
   * holds no matter which process is executing the run: claiming a case is an
   * atomic status guard, so marking it `skipped` here means no worker can pick
   * it up afterwards.
   */
  async skipCase(targetId: string, caseId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const active = await this.prisma.testRun.findFirst({
      where: { targetId, status: { in: [RunStatus.running, RunStatus.paused, RunStatus.queued] } },
      orderBy: { startedAt: "desc" },
      include: { queue: { where: { testCaseId: caseId }, include: { testCase: { select: { title: true, currentVersion: true } } } } },
    });
    if (!active) throw new BadRequestException("目前沒有進行中的執行。");
    const row = active.queue[0];
    if (!row) throw new NotFoundException("這條案例不在本次執行的清單裡。");
    if (row.status !== QueueStatus.queued) throw new BadRequestException("只能跳過還沒開始的案例。");

    const claimed = await this.prisma.runCaseQueue.updateMany({
      where: { runId: active.id, testCaseId: caseId, status: QueueStatus.queued },
      data: { status: QueueStatus.skipped },
    });
    if (claimed.count !== 1) throw new BadRequestException("這條案例已經開始執行了。");
    await this.writeResult(active.id, caseId, row.testCase.currentVersion, {
      verdict: Verdict.skipped, reasoning: "使用者在執行中跳過。", possiblyChanged: false,
      reproSteps: [], evidence: {}, stepCount: 0, durationMs: 0,
    });
    const local = this.active.get(targetId);
    if (local) this.publish(local, { type: "case_skipped", caseId, title: row.testCase.title });
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

  /** Start a fresh run over the cases an earlier (interrupted) run did not finish. */
  async continueRun(runId: string, userId: string) {
    const run = await this.prisma.testRun.findUnique({
      where: { id: runId },
      include: { queue: { select: { testCaseId: true, status: true } } },
    });
    if (!run) throw new NotFoundException("找不到這次執行。");
    await this.perms.requireTarget(run.targetId, userId, Role.editor);
    const incomplete = run.queue.filter((q) => q.status !== QueueStatus.done).map((q) => q.testCaseId);
    if (!incomplete.length) throw new BadRequestException("這次執行的案例都已完成，沒有可續跑的。");
    return this.start(run.targetId, userId, incomplete);
  }

  // ---------- execution ----------

  private spawn(runId: string, targetId: string, triggeredById: string, targetName: string, kind: TargetKind, total: number, concurrency?: number) {
    const record: ActiveRun = {
      runId, targetId, triggeredById, events: [], subscribers: new Set(),
      abort: new AbortController(), projectId: null, loginFailures: new Map(),
      llm: emptyUsage(), currentCaseId: null, concurrency, rotationLock: Promise.resolve(), fatal: null, finished: false,
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
    // A stop can be requested by another process (or this one after a restart),
    // so the durable flag is polled as well as the in-process signal.
    const abortPoll = setInterval(() => {
      void this.prisma.testRun
        .findUnique({ where: { id: record.runId }, select: { abortRequested: true } })
        .then((r) => { if (r?.abortRequested && !record.abort.signal.aborted) record.abort.abort(); })
        .catch(() => undefined);
    }, ABORT_POLL_MS);
    abortPoll.unref?.();
    const settings = await this.sandbox.settings();
    const target = await this.prisma.qaTarget.findUniqueOrThrow({ where: { id: record.targetId } });
    record.projectId = target.projectId;
    const credentials = await this.targets.decryptedCredentials(record.targetId);
    const rotatableKeys = await this.targets.rotatableCredentialKeys(record.targetId);
    const credMeta = await this.targets.credentialMeta(record.targetId);
    // Identities a case can be bound to, with their credentials resolved.
    const identityById = await this.resolveIdentities(record.targetId, credentials);
    const allCredentialRefs = new Set(credMeta.flatMap((c) => c.refs));
    // §4.5: global + project house rules fold into every case's system prompt.
    const skillsBlock = await this.skills.promptBlock(target.projectId);
    // §6.2 MCP: tools from enabled global + project servers, offered to the agent.
    const mcpTools = await this.mcp.toolsForProject(target.projectId).catch(() => []);
    const mcpForPrompt: McpToolForPrompt[] = mcpTools.map((t) => ({ serverId: t.serverId, server: t.server, name: t.tool.name, description: t.tool.description }));
    const needsSandbox = target.kind !== "api";

    // Web/desktop no longer share one sandbox: each worker gets its own so cases
    // run in a bounded parallel pool. Track them all for cleanup; the first is
    // stored on the run for the live view.
    const sandboxIds = new Set<string>();
    const screen = parseResolution(settings.resolution);
    let primaryStored = false;

    const makeSandbox = async () => {
      const startUrl = typeof (target.config as Record<string, unknown>)?.url === "string"
        ? String((target.config as Record<string, unknown>).url)
        : undefined;
      const instance = await this.sandbox.create(record.runId, { purpose: "run", startUrl, ttlMinutes: 240 });
      sandboxIds.add(instance.id);
      if (!primaryStored) {
        primaryStored = true;
        await this.prisma.testRun.update({
          where: { id: record.runId },
          data: { sandboxId: instance.id, sandboxName: instance.name, viewUrl: instance.viewUrl },
        });
      }
      this.publish(record, {
        type: "sandbox", sandboxId: instance.id, name: instance.name,
        viewUrl: instance.viewUrl, note: `已啟動 sandbox（${instance.resolution}）`,
      });
      return { id: instance.id, agentPort: instance.agentPort };
    };

    try {
      if (!needsSandbox) {
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
        credentials: credMeta.map((c) => ({ name: c.name, typeLabel: credentialTypeLabel(c.type), description: c.description, refs: c.refs, rotatableRef: c.rotatableRef })),
        rotatableKeys: [...rotatableKeys],
        screen: { width: screen[0], height: screen[1] },
      };

      // Cases run in a bounded worker pool (§4.6). API targets run many at once
      // (no sandbox); web/desktop get one sandbox per worker, capped by the global
      // sandbox limit so a run can't starve the pool.
      const concurrency = needsSandbox
        ? Math.max(1, Math.min(record.concurrency ?? DEFAULT_WEB_CONCURRENCY, settings.maxConcurrent))
        : Math.max(1, Math.min(record.concurrency ?? settings.apiConcurrency ?? 4, 16));
      const featureSetupLocks = new Map<string, Promise<void>>();

      // Only one worker runs a given feature's setup; the rest await the same result.
      const ensureFeatureSetup = async (featureId: string, featureName: string | undefined) => {
        if (featureCaptured.has(featureId) || featureSetupFailed.has(featureId)) return;
        if (!featureSetupLocks.has(featureId)) {
          featureSetupLocks.set(featureId, (async () => {
            const fsteps = await this.apiSetup.featureStepsFor(featureId);
            if (!fsteps.length) { featureCaptured.set(featureId, {}); return; }
            const r = await this.runSetupFlow(record, fsteps, setupConfig(), credentials, setupSeqUsed, "feature", featureName);
            setupSeqUsed += r.recorded;
            if (r.ok) {
              featureCaptured.set(featureId, r.captured);
              this.publish(record, { type: "setup_done", captured: Object.keys(r.captured), stepCount: r.recorded, scope: "feature", featureName });
            } else {
              featureSetupFailed.set(featureId, r.error ?? "前置流程失敗");
              this.publish(record, { type: "setup_failed", message: r.error ?? "前置流程失敗", scope: "feature", featureName });
            }
          })());
        }
        await featureSetupLocks.get(featureId);
      };

      // Atomically claim the next queued case (only one worker wins the row), handling
      // user-requested skips. Re-reads the queue each time so mid-run added cases run too.
      const claimNext = async () => {
        for (;;) {
          if (record.abort.signal.aborted) return null;
          const next = await this.prisma.runCaseQueue.findFirst({
            where: { runId: record.runId, status: QueueStatus.queued },
            orderBy: { order: "asc" },
            include: { testCase: { include: { feature: { select: { name: true } } } } },
          });
          if (!next) return null;
          // A skip is written straight to the queue row, so a skipped case is
          // simply never returned by the query above.
          const claim = await this.prisma.runCaseQueue.updateMany({
            where: { runId: record.runId, testCaseId: next.testCaseId, status: QueueStatus.queued },
            data: { status: QueueStatus.running, caseVersion: next.testCase.currentVersion },
          });
          if (claim.count !== 1) continue; // another worker took it first
          return next;
        }
      };
      type QueueRow = NonNullable<Awaited<ReturnType<typeof claimNext>>>;

      const processCase = async (next: QueueRow, agentPort: number | null) => {
        const total = await this.prisma.runCaseQueue.count({ where: { runId: record.runId } });
        const index = await this.prisma.runCaseQueue.count({ where: { runId: record.runId, status: { not: QueueStatus.queued } } });
        this.publish(record, { type: "case_started", caseId: next.testCaseId, title: next.testCase.title, index, total, caseVersion: next.testCase.currentVersion });
        record.currentCaseId = next.testCaseId; // best-effort; approximate under concurrency

        const featureId = next.testCase.featureId;
        let caseCreds = credentials;
        let casePrompt = targetPrompt;
        if (!needsSandbox && featureId) {
          await ensureFeatureSetup(featureId, next.testCase.feature?.name ?? undefined);
          const failMsg = featureSetupFailed.get(featureId);
          if (failMsg) {
            await this.writeResult(record.runId, next.testCaseId, next.testCase.currentVersion, { verdict: Verdict.blocked, reasoning: `所屬功能的前置流程失敗,無法執行:${failMsg}`, possiblyChanged: false, reproSteps: [], evidence: {}, stepCount: 0, durationMs: 0 });
            this.publish(record, { type: "case_finished", caseId: next.testCaseId, verdict: Verdict.blocked, reasoning: `所屬功能的前置流程失敗:${failMsg}`, possiblyChanged: false, stepCount: 0, durationMs: 0 });
            await this.prisma.runCaseQueue.update({ where: { runId_testCaseId: { runId: record.runId, testCaseId: next.testCaseId } }, data: { status: QueueStatus.done } });
            return;
          }
          const extra = featureCaptured.get(featureId);
          if (extra && Object.keys(extra).length) {
            caseCreds = { ...credentials, ...extra };
            casePrompt = { ...targetPrompt, credentialKeys: Object.keys(caseCreds) };
          }
        }

        // A case bound to an identity runs *as* that identity: only that
        // identity's credentials are exposed (so it cannot grab the admin
        // account), and on a screen target we log in first, deterministically.
        const identity = next.testCase.identityId ? identityById.get(next.testCase.identityId) ?? null : null;
        if (identity) {
          const setupVars = Object.fromEntries(Object.entries(caseCreds).filter(([k]) => !allCredentialRefs.has(k)));
          caseCreds = { ...setupVars, ...identity.credentials };
          casePrompt = {
            ...casePrompt,
            credentialKeys: Object.keys(caseCreds),
            credentials: credMeta
              .filter((c) => c.refs.some((r) => r in identity.credentials))
              .map((c) => ({ name: c.name, typeLabel: credentialTypeLabel(c.type), description: c.description, refs: c.refs, rotatableRef: c.rotatableRef })),
            identity: { name: identity.name, role: identity.role, isAnonymous: identity.isAnonymous },
          };
          if (needsSandbox && agentPort) {
            const failure = await this.loginAs(record, identity, agentPort, target);
            if (failure) {
              await this.writeResult(record.runId, next.testCaseId, next.testCase.currentVersion, { verdict: Verdict.blocked, reasoning: failure, possiblyChanged: false, reproSteps: [], evidence: {}, stepCount: 0, durationMs: 0 });
              this.publish(record, { type: "case_finished", caseId: next.testCaseId, verdict: Verdict.blocked, reasoning: failure, possiblyChanged: false, stepCount: 0, durationMs: 0 });
              await this.prisma.runCaseQueue.update({ where: { runId_testCaseId: { runId: record.runId, testCaseId: next.testCaseId } }, data: { status: QueueStatus.done } });
              return;
            }
          }
        }

        await this.runCase(record, { target, targetPrompt: casePrompt, credentials: caseCreds, sharedCredentials: credentials, rotatableKeys, identities: identityById, settings, agentPort, skillsBlock, mcpTools: mcpForPrompt, queueRow: next, needsSandbox });
        await this.prisma.runCaseQueue.update({ where: { runId_testCaseId: { runId: record.runId, testCaseId: next.testCaseId } }, data: { status: QueueStatus.done } });
        await this.saveUsage(record);
      };

      const worker = async () => {
        // A worker keeps one sandbox and reuses it across its cases; created lazily
        // so idle workers (fewer cases than the pool) never spin one up.
        let ws: { id: string; agentPort: number | null } | null = null;
        for (;;) {
          if (record.abort.signal.aborted) return;
          const next = await claimNext();
          if (!next) return;
          if (needsSandbox && !ws) ws = await makeSandbox();
          await processCase(next, ws?.agentPort ?? null);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      const aborted = record.abort.signal.aborted;
      if (aborted) {
        await this.prisma.runCaseQueue.updateMany({
          where: { runId: record.runId, status: QueueStatus.queued },
          data: { status: QueueStatus.skipped },
        });
      }
      // A fatal abort (system unreachable) is an interruption, not a test failure.
      if (record.fatal) {
        await this.prisma.testRun.update({ where: { id: record.runId }, data: { error: `系統無法連線，已中止整趟執行：${record.fatal.reason}`.slice(0, 2000) } }).catch(() => undefined);
      }
      await this.finish(record, record.fatal ? RunStatus.interrupted : aborted ? RunStatus.aborted : RunStatus.succeeded, startedAt);
    } finally {
      clearInterval(abortPoll);
      await this.releaseTarget(record.targetId, sandboxIds);
    }
  }

  /** One case: drive the agent, then judge what happened. */
  private async runCase(
    record: ActiveRun,
    ctx: {
      target: { id: string; kind: TargetKind; config: Prisma.JsonValue };
      targetPrompt: TargetForPrompt;
      /** This case's credential map (may include feature captures). Mutated in
       *  place when a rotation commits, so later actions here see the new value. */
      credentials: Record<string, string>;
      /** The run-wide credential map, so a commit propagates to future cases too. */
      sharedCredentials: Record<string, string>;
      /** Which credentials this run is allowed to rotate. */
      rotatableKeys: Set<string>;
      /** Identities, so a rotated secret can be verified by logging in with it. */
      identities: Map<string, CrawlIdentity>;
      settings: { maxStepsPerCase: number; stepTimeoutSec: number; recordVideo: boolean };
      skillsBlock: string;
      mcpTools: McpToolForPrompt[];
      agentPort: number | null;
      queueRow: { testCaseId: string; testCase: { title: string; precondition: string; setupNote: string; steps: Prisma.JsonValue; expected: string; priority: string; type: string; currentVersion: number; feature: { name: string } | null } };
      needsSandbox: boolean;
    },
  ) {
    const caseStarted = Date.now();
    const testCase = ctx.queueRow.testCase;
    const forPrompt: CaseForPrompt = {
      title: testCase.title,
      precondition: testCase.precondition,
      setupNote: testCase.setupNote,
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
    // Rotations requested during this case: credential -> fresh value + whether we
    // saw it take effect. Committed (synced to the store) at case end.
    const caseRotations = new Map<string, { newValue: string; appliedByHttp: boolean; used: boolean }>();
    // Declared non-secret field changes (a renamed account), verified before sync.
    const caseRenames = new Map<string, { field: string; value: string }>();
    let seq = 0;
    let stopReason = `已達步數上限（${maxSteps}）`;
    // Set when this case (or another, mid-flight) hit a system-wide fatal error;
    // the case is recorded blocked and the judge is skipped (the system is dead).
    let fatalReason: string | null = null;

    while (seq < maxSteps) {
      if (record.abort.signal.aborted) {
        if (record.fatal) { fatalReason = record.fatal.reason; stopReason = `系統性錯誤，已中止：${record.fatal.reason}`; }
        else stopReason = "使用者中止執行";
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

      if (step.action.type === "abort_run") {
        const reason = String((step.action.params as Record<string, unknown> | undefined)?.reason ?? step.observation ?? "整個系統無法連線").slice(0, 1000);
        fatalReason = reason;
        transcript.push({ seq, phase: step.phase, intent: step.intent, observation: step.observation, action: step.action });
        await this.recordStep(record, ctx.queueRow.testCaseId, seq, step, { ok: true, durationMs: 0, detail: {} }, decided.model, 0, null);
        // Fire once: flag the run fatal, raise a critical finding, abort so no more
        // cases start. Other in-flight cases see the abort and skip their judge too.
        if (!record.fatal) {
          record.fatal = { reason, caseId: ctx.queueRow.testCaseId };
          await this.createFinding(record, ctx.queueRow.testCaseId, Severity.critical, "系統無法連線，已中止整趟執行", reason);
          this.publish(record, { type: "run_aborted_fatal", caseId: ctx.queueRow.testCaseId, reason });
          record.abort.abort();
        }
        break;
      }

      if (step.action.type === "update_credential") {
        const feedback = this.handleUpdateCredential(step, ctx, caseRenames);
        transcript.push({ seq, phase: step.phase, intent: step.intent, observation: step.observation, action: step.action, result: { text: feedback } });
        turns.push({ assistant: JSON.stringify({ intent: step.intent, action: step.action }), user: [{ type: "text", text: feedback }] });
        await this.recordStep(record, ctx.queueRow.testCaseId, seq, step, { ok: true, durationMs: 0, detail: {} }, decided.model, 0, null);
        continue;
      }

      if (step.action.type === "rotate_credential") {
        const feedback = this.handleRotateCredential(step, ctx, caseRotations);
        transcript.push({ seq, phase: step.phase, intent: step.intent, observation: step.observation, action: step.action, result: { text: feedback } });
        turns.push({
          assistant: JSON.stringify({ intent: step.intent, action: step.action }),
          user: [{ type: "text", text: feedback }],
        });
        await this.recordStep(record, ctx.queueRow.testCaseId, seq, step, { ok: true, durationMs: 0, detail: {} }, decided.model, 0, null);
        continue;
      }

      const outcome = await this.performAction(step, ctx, stepTimeoutMs, httpLogs);
      if (caseRotations.size) this.noteRotationUsage(step, outcome, caseRotations);
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

    // System is down — record this case blocked without spending a judge call, and
    // let the run finish (as failed). The whole point is to stop burning tokens.
    if (fatalReason) {
      const durationMs = Date.now() - caseStarted;
      await this.writeResult(record.runId, ctx.queueRow.testCaseId, testCase.currentVersion, {
        verdict: Verdict.blocked, reasoning: `系統性錯誤，未能執行：${fatalReason}`, possiblyChanged: false,
        reproSteps: [], evidence: { screenshots, video: videoKey, httpLogs }, stepCount: seq, durationMs,
      });
      this.publish(record, { type: "case_finished", caseId: ctx.queueRow.testCaseId, verdict: Verdict.blocked, reasoning: `系統性錯誤：${fatalReason}`, possiblyChanged: false, stepCount: seq, durationMs });
      return;
    }

    // ----- judge -----
    const verdict = await this.judge(record, forPrompt, transcript, stopReason, frames, ctx.needsSandbox);
    const durationMs = Date.now() - caseStarted;

    // Sync any rotated credential to its new value before recording the result,
    // so the outcome carries what changed and the next case sees the new value.
    const rotations = caseRotations.size || caseRenames.size
      ? await this.commitRotations(record, ctx, caseRotations, caseRenames, verdict?.verdict ?? null)
      : [];

    await this.writeResult(record.runId, ctx.queueRow.testCaseId, testCase.currentVersion, {
      verdict: (verdict?.verdict ?? Verdict.blocked) as Verdict,
      reasoning: verdict?.reasoning ?? "無法取得判定（模型不可用）。",
      possiblyChanged: verdict?.possibly_changed ?? false,
      reproSteps: verdict?.repro_steps ?? [],
      evidence: { screenshots, video: videoKey, httpLogs, evidenceRefs: verdict?.evidence_refs ?? [], ...(rotations.length ? { rotations } : {}) },
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
  ): Promise<{ ok: boolean; durationMs: number; error?: string; detail: Record<string, unknown>; substituted?: string[] }> {
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
      return { ok: result.ok, durationMs: result.durationMs, error: result.error, detail: result.detail, substituted: result.substituted };
    }

    if (!ctx.needsSandbox || !ctx.agentPort) {
      return { ok: false, durationMs: 0, error: `這個 Target 不支援「${type}」動作`, detail: {} };
    }
    const port = ctx.agentPort;

    // DOM-aware actions. The names the model writes are driver-neutral; today they
    // map onto the CDP-backed sandbox agent (the same machinery the explorer uses),
    // so the agent acts on real elements instead of guessing screen coordinates.
    if (type === "page_snapshot") {
      const started = Date.now();
      const probe = await this.computer.domSnapshot(port);
      return probe
        ? { ok: true, durationMs: Date.now() - started, detail: { page: summariseProbe(probe) } }
        : { ok: false, durationMs: Date.now() - started, error: "讀不到頁面內容（頁面可能還在載入）", detail: {} };
    }
    if (type === "click_text") {
      const text = String(args.text ?? "").trim();
      if (!text) return { ok: false, durationMs: 0, error: "click_text 需要 params.text（要點的可見文字）", detail: {} };
      const res = await this.computer.cdpClick(port, text, { exact: args.exact === true });
      return { ok: res.ok, durationMs: res.durationMs, error: res.error, detail: res.detail };
    }
    if (type === "fill_field") {
      const field = typeof args.field === "number" ? args.field : String(args.field ?? "").trim();
      if (field === "") return { ok: false, durationMs: 0, error: "fill_field 需要 params.field（欄位名稱或 label）", detail: {} };
      // Credentials are substituted here so the real value never reaches the model.
      const value = fillCredentials(String(args.value ?? ""), ctx.credentials);
      const res = await this.computer.cdpFill(port, field, value);
      return { ok: res.ok, durationMs: res.durationMs, error: res.error, detail: res.detail };
    }
    if (type === "press_key") {
      const res = await this.computer.cdpKey(port, String(args.key ?? "Escape"));
      return { ok: res.ok, durationMs: res.durationMs, error: res.error, detail: res.detail };
    }
    if (type === "set_viewport") {
      const width = Math.max(320, Math.min(Number(args.width) || 1280, 3840));
      const height = Math.max(320, Math.min(Number(args.height) || 800, 2160));
      const res = await this.computer.setViewport(port, width, height, args.mobile === true);
      return { ok: res.ok, durationMs: res.durationMs, error: res.error, detail: { ...res.detail, viewport: `${width}x${height}` } };
    }
    // Navigation goes through CDP too: more reliable than driving the URL bar, and
    // it hands back the page structure in one step.
    if (type === "navigate" && typeof args.url === "string") {
      const started = Date.now();
      const probe = await this.computer.cdpNavigate(port, toSandboxUrl(args.url));
      return probe
        ? { ok: true, durationMs: Date.now() - started, detail: { page: summariseProbe(probe) } }
        : { ok: false, durationMs: Date.now() - started, error: `打不開 ${args.url}`, detail: {} };
    }

    // Coordinate-based fallbacks. Credentials are filled in here for the same reason.
    const filled =
      type === "type" && typeof args.text === "string"
        ? { ...args, text: fillCredentials(args.text, ctx.credentials) }
        : args;
    const res = await this.computer.perform(port, type, filled, timeoutMs);
    return { ok: res.ok, durationMs: res.durationMs, error: res.error, detail: res.detail };
  }

  // ---------- credential rotation (§ keep stored credentials in sync) ----------

  /**
   * The agent declares it is about to change a credential's value. We generate a
   * fresh strong value (never one the model chose or can read), expose it under a
   * `{{cred__next}}` placeholder for the change request, and remember it so the
   * store can be synced once the change actually lands.
   */
  private handleRotateCredential(
    step: ExecutionStep,
    ctx: { credentials: Record<string, string>; targetPrompt: TargetForPrompt; rotatableKeys: Set<string> },
    caseRotations: Map<string, { newValue: string; appliedByHttp: boolean; used: boolean }>,
  ): string {
    const params = (step.action.params ?? {}) as Record<string, unknown>;
    const credential = String(params.credential ?? params.name ?? params.key ?? "").trim();
    if (!credential) return "rotate_credential 需要 params.credential（要輪替的憑證名稱）。";

    if (!ctx.rotatableKeys.has(credential)) {
      const exists = ctx.targetPrompt.credentialKeys.includes(credential);
      return exists
        ? `憑證「${credential}」沒有開啟「允許輪替」，這條 case 無法安全地修改它的值。請回傳 done 並說明此前置無法建立（會判為 blocked）。`
        : `沒有叫「${credential}」的憑證。可輪替的憑證：${[...ctx.rotatableKeys].join("、") || "（無）"}。`;
    }

    const placeholder = rotationPlaceholderKey(credential);
    const existing = caseRotations.get(credential);
    if (existing) {
      ctx.credentials[placeholder] = existing.newValue;
      return `「${credential}」已經產生過新值，直接用 \`{{${placeholder}}}\` 代入即可。`;
    }

    const minLength = Number.isFinite(Number(params.min_length)) ? Number(params.min_length) : undefined;
    const maxLength = Number.isFinite(Number(params.max_length)) ? Number(params.max_length) : undefined;
    const newValue = generateSecret({ minLength, maxLength });
    ctx.credentials[placeholder] = newValue;
    caseRotations.set(credential, { newValue, appliedByHttp: false, used: false });
    return [
      `已為「${credential}」產生一組新值。要填入「新值」的地方（例如改密碼表單的新密碼欄位、或 API body）請寫 \`{{${placeholder}}}\`，`,
      "系統會在送出前代入真值——你一樣看不到、也不要自己編。",
      "改成功後平台會自動把儲存的憑證同步成這個新值，之後的 case 和下一趟執行就會用新值登入。",
    ].join("");
  }

  /**
   * The agent declares that a non-secret credential field changed on the target
   * (an account was renamed). Unlike a secret, the model legitimately knows this
   * value — it typed it — so it may report it; we still only trust it after the
   * new value actually logs in.
   */
  private handleUpdateCredential(
    step: ExecutionStep,
    ctx: { targetPrompt: TargetForPrompt; rotatableKeys: Set<string> },
    caseRenames: Map<string, { field: string; value: string }>,
  ): string {
    const p = (step.action.params ?? {}) as Record<string, unknown>;
    const name = String(p.credential ?? p.name ?? "").trim();
    const field = String(p.field ?? "username").trim();
    const value = String(p.value ?? "").trim();
    if (!name || !value) return "update_credential 需要 params.credential（憑證名稱）和 params.value（新的值）。";
    if (field === "password" || field === "value") {
      return "密碼不能用 update_credential 傳。要改密碼請用 `rotate_credential`，由平台產生新值，你不會也不該碰到真正的密碼。";
    }
    // Same opt-in gate as rotation: only credentials the owner marked rotatable.
    const rotatable = [...ctx.rotatableKeys].some((r) => r === name || r.startsWith(`${name}.`));
    if (!rotatable) return `憑證「${name}」沒有開啟「允許輪替」，平台不會同步它的變更。請回傳 done 說明這件事。`;
    caseRenames.set(name, { field, value });
    return `已記下「${name}」的 ${field} 變成「${value}」。這條 case 結束後，平台會用新值實際登入驗證，通過才會同步儲存的憑證。`;
  }

  /** After each action, note whether a pending rotation's placeholder was used
   *  (and, for http, whether the change was accepted with a 2xx). For http we use
   *  the keys the executor actually substituted — a cross-origin request never
   *  substitutes, so its new value never left and must not count as applied. */
  private noteRotationUsage(
    step: ExecutionStep,
    outcome: { detail: Record<string, unknown>; substituted?: string[] },
    caseRotations: Map<string, { newValue: string; appliedByHttp: boolean; used: boolean }>,
  ) {
    const used = step.action.type === "http_request"
      ? (outcome.substituted ?? []).filter(isRotationPlaceholderKey)
      : usedRotationKeys(step.action.params, [...caseRotations.keys()].map(rotationPlaceholderKey));
    if (!used.length) return;
    const applied = step.action.type === "http_request" && isAppliedStatus(httpStatusOf(outcome.detail));
    for (const [cred, st] of caseRotations) {
      if (!used.includes(rotationPlaceholderKey(cred))) continue;
      st.used = true;
      if (applied) st.appliedByHttp = true;
    }
  }

  /**
   * Sync every rotated credential to its new value. The commit rule is "sync to
   * what actually happened on the target": for an api target, the ground truth is
   * a 2xx to a request that carried the new value; for a screen target we cannot
   * read a status, so we require the placeholder to have been used AND the case
   * to have passed. On an api target we then re-run the login flow with the new
   * value to confirm it works, and flag a finding if it does not.
   */
  private async commitRotations(
    record: ActiveRun,
    ctx: {
      target: { id: string; config: Prisma.JsonValue };
      credentials: Record<string, string>;
      sharedCredentials: Record<string, string>;
      needsSandbox: boolean;
      agentPort: number | null;
      identities: Map<string, CrawlIdentity>;
      queueRow: { testCaseId: string };
    },
    caseRotations: Map<string, { newValue: string; appliedByHttp: boolean; used: boolean }>,
    caseRenames: Map<string, { field: string; value: string }>,
    verdict: Verdict | null,
  ): Promise<{ credential: string; committed: boolean; verified: boolean | null; note: string }[]> {
    const results: { credential: string; committed: boolean; verified: boolean | null; note: string }[] = [];
    const nameOf = (ref: string) => (ref.includes(".") ? ref.slice(0, ref.lastIndexOf(".")) : ref);
    for (const [cred, st] of caseRotations) {
      const placeholder = rotationPlaceholderKey(cred);
      // A rename staged in the same case must be applied for the login to work.
      const rename = caseRenames.get(nameOf(cred));
      const overrides: Record<string, string> = { [cred]: st.newValue };
      if (rename) overrides[`${nameOf(cred)}.${rename.field}`] = rename.value;
      // api: a 2xx carrying the new value is ground truth. web: we cannot read a
      // status, so prove it by logging in with the new secret — the case verdict is
      // the wrong signal, because a password changed as a *precondition* must be
      // synced even when the case later fails for an unrelated reason.
      const webVerified = ctx.needsSandbox && st.used ? await this.verifyWebCredentials(ctx, overrides) : false;
      const shouldCommit = ctx.needsSandbox ? webVerified : st.appliedByHttp;

      if (!shouldCommit) {
        delete ctx.credentials[placeholder];
        delete ctx.sharedCredentials[placeholder];
        const note = !st.used
          ? `要求輪替「${cred}」但沒有實際用到 {{${placeholder}}}，未變更儲存的憑證。`
          : ctx.needsSandbox
            ? `「${cred}」的輪替未同步：用新值登入驗證沒有成功，因此不敢覆寫儲存的憑證。若被測系統其實已經改掉密碼，儲存的憑證就會失效，請人工確認。`
            : `「${cred}」的輪替未同步：修改請求沒有回傳 2xx，視為未成功。`;
        if (st.used && ctx.needsSandbox) {
          await this.createFinding(record, ctx.queueRow.testCaseId, Severity.major, `憑證「${cred}」可能已被改動但無法驗證`, note);
        }
        this.publish(record, { type: "credential_rotated", caseId: ctx.queueRow.testCaseId, credential: cred, committed: false, verified: null, note });
        results.push({ credential: cred, committed: false, verified: null, note });
        continue;
      }

      await this.withRotationLock(record, async () => {
        ctx.credentials[cred] = st.newValue;
        ctx.sharedCredentials[cred] = st.newValue;
        delete ctx.credentials[placeholder];
        delete ctx.sharedCredentials[placeholder];
        await this.targets.rotateCredentialValue(ctx.target.id, cred, st.newValue, record.triggeredById);
      });

      const verified = ctx.needsSandbox ? null : await this.verifyRotation(ctx, cred);
      const note = verified === false
        ? `「${cred}」已輪替並同步，但用新值重新登入驗證失敗，請人工確認。`
        : `「${cred}」已輪替，儲存的憑證已同步成新值。`;
      this.publish(record, { type: "credential_rotated", caseId: ctx.queueRow.testCaseId, credential: cred, committed: true, verified, note });
      if (verified === false) {
        await this.createFinding(record, ctx.queueRow.testCaseId, Severity.major, `憑證「${cred}」輪替後登入驗證失敗`, note);
      }
      results.push({ credential: cred, committed: true, verified, note });
      if (rename) caseRenames.delete(nameOf(cred)); // committed together with the rotation
    }

    // Declared identifier changes (a renamed account). The model supplies the new
    // value because it is not a secret — but we only trust it once it logs in.
    for (const [name, ren] of caseRenames) {
      const ref = `${name}.${ren.field}`;
      const ok = ctx.needsSandbox ? await this.verifyWebCredentials(ctx, { [ref]: ren.value }) : false;
      if (!ok) {
        const note = `「${name}」的 ${ren.field} 宣告改成「${ren.value}」，但用新值登入驗證沒有成功，未同步儲存的憑證。若目標系統其實已改名，這組憑證會失效，請人工確認。`;
        await this.createFinding(record, ctx.queueRow.testCaseId, Severity.major, `憑證「${name}」的 ${ren.field} 可能已變更但無法驗證`, note);
        this.publish(record, { type: "credential_rotated", caseId: ctx.queueRow.testCaseId, credential: name, committed: false, verified: false, note });
        results.push({ credential: name, committed: false, verified: false, note });
        continue;
      }
      await this.withRotationLock(record, async () => {
        ctx.credentials[ref] = ren.value;
        ctx.sharedCredentials[ref] = ren.value;
        await this.targets.setCredentialField(ctx.target.id, name, ren.field, ren.value, record.triggeredById);
      });
      const note = `「${name}」的 ${ren.field} 已同步成「${ren.value}」（已用新值登入驗證）。`;
      this.publish(record, { type: "credential_rotated", caseId: ctx.queueRow.testCaseId, credential: name, committed: true, verified: true, note });
      results.push({ credential: name, committed: true, verified: true, note });
    }
    return results;
  }

  /** Best-effort: re-run the target's login flow with the new value to confirm it
   *  works. Returns null when there is no flow that uses this credential to test. */
  private async verifyRotation(ctx: { target: { id: string; config: Prisma.JsonValue }; sharedCredentials: Record<string, string> }, cred: string): Promise<boolean | null> {
    try {
      const steps = await this.apiSetup.stepsFor(ctx.target.id);
      if (!steps.length || !JSON.stringify(steps).includes(`{{${cred}}}`)) return null;
      const cfg = (ctx.target.config ?? {}) as Record<string, unknown>;
      const outcome = await this.apiSetup.run(steps, { base_url: String(cfg.base_url ?? ""), headers: (cfg.headers as Record<string, string>) ?? undefined }, ctx.sharedCredentials);
      return outcome.ok;
    } catch {
      return null;
    }
  }

  /**
   * Identities a case can be bound to, with their credential refs resolved to
   * values. Mirrors IdentitiesService.resolved — inlined because ExploreModule
   * already imports RunsModule, so importing it back would be a cycle.
   */
  private async resolveIdentities(targetId: string, credentials: Record<string, string>): Promise<Map<string, CrawlIdentity>> {
    const rows = await this.prisma.targetIdentity.findMany({ where: { targetId }, orderBy: { order: "asc" } });
    return new Map(rows.map((i) => [i.id, {
      id: i.id,
      name: i.name,
      role: i.role,
      isAnonymous: i.isAnonymous,
      credentials: Object.fromEntries(i.credentialKeys.map((k) => [k, credentials[k]]).filter(([, v]) => v !== undefined)) as Record<string, string>,
      login: (i.loginConfig ?? {}) as CrawlIdentity["login"],
    }]));
  }

  /**
   * Put the browser in this identity's session before the case runs: clear the
   * previous session, then log in through the real form (the same deterministic
   * path the explorer uses). Returns null on success, or the reason to block.
   */
  private async loginAs(record: ActiveRun, identity: CrawlIdentity, agentPort: number, target: { config: Prisma.JsonValue }): Promise<string | null> {
    // Already known bad this run: block immediately without touching the target.
    const prior = record.loginFailures.get(identity.id);
    if (prior) return `${prior}（本次執行稍早已登入失敗，為避免反覆嘗試把帳號鎖住，這條直接標記受阻。）`;
    const url = String((target.config as Record<string, unknown>)?.url ?? "").trim();
    if (!url) return `這條 case 綁定身份「${identity.name}」，但 Target 沒有設定 url，無法登入。`;
    const baseUrl = toSandboxUrl(url);
    await this.computer.cdpReset(agentPort).catch(() => undefined); // don't inherit the previous identity's session
    let message = "";
    const ok = await new Crawler(this.computer, agentPort, baseUrl)
      .login(identity, (e) => { if (e.type === "login") message = e.message; })
      .catch(() => false);
    if (ok) return null;
    const rateLimited = /too many|rate limit|attempts|鎖定|稍後再試/i.test(message);
    const reason = `以身份「${identity.name}」(${identity.role}) 登入失敗，無法執行這條 case：${message || "未知原因"}。`
      + (rateLimited
          ? "被測系統已對登入做速率限制，請稍後再試，並先確認這組憑證是否正確。"
          : "請確認該身份的憑證是否正確、帳號是否存在。");
    record.loginFailures.set(identity.id, reason);
    return reason;
  }

  /**
   * Prove a screen-target rotation actually landed by logging in with the new
   * secret, using the identity that owns the rotated credential. This is what
   * makes "reset the password as a precondition" safe: the stored credential is
   * synced because the new value demonstrably works, not because the case passed.
   */
  private async verifyWebCredentials(
    ctx: { target: { config: Prisma.JsonValue }; agentPort: number | null; identities: Map<string, CrawlIdentity> },
    overrides: Record<string, string>,
  ): Promise<boolean> {
    if (!ctx.agentPort) return false;
    const refs = Object.keys(overrides);
    const owner = [...ctx.identities.values()].find((i) => !i.isAnonymous && refs.some((r) => r in i.credentials));
    if (!owner) return false; // nothing to log in as — cannot prove it
    const url = String((ctx.target.config as Record<string, unknown>)?.url ?? "").trim();
    if (!url) return false;
    try {
      await this.computer.cdpReset(ctx.agentPort).catch(() => undefined);
      // Apply every staged change at once: a case that renamed the account *and*
      // reset its password only logs in when both are used together.
      const probe: CrawlIdentity = { ...owner, credentials: { ...owner.credentials, ...overrides } };
      return await new Crawler(this.computer, ctx.agentPort, toSandboxUrl(url)).login(probe, () => undefined);
    } catch {
      return false;
    }
  }

  /** Serialise rotation commits so concurrent api cases never race the shared map. */
  private withRotationLock<T>(record: ActiveRun, fn: () => Promise<T>): Promise<T> {
    const run = record.rotationLock.then(fn, fn);
    record.rotationLock = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Persist and broadcast a finding the engine itself raised (not the agent). */
  private async createFinding(record: ActiveRun, caseId: string, severity: Severity, title: string, description: string) {
    const finding = await this.prisma.runFinding.create({
      data: { runId: record.runId, testCaseId: caseId, severity, title: title.slice(0, 300), description: description.slice(0, 5000) },
    });
    this.publish(record, { type: "finding", id: finding.id, caseId, severity, title: finding.title, description: finding.description });
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

  /** Always runs: the target lock and every sandbox must not outlive the run. */
  private async releaseTarget(targetId: string, sandboxes: string | Set<string> | null) {
    const ids = sandboxes == null ? [] : typeof sandboxes === "string" ? [sandboxes] : [...sandboxes];
    for (const id of ids) {
      await this.sandbox.remove(id).catch((err) =>
        this.log.warn(`failed to reclaim sandbox ${id}: ${(err as Error).message}`),
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

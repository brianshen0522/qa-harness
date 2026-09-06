import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { FindingStatus, Role, RunStatus, Severity, Verdict } from "@prisma/client";
import { LlmGatewayService } from "../llm/llm-gateway.service";
import type { LlmMessage } from "../llm/providers";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { AuditService } from "../audit/audit.service";
import { EvidenceService } from "./evidence.service";

const ASK_SYSTEM = [
  "你是 QA 分析助理。使用者剛看完一次 QA 執行的結果，對某個判定或發現不太理解，來問你。",
  "你只能根據下面提供的證據（測試案例、判定與理由、執行過程、finding）回答，不要臆造沒有的資訊。",
  "回答要能幫他「理解結論並知道下一步去查程式碼的哪裡」：",
  "- 用白話解釋這個判定/發現到底在說什麼、為什麼會這樣判。",
  "- 如果是失敗或異常，指出最可能的成因，以及建議去檢查的程式碼位置或邏輯（例如某個 endpoint、某個驗證、某個狀態碼）。",
  "- 不確定的地方就說不確定，並說明還需要什麼資訊。用繁體中文、精簡、直接。",
].join("\n");

/** Reading runs, results and findings, plus human review (§4.7). */
@Injectable()
export class RunQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly evidence: EvidenceService,
    private readonly audit: AuditService,
    private readonly gateway: LlmGatewayService,
  ) {}

  assertViewer(targetId: string, userId: string) {
    return this.perms.requireTarget(targetId, userId, Role.viewer);
  }

  async listRuns(targetId: string, userId: string) {
    await this.assertViewer(targetId, userId);
    const runs = await this.prisma.testRun.findMany({
      where: { targetId },
      orderBy: { startedAt: "desc" },
      take: 30,
      include: { _count: { select: { results: true, findings: true } } },
    });
    const counts = await this.prisma.testResult.groupBy({
      by: ["runId", "verdict"],
      where: { runId: { in: runs.map((r) => r.id) } },
      _count: { _all: true },
    });
    return runs.map((run) => ({
      ...run,
      verdicts: tally(counts.filter((c) => c.runId === run.id)),
    }));
  }

  /**
   * This run against the one before it. A QA tool is only useful if it can say
   * "this broke since last time" — a standalone verdict list can't.
   */
  async compare(runId: string, userId: string) {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException("執行不存在");
    await this.perms.requireTarget(run.targetId, userId, Role.viewer);

    const previous = await this.prisma.testRun.findFirst({
      where: { targetId: run.targetId, startedAt: { lt: run.startedAt }, status: { in: FINISHED_RUN_STATUSES } },
      orderBy: { startedAt: "desc" },
      select: { id: true, startedAt: true, status: true },
    });

    const [current, prior] = await Promise.all([
      this.prisma.testResult.findMany({ where: { runId }, include: { testCase: { select: { title: true } } } }),
      previous ? this.prisma.testResult.findMany({ where: { runId: previous.id } }) : Promise.resolve([]),
    ]);
    const before = new Map(prior.map((r) => [r.testCaseId, r.verdict]));

    const cases = current.map((r) => {
      const from = before.get(r.testCaseId) ?? null;
      return {
        caseId: r.testCaseId,
        title: r.testCase.title,
        from,
        to: r.verdict,
        change: classifyChange(from, r.verdict),
      };
    });
    const count = (c: ChangeKind) => cases.filter((x) => x.change === c).length;
    return {
      previous,
      summary: {
        regressed: count("regressed"), fixed: count("fixed"),
        stillFailing: count("still_failing"), unchanged: count("unchanged"), added: count("new"),
      },
      cases,
    };
  }

  /**
   * Verdict history over the last N runs. Answers the two questions that decide
   * whether the harness itself is trustworthy: how much are we failing to even
   * execute (blocked rate), and which cases flip verdict without the code
   * changing (flaky)?
   */
  async stability(targetId: string, userId: string, limit = 5) {
    await this.assertViewer(targetId, userId);
    const runs = await this.prisma.testRun.findMany({
      where: { targetId, status: { in: FINISHED_RUN_STATUSES } },
      orderBy: { startedAt: "desc" },
      take: Math.max(2, Math.min(limit, 20)),
      select: { id: true, startedAt: true, status: true },
    });
    if (!runs.length) return { runs: [], cases: [], flaky: [], blockedRate: null };

    const results = await this.prisma.testResult.findMany({
      where: { runId: { in: runs.map((r) => r.id) } },
      include: { testCase: { select: { title: true } } },
    });
    const order = new Map(runs.map((r, i) => [r.id, i])); // 0 = newest

    const byCase = new Map<string, { title: string; history: (Verdict | null)[] }>();
    for (const r of results) {
      const entry = byCase.get(r.testCaseId) ?? { title: r.testCase.title, history: Array(runs.length).fill(null) };
      entry.history[order.get(r.runId)!] = r.verdict;
      byCase.set(r.testCaseId, entry);
    }

    const cases = [...byCase.entries()].map(([caseId, v]) => {
      const seen = v.history.filter((x): x is Verdict => x !== null);
      // Flaky = the same case both passed and did not pass across these runs.
      const flaky = seen.includes(Verdict.pass) && seen.some((x) => x === Verdict.fail || x === Verdict.blocked);
      return { caseId, title: v.title, history: v.history, flaky };
    });

    // Blocked rate of the newest run — the number that says whether the harness
    // is actually able to execute what it was asked to.
    const newest = runs[0];
    const newestResults = results.filter((r) => r.runId === newest.id);
    const blockedRate = newestResults.length
      ? Math.round((newestResults.filter((r) => r.verdict === Verdict.blocked).length / newestResults.length) * 100)
      : null;

    return { runs, cases, flaky: cases.filter((c) => c.flaky), blockedRate };
  }

  /** One run in full: queue, results per case, findings, and per-feature rates. */
  async getRun(runId: string, userId: string) {
    const run = await this.prisma.testRun.findUnique({
      where: { id: runId },
      include: { target: { select: { id: true, name: true, kind: true, projectId: true } } },
    });
    if (!run) throw new NotFoundException("執行不存在");
    const { role } = await this.perms.requireTarget(run.targetId, userId, Role.viewer);

    const [queue, results, findings, counts] = await Promise.all([
      this.prisma.runCaseQueue.findMany({
        where: { runId },
        orderBy: { order: "asc" },
        include: {
          testCase: {
            select: {
              id: true, title: true, priority: true, type: true, currentVersion: true,
              precondition: true, setupNote: true, identityId: true, steps: true, expected: true,
              feature: { select: { id: true, name: true } },
              identity: { select: { id: true, name: true, role: true } },
            },
          },
        },
      }),
      this.prisma.testResult.findMany({ where: { runId } }),
      this.prisma.runFinding.findMany({
        where: { runId },
        orderBy: { createdAt: "asc" },
        include: { feature: { select: { id: true, name: true } } },
      }),
      this.prisma.testResult.groupBy({ by: ["verdict"], where: { runId }, _count: { _all: true } }),
    ]);

    const resultByCase = new Map(results.map((r) => [r.testCaseId, r]));
    const cases = queue.map((q) => {
      const result = resultByCase.get(q.testCaseId) ?? null;
      return {
        caseId: q.testCaseId,
        order: q.order,
        queueStatus: q.status,
        caseVersion: q.caseVersion,
        // §4.5: a case edited after this run used it is flagged, not silently stale.
        editedAfterUse: q.caseVersion !== null && q.testCase.currentVersion > q.caseVersion,
        testCase: q.testCase,
        result,
      };
    });

    // Pass rate per feature (§4.7).
    const byFeature = new Map<string, { id: string | null; name: string; pass: number; total: number }>();
    for (const c of cases) {
      const key = c.testCase.feature?.id ?? "__none__";
      const entry = byFeature.get(key) ?? {
        id: c.testCase.feature?.id ?? null,
        name: c.testCase.feature?.name ?? "未分類",
        pass: 0,
        total: 0,
      };
      if (c.result) {
        entry.total++;
        if ((c.result.humanVerdict ?? c.result.verdict) === Verdict.pass) entry.pass++;
      }
      byFeature.set(key, entry);
    }

    return {
      run: { ...run, myRole: role },
      verdicts: tally(counts.map((c) => ({ verdict: c.verdict, _count: c._count }))),
      cases,
      findings,
      features: [...byFeature.values()].filter((f) => f.total > 0),
    };
  }

  async getSteps(runId: string, userId: string, caseId?: string) {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId }, select: { targetId: true } });
    if (!run) throw new NotFoundException("執行不存在");
    await this.assertViewer(run.targetId, userId);
    return this.prisma.runStep.findMany({
      where: { runId, ...(caseId ? { testCaseId: caseId } : {}) },
      orderBy: { seq: "asc" },
    });
  }

  /** All findings for a target, across every run — the triage inbox (§4.5/§4.7). */
  async getTargetFindings(targetId: string, userId: string, opts: { status?: FindingStatus; severity?: Severity } = {}) {
    await this.assertViewer(targetId, userId);
    const rows = await this.prisma.runFinding.findMany({
      where: {
        run: { targetId },
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.severity ? { severity: opts.severity } : {}),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 500,
      include: {
        feature: { select: { id: true, name: true } },
        run: { select: { id: true, startedAt: true } },
      },
    });
    // Attach the source case title where the finding was raised, if any.
    const caseIds = [...new Set(rows.map((r) => r.testCaseId).filter((x): x is string => !!x))];
    const cases = caseIds.length
      ? await this.prisma.testCase.findMany({ where: { id: { in: caseIds } }, select: { id: true, title: true } })
      : [];
    const titleById = new Map(cases.map((c) => [c.id, c.title]));
    return rows.map((r) => ({ ...r, caseTitle: r.testCaseId ? titleById.get(r.testCaseId) ?? null : null }));
  }

  async getFindings(runId: string, userId: string) {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId }, select: { targetId: true } });
    if (!run) throw new NotFoundException("執行不存在");
    await this.assertViewer(run.targetId, userId);
    return this.prisma.runFinding.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
      include: { feature: { select: { id: true, name: true } } },
    });
  }

  /**
   * A human verdict sits alongside the model's rather than replacing it, so
   * disagreement stays visible (§4.7).
   */
  async review(resultId: string, userId: string, verdict: Verdict, note?: string) {
    const result = await this.prisma.testResult.findUnique({
      where: { id: resultId },
      include: { run: { select: { targetId: true } } },
    });
    if (!result) throw new NotFoundException("結果不存在");
    await this.perms.requireTarget(result.run.targetId, userId, Role.editor);

    const updated = await this.prisma.testResult.update({
      where: { id: resultId },
      data: { humanVerdict: verdict, humanNote: note?.slice(0, 2000) ?? null, reviewedById: userId, reviewedAt: new Date() },
    });
    await this.audit.log("user", userId, "result.review", resultId, {
      llmVerdict: result.verdict, humanVerdict: verdict, agreed: result.verdict === verdict,
    });
    return updated;
  }

  async setFindingStatus(findingId: string, userId: string, status: FindingStatus) {
    const finding = await this.prisma.runFinding.findUnique({
      where: { id: findingId },
      include: { run: { select: { targetId: true } } },
    });
    if (!finding) throw new NotFoundException("發現不存在");
    await this.perms.requireTarget(finding.run.targetId, userId, Role.editor);
    return this.prisma.runFinding.update({ where: { id: findingId }, data: { status } });
  }

  /** Keys are scoped to the run, so one run's evidence cannot be read via another. */
  async readEvidence(runId: string, userId: string, key: string) {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId }, select: { targetId: true } });
    if (!run) throw new NotFoundException("執行不存在");
    await this.assertViewer(run.targetId, userId);
    if (!key || !key.startsWith(`runs/${runId}/`) || key.includes("..")) {
      throw new ForbiddenException("證據路徑不屬於這次執行。");
    }
    return this.evidence.get(key);
  }

  /** Cases that failed in a way that looks like the feature changed (§4.4). */
  async possiblyChanged(runId: string, userId: string) {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId }, select: { targetId: true } });
    if (!run) throw new NotFoundException("執行不存在");
    await this.assertViewer(run.targetId, userId);
    return this.prisma.testResult.findMany({
      where: { runId, possiblyChanged: true },
      include: { testCase: { select: { id: true, title: true, featureId: true } } },
    });
  }

  /** Failed cases, for the "re-run failures" button (§4.7). */
  async failedCaseIds(runId: string, userId: string): Promise<string[]> {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId }, select: { targetId: true } });
    if (!run) throw new NotFoundException("執行不存在");
    await this.assertViewer(run.targetId, userId);
    const rows = await this.prisma.testResult.findMany({
      where: { runId, verdict: { in: [Verdict.fail, Verdict.blocked] } },
      select: { testCaseId: true },
    });
    if (!rows.length) throw new BadRequestException("這次執行沒有失敗或受阻的案例。");
    return rows.map((r) => r.testCaseId);
  }

  /**
   * §4.7-adjacent: let a user ask about a QA result they don't understand. The
   * answer is grounded in this run's own evidence — the case, the verdict and
   * its reasoning, the step transcript, findings — and steers toward "what to
   * check in the code", which is what a failing verdict is usually asking for.
   * Works on a finished or aborted run alike, since it reads persisted results.
   */
  async ask(runId: string, userId: string, question: string, opts: { resultId?: string; history?: { role: "user" | "assistant"; content: string }[] } = {}) {
    const run = await this.prisma.testRun.findUnique({
      where: { id: runId },
      include: { target: { select: { id: true, name: true, kind: true, description: true } } },
    });
    if (!run) throw new NotFoundException("執行不存在");
    await this.assertViewer(run.targetId, userId);
    if (!question?.trim()) throw new BadRequestException("問題不能是空的");

    const context = await this.buildAskContext(run, opts.resultId);
    const history = (opts.history ?? []).slice(-8).map((m): LlmMessage => ({ role: m.role, content: m.content }));
    const res = await this.gateway.complete(
      "discuss",
      {
        system: ASK_SYSTEM,
        messages: [
          { role: "user", content: context },
          ...history,
          { role: "user", content: question.trim() },
        ],
        maxTokens: 1500,
        reasoningEffort: "low",
      },
      { context: { projectId: null, targetId: run.targetId } },
    );
    return { answer: res.text.trim(), model: res.model };
  }

  private async buildAskContext(
    run: { id: string; target: { name: string; kind: string; description: string } },
    resultId?: string,
  ): Promise<string> {
    const lines: string[] = [
      `# 被測目標\n${run.target.name}（${run.target.kind}）`,
      run.target.description.trim() ? `## 描述\n${run.target.description.trim().slice(0, 4000)}` : "",
      "",
    ];

    if (resultId) {
      const result = await this.prisma.testResult.findUnique({
        where: { id: resultId },
        include: { testCase: { select: { id: true, title: true, precondition: true, steps: true, expected: true } } },
      });
      if (result) {
        const steps = await this.prisma.runStep.findMany({
          where: { runId: run.id, testCaseId: result.testCaseId },
          orderBy: { seq: "asc" },
        });
        lines.push(
          "# 這一條測試案例",
          `標題：${result.testCase.title}`,
          `前置條件：${result.testCase.precondition || "（無）"}`,
          `步驟：\n${((result.testCase.steps as string[]) ?? []).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
          `預期結果：${result.testCase.expected}`,
          "",
          "# 執行結果",
          `模型判定：${result.verdict}`,
          `判定理由：${result.llmReasoning || "（無）"}`,
          result.reproSteps.length ? `重現步驟：\n${result.reproSteps.map((s) => `  - ${s}`).join("\n")}` : "",
          result.possiblyChanged ? "（這條被標記為「可能是功能改了而不是壞了」）" : "",
          "",
          "# 執行過程（step transcript）",
          ...steps.map((s) => `## step-${s.seq}（${s.phase}）\n意圖：${s.intent}\n觀察：${s.observation}\n動作：${JSON.stringify(s.action)}\n結果：${JSON.stringify(s.result).slice(0, 1500)}`),
        );
      }
    } else {
      const results = await this.prisma.testResult.findMany({
        where: { runId: run.id },
        include: { testCase: { select: { title: true } } },
      });
      const findings = await this.prisma.runFinding.findMany({ where: { runId: run.id } });
      lines.push(
        "# 這次執行的所有結果",
        ...results.map((r) => `- ${r.testCase.title}：${r.verdict}${r.llmReasoning ? `（${r.llmReasoning.slice(0, 200)}）` : ""}`),
        "",
        findings.length ? "# Findings" : "",
        ...findings.map((f) => `- [${f.severity}] ${f.title}：${f.description.slice(0, 200)}`),
      );
    }
    return lines.filter(Boolean).join("\n").slice(0, 60_000);
  }
}



function tally(rows: { verdict: Verdict; _count: { _all: number } }[]): Record<string, number> {
  const counts: Record<string, number> = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  for (const r of rows) counts[r.verdict] = r._count._all;
  return counts;
}

/** Runs that actually produced results and can be compared against. */
const FINISHED_RUN_STATUSES = [RunStatus.succeeded, RunStatus.failed, RunStatus.aborted, RunStatus.interrupted];

type ChangeKind = "regressed" | "fixed" | "still_failing" | "unchanged" | "new";

/** How a case's verdict moved between two runs. */
function classifyChange(from: Verdict | null, to: Verdict): ChangeKind {
  if (from === null) return "new";
  const ok = (v: Verdict) => v === Verdict.pass;
  if (ok(from) && !ok(to)) return "regressed";
  if (!ok(from) && ok(to)) return "fixed";
  if (!ok(from) && !ok(to)) return from === to ? "still_failing" : "still_failing";
  return "unchanged";
}

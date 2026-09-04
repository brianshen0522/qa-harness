import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { FindingStatus, Role, Verdict } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { AuditService } from "../audit/audit.service";
import { EvidenceService } from "./evidence.service";

/** Reading runs, results and findings, plus human review (§4.7). */
@Injectable()
export class RunQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly evidence: EvidenceService,
    private readonly audit: AuditService,
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
              precondition: true, steps: true, expected: true,
              feature: { select: { id: true, name: true } },
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
}

function tally(rows: { verdict: Verdict; _count: { _all: number } }[]): Record<string, number> {
  const counts: Record<string, number> = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
  for (const r of rows) counts[r.verdict] = r._count._all;
  return counts;
}

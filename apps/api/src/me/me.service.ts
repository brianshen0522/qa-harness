import { Injectable } from "@nestjs/common";
import { Prisma, RunStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const ACTIVE: RunStatus[] = [RunStatus.running, RunStatus.paused, RunStatus.queued];
const RECENT_MS = 10 * 60 * 1000;

type Verdicts = { pass: number; fail: number; blocked: number; skipped: number };
function emptyVerdicts(): Verdicts {
  return { pass: 0, fail: 0, blocked: 0, skipped: 0 };
}

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every target the signed-in user can see (project membership, or a target override). */
  private myTargetsWhere(userId: string): Prisma.QaTargetWhereInput {
    return { OR: [{ project: { members: { some: { userId } } } }, { members: { some: { userId } } }] };
  }

  /** Light: the user's active runs plus those finished in the last 10 min, for the header watcher. */
  async myRuns(userId: string) {
    const targets = await this.prisma.qaTarget.findMany({ where: this.myTargetsWhere(userId), select: { id: true, name: true, projectId: true } });
    if (!targets.length) return [];
    const tmap = new Map(targets.map((t) => [t.id, t]));
    const ids = targets.map((t) => t.id);
    const cutoff = new Date(Date.now() - RECENT_MS);
    const runs = await this.prisma.testRun.findMany({
      where: { targetId: { in: ids }, OR: [{ status: { in: ACTIVE } }, { endedAt: { gte: cutoff } }] },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: { id: true, targetId: true, status: true, startedAt: true, endedAt: true },
    });
    if (!runs.length) return [];
    const runIds = runs.map((r) => r.id);
    const [queue, verdicts] = await Promise.all([
      this.prisma.runCaseQueue.groupBy({ by: ["runId", "status"], where: { runId: { in: runIds } }, _count: { _all: true } }),
      this.prisma.testResult.groupBy({ by: ["runId", "verdict"], where: { runId: { in: runIds } }, _count: { _all: true } }),
    ]);
    return runs.map((r) => {
      const q = queue.filter((x) => x.runId === r.id);
      const total = q.reduce((a, x) => a + x._count._all, 0);
      const done = q.filter((x) => x.status === "done" || x.status === "skipped").reduce((a, x) => a + x._count._all, 0);
      const v = emptyVerdicts();
      for (const row of verdicts.filter((x) => x.runId === r.id)) v[row.verdict] = row._count._all;
      const t = tmap.get(r.targetId)!;
      return { id: r.id, targetId: r.targetId, targetName: t.name, projectId: t.projectId, status: r.status, total, done, verdicts: v, startedAt: r.startedAt, endedAt: r.endedAt };
    });
  }

  /** Dashboard: per-target attention items, plus headline totals. */
  async overview(userId: string) {
    const targets = await this.prisma.qaTarget.findMany({
      where: this.myTargetsWhere(userId),
      select: { id: true, name: true, kind: true, status: true, projectId: true, project: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
    });
    if (!targets.length) return { targets: [], totals: { activeRuns: 0, failingTargets: 0, outdatedCases: 0, openFindings: 0 } };
    const ids = targets.map((t) => t.id);

    const [outdated, openFindings, latestRuns] = await Promise.all([
      this.prisma.testCase.groupBy({ by: ["targetId"], where: { targetId: { in: ids }, status: "outdated" }, _count: { _all: true } }),
      this.prisma.runFinding.findMany({ where: { status: "open", run: { targetId: { in: ids } } }, select: { run: { select: { targetId: true } } } }),
      // The most recent run per target (active or not), for last-result + progress.
      this.prisma.testRun.findMany({
        where: { targetId: { in: ids } },
        orderBy: { startedAt: "desc" },
        select: { id: true, targetId: true, status: true, startedAt: true, endedAt: true },
      }),
    ]);

    const outdatedByTarget = new Map(outdated.map((o) => [o.targetId, o._count._all]));
    const findingsByTarget = new Map<string, number>();
    for (const f of openFindings) findingsByTarget.set(f.run.targetId, (findingsByTarget.get(f.run.targetId) ?? 0) + 1);

    // First run seen per target is the latest (list is ordered desc); also track any active run.
    const lastByTarget = new Map<string, (typeof latestRuns)[number]>();
    const activeByTarget = new Map<string, (typeof latestRuns)[number]>();
    for (const r of latestRuns) {
      if (!lastByTarget.has(r.targetId)) lastByTarget.set(r.targetId, r);
      if (!activeByTarget.has(r.targetId) && ACTIVE.includes(r.status)) activeByTarget.set(r.targetId, r);
    }

    // Verdict tallies + progress for the runs we surface.
    const surfaced = [...new Set([...lastByTarget.values(), ...activeByTarget.values()].map((r) => r.id))];
    const [verdicts, queue] = await Promise.all([
      surfaced.length ? this.prisma.testResult.groupBy({ by: ["runId", "verdict"], where: { runId: { in: surfaced } }, _count: { _all: true } }) : [],
      surfaced.length ? this.prisma.runCaseQueue.groupBy({ by: ["runId", "status"], where: { runId: { in: surfaced } }, _count: { _all: true } }) : [],
    ]);
    const verdictsFor = (runId: string) => {
      const v = emptyVerdicts();
      for (const row of verdicts.filter((x) => x.runId === runId)) v[row.verdict] = row._count._all;
      return v;
    };
    const progressFor = (runId: string) => {
      const q = queue.filter((x) => x.runId === runId);
      const total = q.reduce((a, x) => a + x._count._all, 0);
      const done = q.filter((x) => x.status === "done" || x.status === "skipped").reduce((a, x) => a + x._count._all, 0);
      return { total, done };
    };

    let failingTargets = 0;
    const out = targets.map((t) => {
      const last = lastByTarget.get(t.id) ?? null;
      const active = activeByTarget.get(t.id) ?? null;
      const lastVerdicts = last ? verdictsFor(last.id) : null;
      if (lastVerdicts && lastVerdicts.fail > 0) failingTargets++;
      return {
        id: t.id,
        name: t.name,
        kind: t.kind,
        projectId: t.projectId,
        projectName: t.project.name,
        running: t.status === "running",
        outdatedCases: outdatedByTarget.get(t.id) ?? 0,
        openFindings: findingsByTarget.get(t.id) ?? 0,
        activeRun: active ? { id: active.id, status: active.status, ...progressFor(active.id) } : null,
        lastRun: last ? { id: last.id, status: last.status, endedAt: last.endedAt, verdicts: lastVerdicts } : null,
      };
    });

    return {
      targets: out,
      totals: {
        activeRuns: activeByTarget.size,
        failingTargets,
        outdatedCases: [...outdatedByTarget.values()].reduce((a, b) => a + b, 0),
        openFindings: openFindings.length,
      },
    };
  }
}

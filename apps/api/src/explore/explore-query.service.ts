import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ObservationKind, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { EvidenceService } from "../runs/evidence.service";
import { buildMatrix } from "./permission-matrix";

/** Reading an exploration's site map, coverage, permission matrix and findings. */
@Injectable()
export class ExploreQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly evidence: EvidenceService,
  ) {}

  assertViewer(targetId: string, userId: string) {
    return this.perms.requireTarget(targetId, userId, Role.viewer);
  }

  async latest(targetId: string, userId: string) {
    await this.assertViewer(targetId, userId);
    const run = await this.prisma.explorationRun.findFirst({ where: { targetId }, orderBy: { startedAt: "desc" } });
    return run ? this.detail(run.id, userId) : null;
  }

  async detail(runId: string, userId: string) {
    const run = await this.prisma.explorationRun.findUnique({
      where: { id: runId },
      include: { target: { select: { id: true, name: true } } },
    });
    if (!run) throw new NotFoundException("探索紀錄不存在");
    const { role } = await this.assertViewer(run.targetId, userId);

    const [nodes, edges, identities, observations] = await Promise.all([
      this.prisma.siteNode.findMany({ where: { runId }, orderBy: [{ depth: "asc" }, { routeKey: "asc" }] }),
      this.prisma.siteEdge.findMany({ where: { runId } }),
      this.prisma.targetIdentity.findMany({ where: { targetId: run.targetId }, orderBy: { order: "asc" } }),
      this.prisma.siteObservation.findMany({
        where: { runId, kind: { in: [ObservationKind.rwd_issue, ObservationKind.finding, ObservationKind.deep_note] } },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const roles = [...new Set(identities.map((i) => i.role))];
    const privileged = identities.find((i) => /admin|owner|root|super/i.test(i.role))?.role ?? roles[0] ?? null;
    const matrix = buildMatrix(
      nodes.map((n) => ({ routeKey: n.routeKey, title: n.title, reachableBy: n.reachableBy, deniedFor: n.deniedFor })),
      roles,
      privileged,
    );

    // Pick a representative screenshot per node (the privileged identity's, ideally).
    const snaps = await this.prisma.siteObservation.findMany({
      where: { runId, kind: ObservationKind.page_snapshot, screenshotKey: { not: null } },
      select: { nodeId: true, screenshotKey: true },
    });
    const shotByNode = new Map<string, string>();
    for (const s of snaps) if (s.nodeId && !shotByNode.has(s.nodeId)) shotByNode.set(s.nodeId, s.screenshotKey!);

    return {
      run: {
        id: run.id, status: run.status, stats: run.stats, config: run.config,
        pausedReason: run.pausedReason, error: run.error, llmCalls: run.llmCalls,
        startedAt: run.startedAt, endedAt: run.endedAt,
        target: run.target, myRole: role,
      },
      identities: identities.map((i) => ({ id: i.id, name: i.name, role: i.role, isAnonymous: i.isAnonymous })),
      nodes: nodes.map((n) => ({
        id: n.id, routeKey: n.routeKey, sampleUrl: n.sampleUrl, title: n.title,
        kind: n.kind, depth: n.depth, reachableBy: n.reachableBy, deniedFor: n.deniedFor,
        screenshotKey: shotByNode.get(n.id) ?? null,
      })),
      edges: edges.map((e) => ({ from: e.fromId, to: e.toId, kind: e.kind, label: e.label })),
      matrix,
      observations: observations.map((o) => ({
        id: o.id, nodeId: o.nodeId, kind: o.kind, severity: o.severity,
        breakpoint: o.breakpoint, note: o.note, data: o.data, screenshotKey: o.screenshotKey,
      })),
    };
  }

  async readEvidence(runId: string, userId: string, key: string) {
    const run = await this.prisma.explorationRun.findUnique({ where: { id: runId }, select: { targetId: true } });
    if (!run) throw new NotFoundException("探索紀錄不存在");
    await this.assertViewer(run.targetId, userId);
    if (!key || !key.startsWith(`explore/${runId}/`) || key.includes("..")) {
      throw new ForbiddenException("截圖路徑不屬於這次探索。");
    }
    return this.evidence.get(key);
  }
}

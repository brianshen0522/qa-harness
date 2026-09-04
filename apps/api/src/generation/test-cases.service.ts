import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  CaseSource, CaseStatus, FeatureStatus, Prisma, Priority, Role, type CaseType,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { AuditService } from "../audit/audit.service";
import { snapshot } from "./generation.service";

export interface CaseInput {
  title: string;
  precondition?: string;
  steps: string[];
  expected: string;
  priority?: Priority;
  type?: CaseType;
  featureId?: string | null;
}

@Injectable()
export class TestCasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  /** Features with their cases, plus any case not attached to a feature. */
  async list(targetId: string, userId: string) {
    const { role } = await this.perms.requireTarget(targetId, userId, Role.viewer);
    const [features, cases, target] = await Promise.all([
      this.prisma.feature.findMany({ where: { targetId }, orderBy: { order: "asc" } }),
      this.prisma.testCase.findMany({ where: { targetId }, orderBy: { order: "asc" } }),
      this.prisma.qaTarget.findUniqueOrThrow({
        where: { id: targetId },
        select: { name: true, kind: true, status: true, descriptionVersion: true },
      }),
    ]);

    const byFeature = new Map<string, typeof cases>();
    const loose: typeof cases = [];
    for (const c of cases) {
      if (!c.featureId) loose.push(c);
      else {
        const list = byFeature.get(c.featureId) ?? [];
        list.push(c);
        byFeature.set(c.featureId, list);
      }
    }

    return {
      target: { ...target, myRole: role, locked: target.status === "running" },
      counts: {
        features: features.length,
        cases: cases.length,
        active: cases.filter((c) => c.status === CaseStatus.active).length,
        outdated: cases.filter((c) => c.status === CaseStatus.outdated).length,
        deprecated: cases.filter((c) => c.status === CaseStatus.deprecated).length,
      },
      features: features.map((f) => ({
        ...f,
        stale: f.basedOnDescriptionVersion < target.descriptionVersion,
        cases: byFeature.get(f.id) ?? [],
      })),
      unassigned: loose,
    };
  }

  async createCase(targetId: string, userId: string, input: CaseInput) {
    await this.requireEditable(targetId, userId);
    this.validate(input);
    if (input.featureId) await this.assertFeature(targetId, input.featureId);

    const target = await this.prisma.qaTarget.findUniqueOrThrow({
      where: { id: targetId },
      select: { descriptionVersion: true },
    });
    const order = ((await this.prisma.testCase.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1) + 1;

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.testCase.create({
        data: {
          targetId,
          featureId: input.featureId ?? null,
          title: input.title.trim(),
          precondition: input.precondition?.trim() ?? "",
          steps: input.steps as Prisma.InputJsonValue,
          expected: input.expected.trim(),
          priority: input.priority ?? Priority.P2,
          type: input.type ?? "happy",
          source: CaseSource.manual,
          order,
          basedOnDescriptionVersion: target.descriptionVersion,
          createdById: userId,
        },
      });
      await tx.testCaseVersion.create({
        data: { testCaseId: row.id, version: 1, content: snapshot(row) as Prisma.InputJsonObject, createdBy: userId },
      });
      return row;
    });
    await this.audit.log("user", userId, "testcase.create", created.id, { targetId, title: created.title });
    return created;
  }

  /** Every edit writes a new version, so a case can be traced back (§3.2). */
  async updateCase(caseId: string, userId: string, input: Partial<CaseInput> & { status?: CaseStatus }) {
    const existing = await this.getCase(caseId);
    await this.requireEditable(existing.targetId, userId);
    if (input.featureId) await this.assertFeature(existing.targetId, input.featureId);
    if (input.title !== undefined || input.steps !== undefined || input.expected !== undefined) {
      this.validate({
        title: input.title ?? existing.title,
        steps: (input.steps ?? existing.steps) as string[],
        expected: input.expected ?? existing.expected,
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.testCase.update({
        where: { id: caseId },
        data: {
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.precondition !== undefined ? { precondition: input.precondition.trim() } : {}),
          ...(input.steps !== undefined ? { steps: input.steps as Prisma.InputJsonValue } : {}),
          ...(input.expected !== undefined ? { expected: input.expected.trim() } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.featureId !== undefined ? { featureId: input.featureId } : {}),
          currentVersion: { increment: 1 },
        },
      });
      await tx.testCaseVersion.create({
        data: {
          testCaseId: row.id,
          version: row.currentVersion,
          content: snapshot(row) as Prisma.InputJsonObject,
          createdBy: userId,
        },
      });
      return row;
    });
    await this.audit.log("user", userId, "testcase.update", caseId, { fields: Object.keys(input) });
    return updated;
  }

  async deleteCase(caseId: string, userId: string) {
    const existing = await this.getCase(caseId);
    await this.requireEditable(existing.targetId, userId);
    await this.prisma.testCase.delete({ where: { id: caseId } });
    await this.audit.log("user", userId, "testcase.delete", caseId, { targetId: existing.targetId });
    return { ok: true };
  }

  async versions(caseId: string, userId: string) {
    const existing = await this.getCase(caseId);
    await this.perms.requireTarget(existing.targetId, userId, Role.viewer);
    return this.prisma.testCaseVersion.findMany({
      where: { testCaseId: caseId },
      orderBy: { version: "desc" },
    });
  }

  /** Bulk status change, used by the "N 條待處理" review flow. */
  async setStatuses(targetId: string, userId: string, caseIds: string[], status: CaseStatus) {
    await this.requireEditable(targetId, userId);
    const { count } = await this.prisma.testCase.updateMany({
      where: { id: { in: caseIds }, targetId },
      data: { status },
    });
    await this.audit.log("user", userId, "testcase.status", targetId, { count, status });
    return { count };
  }

  async reorder(targetId: string, userId: string, caseIds: string[]) {
    await this.requireEditable(targetId, userId);
    const owned = await this.prisma.testCase.count({ where: { targetId, id: { in: caseIds } } });
    if (owned !== caseIds.length) throw new BadRequestException("清單裡有不屬於這個 Target 的 case");
    await this.prisma.$transaction(
      caseIds.map((id, order) => this.prisma.testCase.update({ where: { id }, data: { order } })),
    );
    return { ok: true };
  }

  // ----- features -----

  async createFeature(targetId: string, userId: string, name: string, description = "") {
    await this.requireEditable(targetId, userId);
    if (!name.trim()) throw new BadRequestException("功能名稱不能是空的");
    const target = await this.prisma.qaTarget.findUniqueOrThrow({
      where: { id: targetId },
      select: { descriptionVersion: true },
    });
    const order = ((await this.prisma.feature.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1) + 1;
    const existing = await this.prisma.feature.findUnique({ where: { targetId_name: { targetId, name: name.trim() } } });
    if (existing) throw new BadRequestException("已經有同名的功能");
    return this.prisma.feature.create({
      data: {
        targetId, name: name.trim(), description: description.trim(),
        order, basedOnDescriptionVersion: target.descriptionVersion,
      },
    });
  }

  async updateFeature(featureId: string, userId: string, input: { name?: string; description?: string; status?: FeatureStatus }) {
    const feature = await this.prisma.feature.findUnique({ where: { id: featureId } });
    if (!feature) throw new NotFoundException("功能不存在");
    await this.requireEditable(feature.targetId, userId);
    return this.prisma.feature.update({
      where: { id: featureId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
  }

  /** Cases keep existing; they simply lose their feature. */
  async deleteFeature(featureId: string, userId: string) {
    const feature = await this.prisma.feature.findUnique({ where: { id: featureId } });
    if (!feature) throw new NotFoundException("功能不存在");
    await this.requireEditable(feature.targetId, userId);
    await this.prisma.feature.delete({ where: { id: featureId } });
    await this.audit.log("user", userId, "feature.delete", featureId, { targetId: feature.targetId });
    return { ok: true };
  }

  // ----- helpers -----

  private async getCase(caseId: string) {
    const row = await this.prisma.testCase.findUnique({ where: { id: caseId } });
    if (!row) throw new NotFoundException("測試案例不存在");
    return row;
  }

  private async assertFeature(targetId: string, featureId: string) {
    const feature = await this.prisma.feature.findUnique({ where: { id: featureId } });
    if (!feature || feature.targetId !== targetId) throw new BadRequestException("功能不屬於這個 Target");
  }

  /**
   * Editor or above, and the target must be idle. §4.5 allows editing queued
   * cases mid-run; that needs the run queue, which arrives with the worker.
   */
  private async requireEditable(targetId: string, userId: string) {
    await this.perms.requireTarget(targetId, userId, Role.editor);
    const target = await this.prisma.qaTarget.findUniqueOrThrow({
      where: { id: targetId },
      select: { status: true },
    });
    if (target.status === "running") throw new ConflictException("Target 執行中，測試清單暫時鎖定。");
  }

  private validate(input: { title: string; steps: string[]; expected: string }) {
    if (!input.title?.trim()) throw new BadRequestException("標題不能是空的");
    if (!Array.isArray(input.steps) || !input.steps.filter((s) => s?.trim()).length) {
      throw new BadRequestException("至少要有一個步驟");
    }
    if (!input.expected?.trim()) throw new BadRequestException("預期結果不能是空的");
  }
}

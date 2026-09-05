import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  CaseSource, CaseStatus, ChangeSource, DescriptionSource, FeatureStatus, FindingStatus,
  Prisma, Priority, ProposalState, Role, Scope, type CaseType,
} from "@prisma/client";
import type { ChangeProposal as ProposalOutput } from "@qa-harness/schemas";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { LlmGatewayService } from "../llm/llm-gateway.service";
import { AuditService } from "../audit/audit.service";
import { caseDiff, lineDiff, mergeSnapshot, type CaseSnapshot } from "./change-diff";
import {
  buildChangeContext, caseDetailContext, CASE_DETAIL_SYSTEM, CHANGE_SYSTEM,
  detectionNote, findingNote, type CaseForPrompt, type FeatureForPrompt,
} from "./change-prompts";

/** One proposed feature change, with a stable id so decisions survive re-ordering. */
export interface FeatureChangeItem {
  id: string;
  op: "add" | "modify" | "remove";
  featureId: string | null;
  name: string;
  description: string;
  before: { name: string; description: string } | null;
  reason: string;
  /** Why this item cannot be applied, when the model referred to something that is gone. */
  unresolved?: string;
}

export interface CaseChangeItem {
  id: string;
  op: "add" | "modify" | "mark_outdated" | "deprecate";
  caseId: string | null;
  featureRef: string;
  before: CaseSnapshot | null;
  after: CaseSnapshot | null;
  /** Rendered before/after diff; §4.4 requires modifications to show one. */
  diff: string;
  reason: string;
  unresolved?: string;
}

export interface Decisions {
  /** Whether to write the new description. Ignored when the proposal has none. */
  description?: boolean;
  /** itemId → accepted. Anything missing counts as rejected. */
  items?: Record<string, boolean>;
  /** itemId → fields the reviewer edited by hand before applying. */
  edits?: Record<string, Partial<CaseSnapshot>>;
}

export interface AnalyzeInput {
  source: ChangeSource;
  note: string;
  /** The description the user already wrote, for the "編輯描述後按分析影響" entry. */
  proposedDescription?: string;
  originNote?: string;
}

const PRIORITIES = new Set<string>(Object.values(Priority));
const CASE_TYPES = new Set<string>(["happy", "edge", "negative", "boundary", "security", "performance"]);

/**
 * How many cases one proposal will write out. The impact pass may name more; the
 * rest are still shown, flagged as needing a second round rather than silently
 * dropped, so nobody thinks the proposal covered everything.
 */
const MAX_CASE_DETAILS = 15;

@Injectable()
export class ChangesService {
  private readonly log = new Logger(ChangesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly gateway: LlmGatewayService,
    private readonly audit: AuditService,
  ) {}

  // ---------- creating a proposal ----------

  /**
   * Spec §4.4: every entry point lands here. The model sees the current
   * description, features and cases, and proposes changes; nothing is written to
   * the live test list until someone accepts it.
   */
  async analyze(scope: Scope, id: string, userId: string, input: AnalyzeInput) {
    const ctx = await this.resolve(scope, id, userId, Role.editor);
    const note = input.note.trim();
    if (!note && !input.proposedDescription?.trim()) {
      throw new BadRequestException("請說明這次變更了什麼，或先改好描述再分析影響。");
    }

    const { features, cases } = await this.inventory(ctx);
    const context = buildChangeContext(
      {
        scope: scope === Scope.project ? "project" : "target",
        entityName: ctx.name,
        kind: ctx.kind,
        description: ctx.description,
        features,
        cases,
        proposedDescription: input.proposedDescription,
      },
      input.source,
      note,
    );

    const system =
      scope === Scope.project
        ? `${CHANGE_SYSTEM}\n\n## 這一份是 Project 層級\n功能和測試案例都掛在底下的 Target，不在這一層。\n所以 \`feature_changes\` 和 \`test_case_changes\` 一律給空陣列，只處理描述。`
        : CHANGE_SYSTEM;

    const result = await this.gateway.structured("generate", "change_proposal", {
      system,
      messages: [{ role: "user", content: context }],
      // Reading a whole test list is a wide but shallow judgement. Left to think
      // freely the model spends the entire budget reasoning and returns nothing,
      // and the request outlives the gateway's own deadline; held short it
      // answers the same question in a third of the time.
      maxTokens: 12_000,
      reasoningEffort: "low",
    }, { context: { projectId: ctx.projectId, targetId: ctx.targetId } });

    const normalised = this.normalise(result.data, ctx, features, cases, scope, input.proposedDescription);
    if (!normalised.descriptionAfter && !normalised.featureChanges.length && !normalised.caseChanges.length) {
      // An empty proposal sitting in the pending list is noise nobody can act on.
      throw new BadRequestException(
        "模型判斷這次的說明沒有對描述、功能或測試案例造成任何影響。如果你認為有，請把變更講得更具體一點。",
      );
    }
    await this.fillCaseDetails(normalised, ctx, note);

    const proposal = await this.prisma.changeProposal.create({
      data: {
        scope,
        projectId: ctx.projectId,
        targetId: ctx.targetId ?? null,
        source: input.source,
        summary: result.data.summary?.trim().slice(0, 2000) || "（模型沒有給摘要）",
        descriptionDiff: normalised.descriptionDiff,
        descriptionAfter: normalised.descriptionAfter,
        featureChanges: normalised.featureChanges as unknown as Prisma.InputJsonValue,
        testCaseChanges: normalised.caseChanges as unknown as Prisma.InputJsonValue,
        originNote: input.originNote?.slice(0, 4000) ?? note.slice(0, 4000),
        model: result.model,
        createdById: userId,
      },
    });
    await this.audit.log("user", userId, "change.propose", proposal.id, {
      scope, entityId: id, source: input.source,
      features: normalised.featureChanges.length, cases: normalised.caseChanges.length,
    });
    return this.shape(proposal);
  }

  /** §4.4 被動偵測: turn a run's "this looks changed, not broken" results into a proposal. */
  async fromRun(runId: string, userId: string) {
    const run = await this.prisma.testRun.findUnique({ where: { id: runId }, select: { targetId: true } });
    if (!run) throw new NotFoundException("執行不存在");
    // Authorize before reading results, so a non-member can't probe run existence.
    await this.perms.requireTarget(run.targetId, userId, Role.editor);
    const results = await this.prisma.testResult.findMany({
      where: { runId, possiblyChanged: true },
      select: {
        llmReasoning: true,
        testCase: { select: { title: true, feature: { select: { name: true } } } },
      },
    });
    if (!results.length) throw new BadRequestException("這次執行沒有任何看起來像功能變更的失敗。");

    return this.analyze(Scope.target, run.targetId, userId, {
      source: ChangeSource.run_detection,
      note: detectionNote(
        results.map((r) => ({
          title: r.testCase.title,
          reasoning: r.llmReasoning,
          featureName: r.testCase.feature?.name ?? null,
        })),
      ),
      originNote: `run:${runId}`,
    });
  }

  /** §4.5 → §4.4: a finding the agent raised can become a change proposal. */
  async fromFinding(findingId: string, userId: string) {
    const finding = await this.prisma.runFinding.findUnique({
      where: { id: findingId },
      include: { run: { select: { targetId: true } } },
    });
    if (!finding) throw new NotFoundException("Finding 不存在");
    await this.perms.requireTarget(finding.run.targetId, userId, Role.editor);

    const proposal = await this.analyze(Scope.target, finding.run.targetId, userId, {
      source: ChangeSource.finding,
      note: findingNote(finding),
      originNote: `finding:${findingId}`,
    });
    await this.prisma.runFinding.update({
      where: { id: findingId },
      data: { status: FindingStatus.converted_to_proposal, convertedProposalId: proposal.id },
    });
    return proposal;
  }

  // ---------- reading ----------

  async list(scope: Scope, id: string, userId: string) {
    const ctx = await this.resolve(scope, id, userId, Role.viewer);
    const where =
      scope === Scope.project ? { projectId: ctx.projectId, scope: Scope.project } : { targetId: ctx.targetId };
    const rows = await this.prisma.changeProposal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      canEdit: ctx.role === Role.owner || ctx.role === Role.editor,
      running: ctx.running,
      proposals: rows.map((r) => this.shape(r)),
    };
  }

  async get(proposalId: string, userId: string) {
    const proposal = await this.load(proposalId);
    await this.requireOn(proposal, userId, Role.viewer);
    return this.shape(proposal);
  }

  /** §4.4 Change Log: one timeline per project and per target. */
  async logs(scope: Scope, id: string, userId: string) {
    const ctx = await this.resolve(scope, id, userId, Role.viewer);
    const where = scope === Scope.project ? { projectId: ctx.projectId, scope: Scope.project } : { targetId: ctx.targetId };
    const rows = await this.prisma.changeLog.findMany({
      where,
      orderBy: { appliedAt: "desc" },
      take: 100,
    });
    const userIds = [...new Set(rows.map((r) => r.appliedById))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      proposalId: r.proposalId,
      source: r.source,
      summary: r.summary,
      descriptionVersionAfter: r.descriptionVersionAfter,
      featureCount: r.affectedFeatureIds.length,
      caseCount: r.affectedTestCaseIds.length,
      appliedAt: r.appliedAt,
      appliedBy: byId.get(r.appliedById)?.name ?? byId.get(r.appliedById)?.email ?? "（已移除的使用者）",
    }));
  }

  /** Every version of one case, with the change that produced it (§4.4 回溯). */
  async caseHistory(caseId: string, userId: string) {
    const row = await this.prisma.testCase.findUnique({ where: { id: caseId }, select: { targetId: true } });
    if (!row) throw new NotFoundException("測試案例不存在");
    await this.perms.requireTarget(row.targetId, userId, Role.viewer);
    const versions = await this.prisma.testCaseVersion.findMany({
      where: { testCaseId: caseId },
      orderBy: { version: "desc" },
    });
    const changeIds = [...new Set(versions.map((v) => v.changeId).filter((x): x is string => !!x))];
    const logs = changeIds.length
      ? await this.prisma.changeLog.findMany({ where: { id: { in: changeIds } } })
      : [];
    const byId = new Map(logs.map((l) => [l.id, l]));
    return versions.map((v) => ({
      version: v.version,
      content: v.content,
      createdAt: v.createdAt,
      change: v.changeId
        ? { id: v.changeId, summary: byId.get(v.changeId)?.summary ?? "", source: byId.get(v.changeId)?.source ?? null }
        : null,
    }));
  }

  // ---------- deciding ----------

  async reject(proposalId: string, userId: string) {
    const proposal = await this.load(proposalId);
    await this.requireOn(proposal, userId, Role.editor);
    if (proposal.state !== ProposalState.pending) throw new BadRequestException(`提案已經是 ${proposal.state} 狀態`);
    const updated = await this.prisma.changeProposal.update({
      where: { id: proposalId },
      data: { state: ProposalState.rejected, decidedById: userId, decidedAt: new Date() },
    });
    await this.audit.log("user", userId, "change.reject", proposalId, {});
    return this.shape(updated);
  }

  /**
   * Applies the accepted parts of a proposal. Partial acceptance is the normal
   * case (§4.4 提案可以部分接受), so anything not explicitly accepted is left alone
   * and recorded as rejected in the change log.
   */
  async apply(proposalId: string, userId: string, decisions: Decisions) {
    const proposal = await this.load(proposalId);
    await this.requireOn(proposal, userId, Role.editor);
    if (proposal.state !== ProposalState.pending) throw new BadRequestException(`提案已經是 ${proposal.state} 狀態`);

    if (proposal.targetId) {
      // §4.4: a proposal may be created during a run, but not applied during one.
      const target = await this.prisma.qaTarget.findUnique({
        where: { id: proposal.targetId },
        select: { status: true },
      });
      if (target?.status === "running") {
        throw new ConflictException("Target 執行中，等這次執行結束才能套用提案。");
      }
    }

    const featureItems = (proposal.featureChanges as unknown as FeatureChangeItem[]) ?? [];
    const caseItems = (proposal.testCaseChanges as unknown as CaseChangeItem[]) ?? [];
    const accepted = (item: { id: string; unresolved?: string }) =>
      !item.unresolved && decisions.items?.[item.id] === true;

    const takeDescription = !!decisions.description && !!proposal.descriptionAfter.trim();
    const featuresToApply = featureItems.filter(accepted);
    const casesToApply = caseItems.filter(accepted);
    if (!takeDescription && !featuresToApply.length && !casesToApply.length) {
      throw new BadRequestException("沒有勾選任何要套用的項目。");
    }

    const logId = randomUUID();
    const affectedFeatureIds = new Set<string>();
    const affectedCaseIds = new Set<string>();
    let descriptionVersionAfter: number | null = null;

    await this.prisma.$transaction(async (tx) => {
      // ----- description -----
      if (takeDescription) {
        if (proposal.scope === Scope.project) {
          const current = await tx.project.findUniqueOrThrow({
            where: { id: proposal.projectId! },
            select: { descriptionVersion: true },
          });
          descriptionVersionAfter = current.descriptionVersion + 1;
          await tx.projectDescriptionVersion.create({
            data: {
              projectId: proposal.projectId!,
              version: descriptionVersionAfter,
              content: proposal.descriptionAfter,
              source: sourceToDescriptionSource(proposal.source),
              createdBy: userId,
            },
          });
          await tx.project.update({
            where: { id: proposal.projectId! },
            data: { description: proposal.descriptionAfter, descriptionVersion: descriptionVersionAfter },
          });
        } else {
          const updated = await tx.qaTarget.update({
            where: { id: proposal.targetId! },
            data: { description: proposal.descriptionAfter, descriptionVersion: { increment: 1 } },
            select: { descriptionVersion: true },
          });
          descriptionVersionAfter = updated.descriptionVersion;
        }
      }

      if (!proposal.targetId) return; // project scope carries description changes only

      const targetId = proposal.targetId;
      const target = await tx.qaTarget.findUniqueOrThrow({
        where: { id: targetId },
        select: { descriptionVersion: true },
      });
      const version = descriptionVersionAfter ?? target.descriptionVersion;

      // ----- features -----
      let featureOrder = (await tx.feature.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1;
      for (const item of featuresToApply) {
        if (item.op === "add") {
          featureOrder++;
          const row = await tx.feature.upsert({
            where: { targetId_name: { targetId, name: item.name } },
            create: {
              targetId, name: item.name, description: item.description,
              basedOnDescriptionVersion: version, order: featureOrder,
            },
            update: { description: item.description, status: FeatureStatus.active, basedOnDescriptionVersion: version },
          });
          affectedFeatureIds.add(row.id);
          continue;
        }
        if (!item.featureId) continue;
        const existing = await tx.feature.findUnique({ where: { id: item.featureId } });
        if (!existing || existing.targetId !== targetId) continue;

        if (item.op === "modify") {
          // A rename that collides with another feature would violate the unique
          // key, so keep the old name and take the description change.
          const clash = item.name && item.name !== existing.name
            ? await tx.feature.findUnique({ where: { targetId_name: { targetId, name: item.name } } })
            : null;
          await tx.feature.update({
            where: { id: existing.id },
            data: {
              ...(item.name && !clash ? { name: item.name } : {}),
              description: item.description,
              basedOnDescriptionVersion: version,
            },
          });
          affectedFeatureIds.add(existing.id);
        } else {
          await tx.feature.update({ where: { id: existing.id }, data: { status: FeatureStatus.removed } });
          affectedFeatureIds.add(existing.id);
          // Its cases stop running but stay as history (§4.4 test case 狀態).
          const orphans = await tx.testCase.findMany({
            where: { featureId: existing.id, status: { not: CaseStatus.deprecated } },
          });
          for (const c of orphans) {
            const row = await tx.testCase.update({
              where: { id: c.id },
              data: { status: CaseStatus.deprecated, currentVersion: { increment: 1 } },
            });
            await tx.testCaseVersion.create({
              data: {
                testCaseId: row.id, version: row.currentVersion,
                content: caseSnapshotRow(row) as Prisma.InputJsonObject,
                changeId: logId, createdBy: userId,
              },
            });
            affectedCaseIds.add(row.id);
          }
        }
      }

      // ----- test cases -----
      let caseOrder = (await tx.testCase.aggregate({ where: { targetId }, _max: { order: true } }))._max.order ?? -1;
      for (const item of casesToApply) {
        const after = item.after ? mergeSnapshot(item.after, decisions.edits?.[item.id]) : null;

        if (item.op === "add") {
          if (!after) continue;
          const featureId = after.featureName
            ? await ensureFeature(tx, targetId, after.featureName, version, ++featureOrder)
            : null;
          if (featureId) affectedFeatureIds.add(featureId);
          caseOrder++;
          const created = await tx.testCase.create({
            data: {
              targetId, featureId,
              title: after.title, precondition: after.precondition,
              steps: after.steps as Prisma.InputJsonValue, expected: after.expected,
              priority: after.priority as Priority, type: after.type as CaseType,
              source: CaseSource.change_proposal, status: CaseStatus.active,
              order: caseOrder, basedOnDescriptionVersion: version, createdById: userId,
            },
          });
          await tx.testCaseVersion.create({
            data: {
              testCaseId: created.id, version: 1,
              content: caseSnapshotRow(created) as Prisma.InputJsonObject,
              changeId: logId, createdBy: userId,
            },
          });
          affectedCaseIds.add(created.id);
          continue;
        }

        if (!item.caseId) continue;
        const existing = await tx.testCase.findUnique({ where: { id: item.caseId } });
        if (!existing || existing.targetId !== targetId) continue;

        const data: Prisma.TestCaseUpdateInput = { currentVersion: { increment: 1 } };
        if (item.op === "modify" && after) {
          data.title = after.title;
          data.precondition = after.precondition;
          data.steps = after.steps as Prisma.InputJsonValue;
          data.expected = after.expected;
          data.priority = after.priority as Priority;
          data.type = after.type as CaseType;
          data.status = CaseStatus.active; // it has been dealt with
          data.basedOnDescriptionVersion = version;
          if (after.featureName && after.featureName !== item.before?.featureName) {
            const fid = await ensureFeature(tx, targetId, after.featureName, version, ++featureOrder);
            data.feature = { connect: { id: fid } };
            affectedFeatureIds.add(fid);
          }
        } else if (item.op === "mark_outdated") {
          data.status = CaseStatus.outdated;
        } else if (item.op === "deprecate") {
          data.status = CaseStatus.deprecated;
        }

        const row = await tx.testCase.update({ where: { id: existing.id }, data });
        await tx.testCaseVersion.create({
          data: {
            testCaseId: row.id, version: row.currentVersion,
            content: caseSnapshotRow(row) as Prisma.InputJsonObject,
            changeId: logId, createdBy: userId,
          },
        });
        affectedCaseIds.add(row.id);
        if (row.featureId) affectedFeatureIds.add(row.featureId);
      }
    }, { timeout: 120_000 });

    const decisionMap: Record<string, string> = {};
    for (const item of [...featureItems, ...caseItems]) {
      decisionMap[item.id] = item.unresolved
        ? "unresolved"
        : decisions.items?.[item.id] === true
          ? "accepted"
          : "rejected";
    }

    await this.prisma.$transaction([
      this.prisma.changeLog.create({
        data: {
          id: logId,
          proposalId: proposal.id,
          scope: proposal.scope,
          projectId: proposal.projectId,
          targetId: proposal.targetId,
          source: proposal.source,
          summary: proposal.summary,
          descriptionVersionAfter,
          affectedFeatureIds: [...affectedFeatureIds],
          affectedTestCaseIds: [...affectedCaseIds],
          decisions: { description: takeDescription, items: decisionMap } as Prisma.InputJsonObject,
          appliedById: userId,
        },
      }),
      this.prisma.changeProposal.update({
        where: { id: proposal.id },
        data: { state: ProposalState.applied, decidedById: userId, decidedAt: new Date() },
      }),
    ]);

    await this.audit.log("user", userId, "change.apply", proposal.id, {
      features: affectedFeatureIds.size, cases: affectedCaseIds.size, descriptionVersionAfter,
    });

    return {
      changeId: logId,
      descriptionVersionAfter,
      affectedFeatureIds: [...affectedFeatureIds],
      affectedTestCaseIds: [...affectedCaseIds],
      // Only these features need regenerating (§4.4 只針對受影響 feature 重生成).
      regenerableFeatureIds: [...affectedFeatureIds],
    };
  }

  /**
   * Second pass: ask for each changed case on its own. One request carrying the
   * whole test list *and* every rewritten case is both slower than the gateway in
   * front of the model allows and worse quality; a focused request per case is
   * neither. A case whose detail call fails is marked rather than half-applied.
   */
  private async fillCaseDetails(
    normalised: { descriptionAfter: string; caseChanges: CaseChangeItem[] },
    ctx: EntityContext,
    note: string,
  ) {
    const needsDetail = normalised.caseChanges.filter(
      (item) => !item.unresolved && (item.op === "add" || item.op === "modify"),
    );
    const description = normalised.descriptionAfter || ctx.description;

    for (const [index, item] of needsDetail.entries()) {
      if (index >= MAX_CASE_DETAILS) {
        item.unresolved = `這次一輪最多處理 ${MAX_CASE_DETAILS} 條案例的內容，這一條請套用後再分析一次。`;
        continue;
      }
      try {
        const res = await this.gateway.structured("generate", "test_case", {
          system: CASE_DETAIL_SYSTEM,
          messages: [
            {
              role: "user",
              content: caseDetailContext({
                entityName: ctx.name,
                description,
                note,
                featureRef: item.featureRef,
                reason: item.reason,
                before: item.before,
              }),
            },
          ],
          maxTokens: 2048,
        }, { context: { projectId: ctx.projectId, targetId: ctx.targetId } });
        const written = res.data.cases?.[0];
        if (!written) {
          item.unresolved = "模型沒有寫出這條案例的內容。";
          continue;
        }
        item.after = normaliseAfter(written, item.before, item.featureRef || written.feature_ref || null);
        if (item.op === "modify" && item.before && item.after) {
          item.diff = caseDiff(item.before, item.after);
          if (!item.diff) item.unresolved = "重寫後的內容和現況完全一樣，沒有東西可以套用。";
        }
      } catch (err) {
        // One case failing is not a reason to throw the whole proposal away.
        this.log.warn(`case detail failed for ${item.id}: ${(err as Error).message}`);
        item.unresolved = `產生這條案例的內容時失敗了：${(err as Error).message.slice(0, 200)}`;
      }
    }
  }

  // ---------- shaping ----------

  private shape(row: {
    id: string; scope: Scope; projectId: string | null; targetId: string | null;
    source: ChangeSource; state: ProposalState; summary: string;
    descriptionDiff: string; descriptionAfter: string;
    featureChanges: Prisma.JsonValue; testCaseChanges: Prisma.JsonValue;
    originNote: string | null; model: string | null; createdAt: Date; decidedAt: Date | null;
  }) {
    const featureChanges = (row.featureChanges as unknown as FeatureChangeItem[]) ?? [];
    const caseChanges = (row.testCaseChanges as unknown as CaseChangeItem[]) ?? [];
    return {
      id: row.id,
      scope: row.scope,
      projectId: row.projectId,
      targetId: row.targetId,
      source: row.source,
      state: row.state,
      summary: row.summary,
      descriptionDiff: row.descriptionDiff,
      descriptionAfter: row.descriptionAfter,
      hasDescriptionChange: !!row.descriptionAfter.trim(),
      featureChanges,
      caseChanges,
      counts: {
        features: featureChanges.length,
        cases: caseChanges.length,
        unresolved: [...featureChanges, ...caseChanges].filter((i) => i.unresolved).length,
      },
      originNote: row.originNote,
      model: row.model,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    };
  }

  /**
   * Turns raw model output into items that can be decided one by one: every item
   * gets a stable id, and every "before" is read from the database rather than
   * trusted from the model, so the diff shown is the one that will be applied.
   */
  private normalise(
    out: ProposalOutput,
    ctx: EntityContext,
    features: FeatureForPrompt[],
    cases: CaseForPrompt[],
    scope: Scope,
    proposedDescription?: string,
  ) {
    const featureById = new Map(features.map((f) => [f.id, f]));
    const caseById = new Map(cases.map((c) => [c.id, c]));

    const descriptionAfter = (proposedDescription ?? out.description_after ?? "").trim();
    const descriptionChanged = !!descriptionAfter && descriptionAfter !== ctx.description.trim();
    // Computed from the two texts we hold, not from the model's rendering of them.
    const descriptionDiff = descriptionChanged ? lineDiff(ctx.description, descriptionAfter) : "";

    const featureChanges: FeatureChangeItem[] = [];
    const caseChanges: CaseChangeItem[] = [];
    if (scope === Scope.target) {
      let n = 0;
      for (const fc of out.feature_changes ?? []) {
        const id = `f${++n}`;
        const before = fc.feature_id ? featureById.get(fc.feature_id) : undefined;
        const item: FeatureChangeItem = {
          id,
          op: fc.op,
          featureId: before?.id ?? null,
          name: (fc.name ?? before?.name ?? "").trim(),
          description: (fc.description ?? before?.description ?? "").trim(),
          before: before ? { name: before.name, description: before.description } : null,
          reason: (fc.reason ?? "").trim(),
        };
        if (fc.op === "add" && !item.name) item.unresolved = "模型沒有給新功能的名稱。";
        if (fc.op !== "add" && !before) item.unresolved = "找不到模型指定的功能，可能已經被刪掉了。";
        featureChanges.push(item);
      }

      let m = 0;
      for (const cc of out.test_case_changes ?? []) {
        const id = `c${++m}`;
        const before = cc.case_id ? caseById.get(cc.case_id) : undefined;
        const beforeSnapshot: CaseSnapshot | null = before
          ? {
              title: before.title, precondition: before.precondition, steps: before.steps,
              expected: before.expected, priority: before.priority, type: before.type,
              featureName: before.featureName, status: before.status,
            }
          : null;
        // The impact pass names the case and says why; the body is written in a
        // second, focused call, so `after` is deliberately empty here.
        const featureRef = (cc.feature_ref ?? "").trim() || before?.featureName || "";
        const item: CaseChangeItem = {
          id,
          op: cc.op,
          caseId: before?.id ?? null,
          featureRef,
          before: beforeSnapshot,
          after: null,
          diff: "",
          reason: (cc.reason ?? "").trim(),
        };
        if (cc.op === "add") {
          if (!featureRef && !cc.reason) item.unresolved = "新增的案例沒有說明要驗什麼，也沒說屬於哪個功能。";
        } else if (!before) {
          item.unresolved = "找不到模型指定的測試案例，可能已經被刪掉了。";
        }
        caseChanges.push(item);
      }
    }

    return { descriptionDiff, descriptionAfter: descriptionChanged ? descriptionAfter : "", featureChanges, caseChanges };
  }

  // ---------- context ----------

  private async inventory(ctx: EntityContext): Promise<{ features: FeatureForPrompt[]; cases: CaseForPrompt[] }> {
    if (!ctx.targetId) return { features: [], cases: [] };
    const [features, cases] = await Promise.all([
      this.prisma.feature.findMany({
        where: { targetId: ctx.targetId },
        orderBy: { order: "asc" },
        include: { _count: { select: { testCases: true } } },
      }),
      this.prisma.testCase.findMany({
        where: { targetId: ctx.targetId, status: { not: CaseStatus.deprecated } },
        orderBy: { order: "asc" },
        include: { feature: { select: { name: true } } },
      }),
    ]);
    return {
      features: features.map((f) => ({
        id: f.id, name: f.name, description: f.description, status: f.status, caseCount: f._count.testCases,
      })),
      cases: cases.map((c) => ({
        id: c.id,
        featureId: c.featureId,
        featureName: c.feature?.name ?? null,
        title: c.title,
        precondition: c.precondition,
        steps: (c.steps as string[]) ?? [],
        expected: c.expected,
        priority: c.priority,
        type: c.type,
        status: c.status,
      })),
    };
  }

  private async resolve(scope: Scope, id: string, userId: string, required: Role): Promise<EntityContext> {
    if (scope === Scope.project) {
      const role = await this.perms.requireProject(id, userId, required);
      const p = await this.prisma.project.findUnique({ where: { id }, select: { name: true, description: true } });
      if (!p) throw new NotFoundException("Project 不存在");
      return { scope, projectId: id, targetId: null, name: p.name, description: p.description, role, running: false };
    }
    const { role, projectId } = await this.perms.requireTarget(id, userId, required);
    const t = await this.prisma.qaTarget.findUnique({
      where: { id },
      select: { name: true, description: true, kind: true, status: true },
    });
    if (!t) throw new NotFoundException("Target 不存在");
    return {
      scope, projectId, targetId: id, name: t.name, description: t.description,
      kind: t.kind, role, running: t.status === "running",
    };
  }

  private async load(proposalId: string) {
    const row = await this.prisma.changeProposal.findUnique({ where: { id: proposalId } });
    if (!row) throw new NotFoundException("變更提案不存在");
    return row;
  }

  private async requireOn(proposal: { scope: Scope; projectId: string | null; targetId: string | null }, userId: string, required: Role) {
    if (proposal.targetId) {
      await this.perms.requireTarget(proposal.targetId, userId, required);
      return;
    }
    if (!proposal.projectId) throw new ForbiddenException("提案沒有對應的範圍");
    await this.perms.requireProject(proposal.projectId, userId, required);
  }
}

interface EntityContext {
  scope: Scope;
  projectId: string;
  targetId: string | null;
  name: string;
  description: string;
  kind?: string;
  role: Role;
  running: boolean;
}

/** Fills the gaps in what the model gave with the current values, so nothing is silently blanked. */
function normaliseAfter(
  raw: unknown,
  before: CaseSnapshot | null,
  featureName: string | null,
): CaseSnapshot | null {
  if (!raw || typeof raw !== "object") return before ? { ...before, featureName: featureName ?? before.featureName } : null;
  const obj = raw as Record<string, unknown>;
  const steps = Array.isArray(obj.steps)
    ? obj.steps.map((s) => String(s).trim()).filter(Boolean)
    : before?.steps ?? [];
  const priority = typeof obj.priority === "string" && PRIORITIES.has(obj.priority) ? obj.priority : before?.priority ?? "P2";
  const type = typeof obj.type === "string" && CASE_TYPES.has(obj.type) ? obj.type : before?.type ?? "happy";
  return {
    title: str(obj.title) ?? before?.title ?? "",
    precondition: str(obj.precondition) ?? before?.precondition ?? "",
    steps,
    expected: str(obj.expected) ?? before?.expected ?? "",
    priority,
    type,
    featureName: featureName ?? before?.featureName ?? null,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}

function sourceToDescriptionSource(source: ChangeSource): DescriptionSource {
  if (source === ChangeSource.discussion) return DescriptionSource.discussion;
  if (source === ChangeSource.handoff) return DescriptionSource.handoff;
  return DescriptionSource.manual;
}

/** Same shape the generation pipeline stores, so version history is uniform. */
function caseSnapshotRow(c: {
  title: string; precondition: string; steps: Prisma.JsonValue; expected: string;
  priority: string; type: string; status: string; featureId: string | null;
}) {
  return {
    title: c.title, precondition: c.precondition, steps: c.steps, expected: c.expected,
    priority: c.priority, type: c.type, status: c.status, featureId: c.featureId,
  };
}

type Tx = Prisma.TransactionClient;

async function ensureFeature(tx: Tx, targetId: string, name: string, version: number, order: number): Promise<string> {
  const row = await tx.feature.upsert({
    where: { targetId_name: { targetId, name } },
    create: { targetId, name, basedOnDescriptionVersion: version, order },
    update: {},
  });
  return row.id;
}

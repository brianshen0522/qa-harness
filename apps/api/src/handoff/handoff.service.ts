import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  DescriptionSource, HandoffApplyMode, Prisma, Role, Scope, TargetKind,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { ProjectsService } from "../projects/projects.service";
import { TargetsService } from "../targets/targets.service";
import { AuditService } from "../audit/audit.service";
import { HARNESS_VERSION } from "../config/version";
import {
  buildHandoffPrompt, parseHandoff, renderDescription, sectionsFor,
  type ParsedHandoff,
} from "./handoff-format";

interface Ctx {
  scope: Scope;
  projectId: string;
  targetId?: string;
  kind?: TargetKind;
  projectName: string;
  targetName?: string;
  description: string;
}

@Injectable()
export class HandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly projects: ProjectsService,
    private readonly targets: TargetsService,
    private readonly audit: AuditService,
  ) {}

  private async ctxForProject(projectId: string, userId: string, required: Role): Promise<Ctx> {
    await this.perms.requireProject(projectId, userId, required);
    const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true, description: true } });
    if (!p) throw new NotFoundException("Project not found");
    return { scope: Scope.project, projectId, projectName: p.name, description: p.description };
  }

  private async ctxForTarget(targetId: string, userId: string, required: Role): Promise<Ctx> {
    const { projectId } = await this.perms.requireTarget(targetId, userId, required);
    const t = await this.prisma.qaTarget.findUnique({
      where: { id: targetId },
      select: { name: true, description: true, kind: true, project: { select: { name: true } } },
    });
    if (!t) throw new NotFoundException("Target not found");
    return {
      scope: Scope.target, projectId, targetId, kind: t.kind,
      projectName: t.project.name, targetName: t.name, description: t.description,
    };
  }

  private ctx(scope: Scope, id: string, userId: string, required: Role): Promise<Ctx> {
    return scope === Scope.project
      ? this.ctxForProject(id, userId, required)
      : this.ctxForTarget(id, userId, required);
  }

  /** Step 1 of §4.2: the prompt the user pastes into their coding agent. */
  async prompt(scope: Scope, id: string, userId: string) {
    const c = await this.ctx(scope, id, userId, Role.viewer);
    return {
      scope: c.scope,
      kind: c.kind ?? null,
      harnessVersion: HARNESS_VERSION,
      sections: sectionsFor(c.scope, c.kind).map((s) => ({ title: s.title, ask: s.ask })),
      prompt: buildHandoffPrompt({
        scope: c.scope,
        kind: c.kind,
        projectName: c.projectName,
        targetName: c.targetName,
        existingDescription: c.description,
      }),
    };
  }

  /** Step 3 of §4.2: validate and preview without writing anything. */
  async preview(scope: Scope, id: string, userId: string, content: string) {
    const c = await this.ctx(scope, id, userId, Role.editor);
    const parsed = parseHandoff(content, c.scope, c.kind);
    return {
      ...this.publicParsed(parsed),
      renderedDescription: renderDescription(parsed, c.scope, c.kind),
      currentDescription: c.description,
      /** A document we cannot structure at all can still be kept as reference material. */
      recommendedMode: parsed.unparsable ? HandoffApplyMode.attachment : HandoffApplyMode.overwrite,
    };
  }

  /** Step 4–5 of §4.2: apply, writing a new description version and keeping the original. */
  async apply(scope: Scope, id: string, userId: string, content: string, mode: HandoffApplyMode) {
    const c = await this.ctx(scope, id, userId, Role.editor);
    const parsed = parseHandoff(content, c.scope, c.kind);
    if (parsed.unparsable && mode !== HandoffApplyMode.attachment) {
      throw new BadRequestException("這份文件無法解析出任何已知 section，請改用「當作附件」匯入。");
    }

    const rendered = renderDescription(parsed, c.scope, c.kind);
    let appliedVersion: number | null = null;

    if (mode !== HandoffApplyMode.attachment) {
      const next =
        mode === HandoffApplyMode.overwrite
          ? rendered
          : [c.description.trim(), rendered.trim()].filter(Boolean).join("\n\n---\n\n");
      if (!next.trim()) throw new BadRequestException("解析結果是空的，沒有可寫入的描述。");
      const saved =
        c.scope === Scope.project
          ? await this.projects.updateDescription(c.projectId, userId, next, DescriptionSource.handoff)
          : await this.targets.updateDescription(c.targetId!, userId, next, DescriptionSource.handoff);
      appliedVersion = saved.descriptionVersion;
    } else {
      // Keep the raw document as reference material for the discussion area.
      await this.prisma.projectAttachment.create({
        data: {
          projectId: c.projectId,
          sourceType: "handoff",
          filename: `handoff-${c.scope}-${new Date().toISOString().slice(0, 10)}.md`,
          mime: "text/markdown",
          textContent: content.slice(0, 200_000),
          byteSize: Buffer.byteLength(content),
          uploadedById: userId,
        },
      });
    }

    const doc = await this.prisma.handoffDocument.create({
      data: {
        scope: c.scope,
        projectId: c.scope === Scope.project ? c.projectId : null,
        targetId: c.scope === Scope.target ? c.targetId! : null,
        rawContent: content,
        parsed: this.publicParsed(parsed) as unknown as Prisma.InputJsonObject,
        harnessVersion: parsed.frontMatter.harness_version || HARNESS_VERSION,
        applyMode: mode,
        importedById: userId,
        appliedToDescriptionVersion: appliedVersion,
      },
    });

    await this.audit.log("user", userId, "handoff.import", c.targetId ?? c.projectId, {
      scope: c.scope, mode, version: appliedVersion, secrets: parsed.detectedSecrets.length,
    });

    return {
      document: { id: doc.id, importedAt: doc.importedAt, applyMode: doc.applyMode, appliedToDescriptionVersion: appliedVersion },
      ...this.publicParsed(parsed),
    };
  }

  async list(scope: Scope, id: string, userId: string) {
    const c = await this.ctx(scope, id, userId, Role.viewer);
    return this.prisma.handoffDocument.findMany({
      where: c.scope === Scope.project ? { projectId: c.projectId, scope: Scope.project } : { targetId: c.targetId },
      orderBy: { importedAt: "desc" },
      select: {
        id: true, scope: true, harnessVersion: true, applyMode: true,
        importedAt: true, importedById: true, appliedToDescriptionVersion: true,
      },
    });
  }

  async getDocument(documentId: string, userId: string) {
    const doc = await this.prisma.handoffDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException("交接文件不存在");
    if (doc.scope === Scope.project) await this.perms.requireProject(doc.projectId!, userId, Role.viewer);
    else await this.perms.requireTarget(doc.targetId!, userId, Role.viewer);
    return doc;
  }

  /** Secret *values* are never echoed back — only which key and which line. */
  private publicParsed(p: ParsedHandoff) {
    return {
      frontMatter: p.frontMatter,
      sections: p.sections,
      unknownSections: p.unknownSections,
      suggestedTestCases: p.suggestedTestCases,
      detectedSecrets: p.detectedSecrets,
      missingSections: p.missingSections,
      unparsable: p.unparsable,
      warnings: p.warnings,
    };
  }
}

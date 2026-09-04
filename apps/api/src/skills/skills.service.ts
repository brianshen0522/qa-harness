import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Role, SkillScope } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { AuditService } from "../audit/audit.service";

export interface SkillInput {
  name: string;
  content: string;
  enabled?: boolean;
}

/**
 * Skills (§3.2 / §4.8): reusable house rules the LLM should always follow. A
 * global skill applies everywhere; a project skill only to that project. They
 * are folded into generation and execution prompts so a team does not have to
 * restate "our dates are DD/MM/YYYY" in every target description.
 */
@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  listGlobal() {
    return this.prisma.skill.findMany({ where: { scope: SkillScope.global }, orderBy: { order: "asc" } });
  }

  async createGlobal(adminId: string, input: SkillInput) {
    this.validate(input);
    const order = ((await this.prisma.skill.aggregate({ where: { scope: SkillScope.global }, _max: { order: true } }))._max.order ?? -1) + 1;
    const row = await this.prisma.skill.create({
      data: { scope: SkillScope.global, name: input.name.trim(), content: input.content, enabled: input.enabled ?? true, order },
    });
    await this.audit.log("admin", adminId, "skill.create", row.id, { scope: "global", name: row.name });
    return row;
  }

  async updateGlobal(id: string, adminId: string, input: Partial<SkillInput>) {
    await this.getGlobal(id);
    const row = await this.prisma.skill.update({ where: { id }, data: this.patch(input) });
    await this.audit.log("admin", adminId, "skill.update", id, { fields: Object.keys(input) });
    return row;
  }

  async removeGlobal(id: string, adminId: string) {
    await this.getGlobal(id);
    await this.prisma.skill.delete({ where: { id } });
    await this.audit.log("admin", adminId, "skill.delete", id, {});
    return { ok: true };
  }

  async listProject(projectId: string, userId: string) {
    await this.perms.requireProject(projectId, userId, Role.viewer);
    return this.prisma.skill.findMany({ where: { scope: SkillScope.project, projectId }, orderBy: { order: "asc" } });
  }

  async createProject(projectId: string, userId: string, input: SkillInput) {
    await this.perms.requireProject(projectId, userId, Role.editor);
    this.validate(input);
    const order = ((await this.prisma.skill.aggregate({ where: { scope: SkillScope.project, projectId }, _max: { order: true } }))._max.order ?? -1) + 1;
    const row = await this.prisma.skill.create({
      data: { scope: SkillScope.project, projectId, name: input.name.trim(), content: input.content, enabled: input.enabled ?? true, order },
    });
    await this.audit.log("user", userId, "skill.create", row.id, { scope: "project", projectId, name: row.name });
    return row;
  }

  async updateProject(id: string, userId: string, input: Partial<SkillInput>) {
    const skill = await this.getProject(id);
    await this.perms.requireProject(skill.projectId!, userId, Role.editor);
    return this.prisma.skill.update({ where: { id }, data: this.patch(input) });
  }

  async removeProject(id: string, userId: string) {
    const skill = await this.getProject(id);
    await this.perms.requireProject(skill.projectId!, userId, Role.editor);
    await this.prisma.skill.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * The skills block for a project: enabled global skills then the project's own,
   * as a markdown section for the system prompt. Empty string when there is none.
   */
  async promptBlock(projectId: string): Promise<string> {
    const skills = await this.prisma.skill.findMany({
      where: { enabled: true, OR: [{ scope: SkillScope.global }, { scope: SkillScope.project, projectId }] },
      orderBy: [{ scope: "asc" }, { order: "asc" }],
    });
    if (!skills.length) return "";
    const body = skills.map((s) => `### ${s.name}\n${s.content.trim()}`).join("\n\n");
    return `## 團隊規則（Skills）\n以下是這個團隊/專案一律要遵守的規則，請在判斷與操作時一併考慮：\n\n${body}`;
  }

  async projectIdForTarget(targetId: string): Promise<string> {
    const t = await this.prisma.qaTarget.findUniqueOrThrow({ where: { id: targetId }, select: { projectId: true } });
    return t.projectId;
  }

  private patch(input: Partial<SkillInput>): Prisma.SkillUpdateInput {
    return {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
  }

  private validate(input: SkillInput) {
    if (!input.name?.trim()) throw new BadRequestException("Skill 名稱不能是空的");
    if (input.content !== undefined && input.content.length > 20_000) throw new BadRequestException("Skill 內容太長（上限 20000 字）");
  }

  private async getGlobal(id: string) {
    const row = await this.prisma.skill.findUnique({ where: { id } });
    if (!row || row.scope !== SkillScope.global) throw new NotFoundException("Skill 不存在");
    return row;
  }

  private async getProject(id: string) {
    const row = await this.prisma.skill.findUnique({ where: { id } });
    if (!row || row.scope !== SkillScope.project || !row.projectId) throw new NotFoundException("Skill 不存在");
    return row;
  }
}

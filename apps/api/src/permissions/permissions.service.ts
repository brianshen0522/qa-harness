import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { atLeast, effectiveTargetRole } from "./roles";

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async projectRole(projectId: string, userId: string): Promise<Role | null> {
    const m = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    return m?.role ?? null;
  }

  /** Effective role on a target (rule 5), or null if no access. Throws 404 if target missing. */
  async targetRole(targetId: string, userId: string): Promise<{ role: Role | null; projectId: string }> {
    const target = await this.prisma.qaTarget.findUnique({ where: { id: targetId }, select: { projectId: true } });
    if (!target) throw new NotFoundException("Target not found");
    const [projectRole, override] = await Promise.all([
      this.projectRole(target.projectId, userId),
      this.prisma.targetMember.findUnique({ where: { targetId_userId: { targetId, userId } } }),
    ]);
    return { role: effectiveTargetRole(projectRole, override?.role ?? null), projectId: target.projectId };
  }

  /** Require at least `required` on a project. 404 if not a member (don't leak existence). */
  async requireProject(projectId: string, userId: string, required: Role): Promise<Role> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException("Project not found");
    const role = await this.projectRole(projectId, userId);
    if (!role) throw new NotFoundException("Project not found");
    if (!atLeast(role, required)) throw new ForbiddenException(`Requires ${required} role on project`);
    return role;
  }

  /** Require at least `required` effective role on a target. */
  async requireTarget(targetId: string, userId: string, required: Role): Promise<{ role: Role; projectId: string }> {
    const { role, projectId } = await this.targetRole(targetId, userId);
    if (!role) throw new NotFoundException("Target not found");
    if (!atLeast(role, required)) throw new ForbiddenException(`Requires ${required} role on target`);
    return { role, projectId };
  }
}

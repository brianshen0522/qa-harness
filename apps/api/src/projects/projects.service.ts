import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DescriptionSource, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { TeamsService } from "../teams/teams.service";
import { AuditService } from "../audit/audit.service";

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly teams: TeamsService,
    private readonly audit: AuditService,
  ) {}

  listForUser(userId: string) {
    return this.prisma.project.findMany({
      where: { members: { some: { userId } } },
      include: {
        team: { select: { id: true, name: true } },
        members: { where: { userId }, select: { role: true } },
        _count: { select: { targets: true, members: true } },
      },
      orderBy: { updatedAt: "desc" },
    }).then((rows) => rows.map(({ members, ...p }) => ({ ...p, myRole: members[0]?.role ?? null })));
  }

  async create(userId: string, input: { teamId: string; name: string; description?: string }) {
    await this.teams.requireMember(input.teamId, userId);
    const project = await this.prisma.project.create({
      data: {
        teamId: input.teamId,
        name: input.name,
        description: input.description ?? "",
        descriptionVersion: input.description ? 1 : 0,
        createdById: userId,
        members: { create: { userId, role: Role.owner } },
        ...(input.description
          ? { descriptionVersions: { create: { version: 1, content: input.description, source: DescriptionSource.manual, createdBy: userId } } }
          : {}),
      },
    });
    await this.audit.log("user", userId, "project.create", project.id);
    return project;
  }

  async get(projectId: string, userId: string) {
    const role = await this.perms.requireProject(projectId, userId, Role.viewer);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        team: { select: { id: true, name: true } },
        targets: { select: { id: true, name: true, kind: true, status: true, updatedAt: true }, orderBy: { createdAt: "asc" } },
        _count: { select: { members: true } },
      },
    });
    if (!project) throw new NotFoundException();
    return { ...project, myRole: role };
  }

  async update(projectId: string, userId: string, input: { name?: string }) {
    await this.perms.requireProject(projectId, userId, Role.owner);
    const project = await this.prisma.project.update({ where: { id: projectId }, data: input });
    await this.audit.log("user", userId, "project.update", projectId, input);
    return project;
  }

  async remove(projectId: string, userId: string) {
    await this.perms.requireProject(projectId, userId, Role.owner);
    await this.prisma.project.delete({ where: { id: projectId } });
    await this.audit.log("user", userId, "project.delete", projectId);
    return { ok: true };
  }

  /** Write a new description version (editor+). */
  async updateDescription(projectId: string, userId: string, content: string, source: DescriptionSource = "manual") {
    await this.perms.requireProject(projectId, userId, Role.editor);
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { descriptionVersion: true } });
      const version = current.descriptionVersion + 1;
      await tx.projectDescriptionVersion.create({ data: { projectId, version, content, source, createdBy: userId } });
      return tx.project.update({ where: { id: projectId }, data: { description: content, descriptionVersion: version } });
    });
  }

  async descriptionVersions(projectId: string, userId: string) {
    await this.perms.requireProject(projectId, userId, Role.viewer);
    return this.prisma.projectDescriptionVersion.findMany({ where: { projectId }, orderBy: { version: "desc" } });
  }

  // ----- members -----

  async members(projectId: string, userId: string) {
    await this.perms.requireProject(projectId, userId, Role.viewer);
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, email: true, name: true, status: true } } },
      orderBy: { user: { name: "asc" } },
    });
  }

  async addMember(projectId: string, actorId: string, email: string, role: Role) {
    await this.perms.requireProject(projectId, actorId, Role.owner);
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) throw new NotFoundException("No user with that email. Ask an admin to invite them first.");
    const existing = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: user.id } } });
    if (existing) throw new BadRequestException("User is already a member");
    const member = await this.prisma.projectMember.create({
      data: { projectId, userId: user.id, role },
      include: { user: { select: { id: true, email: true, name: true, status: true } } },
    });
    await this.audit.log("user", actorId, "project.member.add", projectId, { userId: user.id, role });
    return member;
  }

  async updateMember(projectId: string, actorId: string, userId: string, role: Role) {
    await this.perms.requireProject(projectId, actorId, Role.owner);
    await this.assertNotLastOwner(projectId, userId, role);
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.projectMember.update({ where: { projectId_userId: { projectId, userId } }, data: { role } });
      // Rule 2/3: overrides that are now <= the project role are redundant; owners cannot have overrides.
      await tx.targetMember.deleteMany({
        where: {
          userId,
          target: { projectId },
          ...(role === Role.owner ? {} : role === Role.editor ? { role: { in: [Role.viewer, Role.editor] } } : { role: Role.viewer }),
        },
      });
      await this.audit.log("user", actorId, "project.member.update", projectId, { userId, role });
      return member;
    });
  }

  /** Rule 6: removing a member deletes all their target overrides in this project. */
  async removeMember(projectId: string, actorId: string, userId: string) {
    await this.perms.requireProject(projectId, actorId, Role.owner);
    await this.assertNotLastOwner(projectId, userId, null);
    await this.prisma.$transaction([
      this.prisma.targetMember.deleteMany({ where: { userId, target: { projectId } } }),
      this.prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId } } }),
    ]);
    await this.audit.log("user", actorId, "project.member.remove", projectId, { userId });
    return { ok: true };
  }

  private async assertNotLastOwner(projectId: string, userId: string, newRole: Role | null) {
    if (newRole === Role.owner) return;
    const target = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (!target) throw new NotFoundException("Member not found");
    if (target.role !== Role.owner) return;
    const owners = await this.prisma.projectMember.count({ where: { projectId, role: Role.owner } });
    if (owners <= 1) throw new BadRequestException("Project must keep at least one owner");
  }
}

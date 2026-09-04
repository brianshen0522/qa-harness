import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string) {
    return this.prisma.team.findMany({
      where: { members: { some: { userId } } },
      include: { _count: { select: { members: true, projects: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  async create(userId: string, name: string) {
    return this.prisma.team.create({
      data: { name, members: { create: { userId } } },
    });
  }

  async requireMember(teamId: string, userId: string) {
    const m = await this.prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
    if (!m) throw new NotFoundException("Team not found");
    return m;
  }

  async members(teamId: string, userId: string) {
    await this.requireMember(teamId, userId);
    return this.prisma.teamMember.findMany({
      where: { teamId },
      include: { user: { select: { id: true, email: true, name: true, status: true } } },
    });
  }

  async addMember(teamId: string, actorId: string, email: string) {
    await this.requireMember(teamId, actorId);
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) throw new NotFoundException("No user with that email. Ask an admin to invite them first.");
    await this.prisma.teamMember.upsert({
      where: { teamId_userId: { teamId, userId: user.id } },
      create: { teamId, userId: user.id },
      update: {},
    });
    return { id: user.id, email: user.email, name: user.name };
  }

  async removeMember(teamId: string, actorId: string, userId: string) {
    await this.requireMember(teamId, actorId);
    const count = await this.prisma.teamMember.count({ where: { teamId } });
    if (count <= 1) throw new ForbiddenException("Cannot remove the last team member");
    await this.prisma.teamMember.delete({ where: { teamId_userId: { teamId, userId } } });
    return { ok: true };
  }
}

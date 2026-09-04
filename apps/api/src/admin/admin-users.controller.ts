import { BadRequestException, Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { IsEmail, IsEnum, IsOptional, IsString } from "class-validator";
import { UserStatus } from "@prisma/client";
import { AdminAuthGuard } from "../auth/guards/admin-auth.guard";
import { CurrentAdmin } from "../common/decorators";
import type { AdminPrincipal } from "../common/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

class InviteUserDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() name?: string;
}
class UpdateUserDto {
  @IsEnum(UserStatus) status!: UserStatus;
}

@Controller("admin/users")
@UseGuards(AdminAuthGuard)
export class AdminUsersController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        teamMemberships: { include: { team: { select: { id: true, name: true } } } },
        projectMemberships: { include: { project: { select: { id: true, name: true } } } },
      },
    }).then((users) =>
      users.map((u) => ({
        id: u.id, email: u.email, name: u.name, authProvider: u.authProvider, status: u.status, createdAt: u.createdAt,
        teams: u.teamMemberships.map((m) => m.team),
        projects: u.projectMemberships.map((m) => ({ ...m.project, role: m.role })),
      })),
    );
  }

  /** Pre-create a user so they can be added to teams/projects before their first OAuth login. */
  @Post()
  async invite(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: InviteUserDto) {
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException("User already exists");
    const user = await this.prisma.user.create({ data: { email, name: dto.name ?? email, authProvider: "invited" } });
    await this.audit.log("admin", admin.id, "user.invite", user.id, { email });
    return user;
  }

  @Patch(":id")
  async update(@CurrentAdmin() admin: AdminPrincipal, @Param("id") id: string, @Body() dto: UpdateUserDto) {
    const user = await this.prisma.user.update({ where: { id }, data: { status: dto.status } });
    await this.audit.log("admin", admin.id, "user.status", id, { status: dto.status });
    return user;
  }
}

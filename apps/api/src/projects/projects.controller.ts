import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { ProjectsService } from "./projects.service";
import { AddProjectMemberDto, CreateProjectDto, UpdateDescriptionDto, UpdateProjectDto, UpdateProjectMemberDto } from "./dto";

@Controller("projects")
@UseGuards(UserAuthGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@CurrentUser() user: UserPrincipal) {
    return this.projects.listForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: UserPrincipal, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.id, dto);
  }

  @Get(":id")
  get(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.projects.get(id, user.id);
  }

  @Patch(":id")
  update(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(id, user.id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.projects.remove(id, user.id);
  }

  @Put(":id/description")
  updateDescription(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: UpdateDescriptionDto) {
    return this.projects.updateDescription(id, user.id, dto.content, dto.source);
  }

  @Get(":id/description/versions")
  descriptionVersions(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.projects.descriptionVersions(id, user.id);
  }

  @Get(":id/members")
  members(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.projects.members(id, user.id);
  }

  @Post(":id/members")
  addMember(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: AddProjectMemberDto) {
    return this.projects.addMember(id, user.id, dto.email, dto.role);
  }

  @Patch(":id/members/:userId")
  updateMember(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Param("userId") userId: string, @Body() dto: UpdateProjectMemberDto) {
    return this.projects.updateMember(id, user.id, userId, dto.role);
  }

  @Delete(":id/members/:userId")
  removeMember(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Param("userId") userId: string) {
    return this.projects.removeMember(id, user.id, userId);
  }
}

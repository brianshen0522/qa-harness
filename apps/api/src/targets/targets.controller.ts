import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { TargetsService } from "./targets.service";
import { CreateTargetDto, SetCredentialDto, SetTargetMemberDto, UpdateTargetDescriptionDto, UpdateTargetDto } from "./dto";

@Controller()
@UseGuards(UserAuthGuard)
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  @Get("projects/:projectId/targets")
  list(@CurrentUser() user: UserPrincipal, @Param("projectId") projectId: string) {
    return this.targets.list(projectId, user.id);
  }

  @Post("projects/:projectId/targets")
  create(@CurrentUser() user: UserPrincipal, @Param("projectId") projectId: string, @Body() dto: CreateTargetDto) {
    return this.targets.create(projectId, user.id, dto);
  }

  @Get("targets/:id")
  get(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.targets.get(id, user.id);
  }

  @Patch("targets/:id")
  update(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: UpdateTargetDto) {
    return this.targets.update(id, user.id, dto);
  }

  @Delete("targets/:id")
  remove(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.targets.remove(id, user.id);
  }

  @Put("targets/:id/description")
  updateDescription(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: UpdateTargetDescriptionDto) {
    return this.targets.updateDescription(id, user.id, dto.content, dto.source);
  }

  @Put("targets/:id/credentials")
  setCredential(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: SetCredentialDto) {
    return this.targets.setCredential(id, user.id, dto.key, dto.value);
  }

  @Delete("targets/:id/credentials/:key")
  deleteCredential(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Param("key") key: string) {
    return this.targets.deleteCredential(id, user.id, key);
  }

  @Get("targets/:id/members")
  members(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.targets.members(id, user.id);
  }

  @Put("targets/:id/members/:userId")
  setMember(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Param("userId") userId: string, @Body() dto: SetTargetMemberDto) {
    return this.targets.setMember(id, user.id, userId, dto.role);
  }

  @Delete("targets/:id/members/:userId")
  removeMember(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Param("userId") userId: string) {
    return this.targets.removeMember(id, user.id, userId);
  }
}

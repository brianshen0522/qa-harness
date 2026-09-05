import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { AdminGuard } from "../auth/guards/admin.guard";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentAdmin, CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { SkillsService, type SkillInput } from "./skills.service";

class SkillDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MaxLength(20_000) content!: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class SkillPatchDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(20_000) content?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller("admin/skills")
@UseGuards(AdminGuard)
export class AdminSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  list() {
    return this.skills.listGlobal();
  }

  @Post()
  create(@CurrentAdmin() admin: UserPrincipal, @Body() dto: SkillDto) {
    return this.skills.createGlobal(admin.id, dto as SkillInput);
  }

  @Patch(":id")
  update(@CurrentAdmin() admin: UserPrincipal, @Param("id") id: string, @Body() dto: SkillPatchDto) {
    return this.skills.updateGlobal(id, admin.id, dto);
  }

  @Delete(":id")
  remove(@CurrentAdmin() admin: UserPrincipal, @Param("id") id: string) {
    return this.skills.removeGlobal(id, admin.id);
  }
}

@Controller()
@UseGuards(UserAuthGuard)
export class ProjectSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get("projects/:id/skills")
  list(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.skills.listProject(id, user.id);
  }

  @Post("projects/:id/skills")
  create(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: SkillDto) {
    return this.skills.createProject(id, user.id, dto as SkillInput);
  }

  @Patch("skills/:id")
  update(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: SkillPatchDto) {
    return this.skills.updateProject(id, user.id, dto);
  }

  @Delete("skills/:id")
  remove(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.skills.removeProject(id, user.id);
  }
}

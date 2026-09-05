import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { AdminAuthGuard } from "../auth/guards/admin-auth.guard";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentAdmin, CurrentUser } from "../common/decorators";
import type { AdminPrincipal, UserPrincipal } from "../common/types";
import { McpService, type McpInput } from "./mcp.service";

class McpDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsString() @MaxLength(2000) url!: string;
  @IsOptional() @IsString() @MaxLength(4000) auth?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class McpPatchDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) url?: string;
  @IsOptional() @IsString() @MaxLength(4000) auth?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller("admin/mcp")
@UseGuards(AdminAuthGuard)
export class AdminMcpController {
  constructor(private readonly mcp: McpService) {}

  @Get() list() { return this.mcp.listGlobal(); }
  @Post() create(@CurrentAdmin() a: AdminPrincipal, @Body() dto: McpDto) { return this.mcp.createGlobal(a.id, dto as McpInput); }
  @Patch(":id") update(@CurrentAdmin() a: AdminPrincipal, @Param("id") id: string, @Body() dto: McpPatchDto) { return this.mcp.updateGlobal(id, a.id, dto); }
  @Delete(":id") remove(@CurrentAdmin() a: AdminPrincipal, @Param("id") id: string) { return this.mcp.removeGlobal(id, a.id); }
  @Post(":id/test") test(@Param("id") id: string) { return this.mcp.testGlobal(id); }
}

@Controller()
@UseGuards(UserAuthGuard)
export class ProjectMcpController {
  constructor(private readonly mcp: McpService) {}

  @Get("projects/:id/mcp") list(@CurrentUser() u: UserPrincipal, @Param("id") id: string) { return this.mcp.listProject(id, u.id); }
  @Post("projects/:id/mcp") create(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Body() dto: McpDto) { return this.mcp.createProject(id, u.id, dto as McpInput); }
  @Patch("mcp/:id") update(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Body() dto: McpPatchDto) { return this.mcp.updateProject(id, u.id, dto); }
  @Delete("mcp/:id") remove(@CurrentUser() u: UserPrincipal, @Param("id") id: string) { return this.mcp.removeProject(id, u.id); }
  @Post("mcp/:id/test") test(@CurrentUser() u: UserPrincipal, @Param("id") id: string) { return this.mcp.testProject(id, u.id); }
}

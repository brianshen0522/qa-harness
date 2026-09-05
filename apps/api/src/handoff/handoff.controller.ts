import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { IsEnum, IsString, MaxLength, MinLength } from "class-validator";
import { HandoffApplyMode, Scope } from "@prisma/client";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { HandoffService } from "./handoff.service";

class HandoffContentDto {
  @IsString() @MinLength(1) @MaxLength(500_000) content!: string;
}
class HandoffApplyDto extends HandoffContentDto {
  @IsEnum(HandoffApplyMode) mode!: HandoffApplyMode;
}

@Controller()
@UseGuards(UserAuthGuard)
export class HandoffController {
  constructor(private readonly handoff: HandoffService) {}

  @Get("projects/:id/handoff/prompt")
  projectPrompt(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Query("incremental") incremental?: string) {
    return this.handoff.prompt(Scope.project, id, u.id, incremental === "true");
  }

  @Post("projects/:id/handoff/preview")
  projectPreview(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Body() dto: HandoffContentDto) {
    return this.handoff.preview(Scope.project, id, u.id, dto.content);
  }

  @Post("projects/:id/handoff/import")
  projectImport(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Body() dto: HandoffApplyDto) {
    return this.handoff.apply(Scope.project, id, u.id, dto.content, dto.mode);
  }

  @Post("projects/:id/handoff/analyze-changes")
  projectAnalyze(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Body() dto: HandoffContentDto) {
    return this.handoff.analyzeChanges(Scope.project, id, u.id, dto.content);
  }

  @Get("projects/:id/handoff/documents")
  projectDocuments(@CurrentUser() u: UserPrincipal, @Param("id") id: string) {
    return this.handoff.list(Scope.project, id, u.id);
  }

  @Get("targets/:id/handoff/prompt")
  targetPrompt(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Query("incremental") incremental?: string) {
    return this.handoff.prompt(Scope.target, id, u.id, incremental === "true");
  }

  @Post("targets/:id/handoff/preview")
  targetPreview(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Body() dto: HandoffContentDto) {
    return this.handoff.preview(Scope.target, id, u.id, dto.content);
  }

  @Post("targets/:id/handoff/import")
  targetImport(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Body() dto: HandoffApplyDto) {
    return this.handoff.apply(Scope.target, id, u.id, dto.content, dto.mode);
  }

  @Post("targets/:id/handoff/analyze-changes")
  targetAnalyze(@CurrentUser() u: UserPrincipal, @Param("id") id: string, @Body() dto: HandoffContentDto) {
    return this.handoff.analyzeChanges(Scope.target, id, u.id, dto.content);
  }

  @Get("targets/:id/handoff/documents")
  targetDocuments(@CurrentUser() u: UserPrincipal, @Param("id") id: string) {
    return this.handoff.list(Scope.target, id, u.id);
  }

  @Get("handoff/documents/:documentId")
  document(@CurrentUser() u: UserPrincipal, @Param("documentId") documentId: string) {
    return this.handoff.getDocument(documentId, u.id);
  }
}

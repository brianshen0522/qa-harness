import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Scope } from "@prisma/client";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { DiscussionService } from "./discussion.service";

class PostMessageDto {
  @IsString() @MinLength(1) @MaxLength(20_000) content!: string;
}
class UpdateDraftDto {
  @IsString() @MaxLength(200_000) draft!: string;
}
class SaveDescriptionDto {
  @IsOptional() @IsString() @MaxLength(200_000) content?: string;
}

@Controller()
@UseGuards(UserAuthGuard)
export class DiscussionController {
  constructor(private readonly discussion: DiscussionService) {}

  // ----- project scope -----

  @Get("projects/:id/discussion")
  getProject(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.discussion.get(Scope.project, id, user.id);
  }

  @Post("projects/:id/discussion/messages")
  postProject(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: PostMessageDto) {
    return this.discussion.postMessage(Scope.project, id, user.id, dto.content);
  }

  @Put("projects/:id/discussion/draft")
  draftProject(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: UpdateDraftDto) {
    return this.discussion.updateDraft(Scope.project, id, user.id, dto.draft);
  }

  @Post("projects/:id/discussion/save-description")
  saveProject(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: SaveDescriptionDto) {
    return this.discussion.saveDescription(Scope.project, id, user.id, dto.content);
  }

  @Get("projects/:id/attachments")
  attachments(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.discussion.attachments(id, user.id);
  }

  // ----- target scope -----

  @Get("targets/:id/discussion")
  getTarget(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.discussion.get(Scope.target, id, user.id);
  }

  @Post("targets/:id/discussion/messages")
  postTarget(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: PostMessageDto) {
    return this.discussion.postMessage(Scope.target, id, user.id, dto.content);
  }

  @Put("targets/:id/discussion/draft")
  draftTarget(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: UpdateDraftDto) {
    return this.discussion.updateDraft(Scope.target, id, user.id, dto.draft);
  }

  @Post("targets/:id/discussion/save-description")
  saveTarget(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: SaveDescriptionDto) {
    return this.discussion.saveDescription(Scope.target, id, user.id, dto.content);
  }

  // ----- target proposals -----

  @Post("discussion/proposals/:proposalId/accept")
  accept(@CurrentUser() user: UserPrincipal, @Param("proposalId") proposalId: string) {
    return this.discussion.decideProposal(proposalId, user.id, true);
  }

  @Post("discussion/proposals/:proposalId/reject")
  reject(@CurrentUser() user: UserPrincipal, @Param("proposalId") proposalId: string) {
    return this.discussion.decideProposal(proposalId, user.id, false);
  }
}

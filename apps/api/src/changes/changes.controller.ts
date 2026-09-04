import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import {
  IsBoolean, IsEnum, IsObject, IsOptional, IsString, MaxLength, MinLength,
} from "class-validator";
import { ChangeSource, Scope } from "@prisma/client";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { ChangesService, type Decisions } from "./changes.service";
import type { CaseSnapshot } from "./change-diff";

class AnalyzeDto {
  @IsOptional() @IsEnum(ChangeSource) source?: ChangeSource;
  @IsOptional() @IsString() @MaxLength(20_000) note?: string;
  /** For the "改完描述再按分析影響" entry. */
  @IsOptional() @IsString() @MaxLength(200_000) proposedDescription?: string;
}

class ApplyDto {
  @IsOptional() @IsBoolean() description?: boolean;
  @IsOptional() @IsObject() items?: Record<string, boolean>;
  @IsOptional() @IsObject() edits?: Record<string, Partial<CaseSnapshot>>;
}

class DiscussionChangeDto {
  @IsString() @MinLength(1) @MaxLength(20_000) note!: string;
}

@Controller()
@UseGuards(UserAuthGuard)
export class ChangesController {
  constructor(private readonly changes: ChangesService) {}

  // ---------- entry points (§4.4) ----------

  @Post("projects/:id/changes/analyze")
  analyzeProject(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: AnalyzeDto) {
    return this.changes.analyze(Scope.project, id, user.id, {
      source: dto.source ?? ChangeSource.manual,
      note: dto.note ?? "",
      proposedDescription: dto.proposedDescription,
    });
  }

  @Post("targets/:id/changes/analyze")
  analyzeTarget(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: AnalyzeDto) {
    return this.changes.analyze(Scope.target, id, user.id, {
      source: dto.source ?? ChangeSource.manual,
      note: dto.note ?? "",
      proposedDescription: dto.proposedDescription,
    });
  }

  /** 討論區入口: the user says what changed in plain language. */
  @Post("targets/:id/changes/from-discussion")
  fromDiscussion(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: DiscussionChangeDto) {
    return this.changes.analyze(Scope.target, id, user.id, {
      source: ChangeSource.discussion,
      note: dto.note,
    });
  }

  @Post("projects/:id/changes/from-discussion")
  fromProjectDiscussion(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: DiscussionChangeDto) {
    return this.changes.analyze(Scope.project, id, user.id, {
      source: ChangeSource.discussion,
      note: dto.note,
    });
  }

  /** 被動偵測入口: build a proposal from a run's possibly-changed failures. */
  @Post("runs/:id/change-proposal")
  fromRun(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.fromRun(id, user.id);
  }

  @Post("findings/:id/change-proposal")
  fromFinding(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.fromFinding(id, user.id);
  }

  // ---------- review ----------

  @Get("projects/:id/changes")
  listProject(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.list(Scope.project, id, user.id);
  }

  @Get("targets/:id/changes")
  listTarget(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.list(Scope.target, id, user.id);
  }

  @Get("changes/:id")
  get(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.get(id, user.id);
  }

  @Post("changes/:id/apply")
  apply(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: ApplyDto) {
    return this.changes.apply(id, user.id, dto as Decisions);
  }

  @Post("changes/:id/reject")
  reject(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.reject(id, user.id);
  }

  // ---------- timelines ----------

  @Get("projects/:id/change-log")
  projectLog(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.logs(Scope.project, id, user.id);
  }

  @Get("targets/:id/change-log")
  targetLog(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.logs(Scope.target, id, user.id);
  }

  /** Every version of one case, each tied to the change that produced it. */
  @Get("test-cases/:id/history")
  caseHistory(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.changes.caseHistory(id, user.id);
  }
}

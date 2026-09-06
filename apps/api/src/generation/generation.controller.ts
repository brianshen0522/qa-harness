import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, Res, UseGuards,
} from "@nestjs/common";
import {
  ArrayNotEmpty, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength,
} from "class-validator";
import { CaseStatus, CaseType, FeatureStatus, GenerationMode, Priority } from "@prisma/client";
import type { Request, Response } from "express";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { GenerationService } from "./generation.service";
import { TestCasesService } from "./test-cases.service";

class GenerateDto {
  @IsOptional() @IsEnum(GenerationMode) mode?: GenerationMode;
  /** Regenerate just these features, after a change proposal was applied (§4.4). */
  @IsOptional() @IsArray() @IsUUID("4", { each: true }) onlyFeatureIds?: string[];
}
class CaseDto {
  @IsString() @MinLength(1) @MaxLength(500) title!: string;
  @IsOptional() @IsString() @MaxLength(5000) precondition?: string;
  @IsOptional() @IsString() @MaxLength(2000) setupNote?: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) steps!: string[];
  @IsString() @MinLength(1) @MaxLength(5000) expected!: string;
  @IsOptional() @IsEnum(Priority) priority?: Priority;
  @IsOptional() @IsEnum(CaseType) type?: CaseType;
  @IsOptional() @IsUUID() featureId?: string | null;
}
class UpdateCaseDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) title?: string;
  @IsOptional() @IsString() @MaxLength(5000) precondition?: string;
  @IsOptional() @IsString() @MaxLength(2000) setupNote?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) steps?: string[];
  @IsOptional() @IsString() @MinLength(1) @MaxLength(5000) expected?: string;
  @IsOptional() @IsEnum(Priority) priority?: Priority;
  @IsOptional() @IsEnum(CaseType) type?: CaseType;
  @IsOptional() @IsEnum(CaseStatus) status?: CaseStatus;
  @IsOptional() @IsUUID() featureId?: string | null;
}
class BulkStatusDto {
  @IsArray() @ArrayNotEmpty() @IsUUID("4", { each: true }) caseIds!: string[];
  @IsEnum(CaseStatus) status!: CaseStatus;
}
class ReorderDto {
  @IsArray() @ArrayNotEmpty() @IsUUID("4", { each: true }) caseIds!: string[];
}
class FeatureDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
class UpdateFeatureDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsEnum(FeatureStatus) status?: FeatureStatus;
}

@Controller()
@UseGuards(UserAuthGuard)
export class GenerationController {
  constructor(
    private readonly generation: GenerationService,
    private readonly cases: TestCasesService,
  ) {}

  // ---------- generation pipeline ----------

  /**
   * Starts a run and streams its progress. The run itself lives in the service,
   * not the request: closing this stream (or the browser) does not stop it, and
   * reconnecting replays what has happened so far.
   */
  @Post("targets/:id/generate")
  async generate(
    @CurrentUser() user: UserPrincipal,
    @Param("id") id: string,
    @Body() dto: GenerateDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Permission and conflict errors surface as a normal HTTP status.
    await this.generation.start(id, user.id, dto.mode ?? GenerationMode.replace, {
      onlyFeatureIds: dto.onlyFeatureIds,
    });
    this.streamRun(id, req, res);
  }

  /** Re-attach to a run already in progress. */
  @Get("targets/:id/generate/stream")
  async stream(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    await this.cases.list(id, user.id); // 404/403 for anyone without access
    this.streamRun(id, req, res);
  }

  @Post("targets/:id/generate/cancel")
  cancel(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.generation.cancel(id, user.id);
  }

  private streamRun(targetId: string, req: Request, res: Response) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const send = (event: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const existing = this.generation.activeRun(targetId);
    if (!existing) {
      send({ type: "error", message: "目前沒有進行中的生成流程。" });
      res.end();
      return;
    }

    const unsubscribe = this.generation.subscribe(targetId, (event) => {
      send(event);
      if (event.type === "finished" || event.type === "error") {
        if (!res.writableEnded) res.end();
      }
    });
    // A run that already ended replayed its whole history above, terminal event
    // included, so there is nothing left to wait for.
    if (existing.finished) {
      if (!res.writableEnded) res.end();
      return;
    }
    // A paused run can wait a long time; keep the connection from being dropped.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    });
  }

  @Get("targets/:id/generation-runs")
  runs(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.generation.runs(id, user.id);
  }

  // ---------- test list ----------

  @Get("targets/:id/test-cases")
  list(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.cases.list(id, user.id);
  }

  @Post("targets/:id/test-cases")
  createCase(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: CaseDto) {
    return this.cases.createCase(id, user.id, dto);
  }

  @Put("targets/:id/test-cases/order")
  reorder(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: ReorderDto) {
    return this.cases.reorder(id, user.id, dto.caseIds);
  }

  @Put("targets/:id/test-cases/status")
  setStatuses(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: BulkStatusDto) {
    return this.cases.setStatuses(id, user.id, dto.caseIds, dto.status);
  }

  @Patch("test-cases/:caseId")
  updateCase(@CurrentUser() user: UserPrincipal, @Param("caseId") caseId: string, @Body() dto: UpdateCaseDto) {
    return this.cases.updateCase(caseId, user.id, dto);
  }

  @Delete("test-cases/:caseId")
  deleteCase(@CurrentUser() user: UserPrincipal, @Param("caseId") caseId: string) {
    return this.cases.deleteCase(caseId, user.id);
  }

  @Get("test-cases/:caseId/versions")
  versions(@CurrentUser() user: UserPrincipal, @Param("caseId") caseId: string) {
    return this.cases.versions(caseId, user.id);
  }

  // ---------- features ----------

  @Post("targets/:id/features")
  createFeature(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: FeatureDto) {
    return this.cases.createFeature(id, user.id, dto.name, dto.description);
  }

  @Patch("features/:featureId")
  updateFeature(@CurrentUser() user: UserPrincipal, @Param("featureId") featureId: string, @Body() dto: UpdateFeatureDto) {
    return this.cases.updateFeature(featureId, user.id, dto);
  }

  @Delete("features/:featureId")
  deleteFeature(@CurrentUser() user: UserPrincipal, @Param("featureId") featureId: string) {
    return this.cases.deleteFeature(featureId, user.id);
  }
}

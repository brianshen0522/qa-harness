import {
  Body, Controller, Get, Param, Post, Put, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import {
  ArrayNotEmpty, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength,
} from "class-validator";
import { CaseType, FindingStatus, Priority, Verdict } from "@prisma/client";
import type { Request, Response } from "express";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { RunService } from "./run.service";
import { RunQueryService } from "./run-query.service";
import { FindingConversionService } from "./finding-conversion.service";
import { ApiSetupService } from "./api-setup.service";

class StartRunDto {
  @IsOptional() @IsArray() @IsUUID("4", { each: true }) caseIds?: string[];
}
class CaseIdDto {
  @IsUUID() caseId!: string;
}
class ReviewDto {
  @IsEnum(Verdict) verdict!: Verdict;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
class FindingStatusDto {
  @IsEnum(FindingStatus) status!: FindingStatus;
}
class AskDto {
  @IsString() @MinLength(1) @MaxLength(4000) question!: string;
  @IsOptional() @IsUUID() resultId?: string;
  @IsOptional() @IsArray() history?: { role: "user" | "assistant"; content: string }[];
}
class ApiSetupDto {
  @IsArray() steps!: unknown[];
}
class ConvertFindingDto {
  @IsString() @MinLength(1) @MaxLength(500) title!: string;
  @IsOptional() @IsString() @MaxLength(5000) precondition?: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) steps!: string[];
  @IsString() @MinLength(1) @MaxLength(5000) expected!: string;
  @IsOptional() @IsEnum(Priority) priority?: Priority;
  @IsOptional() @IsEnum(CaseType) type?: CaseType;
  @IsOptional() @IsUUID() featureId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) featureName?: string | null;
}

@Controller()
@UseGuards(UserAuthGuard)
export class RunsController {
  constructor(
    private readonly runs: RunService,
    private readonly query: RunQueryService,
    private readonly findings2case: FindingConversionService,
    private readonly apiSetup: ApiSetupService,
  ) {}

  // ---------- running ----------

  // ---------- API 前置流程(§4.4) ----------

  @Get("targets/:id/api-setup")
  getApiSetup(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.apiSetup.get(id, user.id);
  }

  @Put("targets/:id/api-setup")
  putApiSetup(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: ApiSetupDto) {
    return this.apiSetup.put(id, user.id, dto.steps);
  }

  @Post("targets/:id/runs")
  start(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: StartRunDto) {
    return this.runs.start(id, user.id, dto.caseIds);
  }

  /** Live progress. Everyone with access shares the same stream (§4.6). */
  @Get("targets/:id/runs/stream")
  async stream(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    await this.query.assertViewer(id, user.id);
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
    const existing = this.runs.activeRun(id);
    if (!existing) {
      send({ type: "error", message: "目前沒有進行中的執行。" });
      res.end();
      return;
    }
    const unsubscribe = this.runs.subscribe(id, (event) => {
      send(event);
      if (event.type === "run_finished" || event.type === "error") {
        if (!res.writableEnded) res.end();
      }
    });
    if (existing.finished) {
      if (!res.writableEnded) res.end();
      return;
    }
    // A paused run can wait a long time; keep the connection alive.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    });
  }

  @Post("targets/:id/runs/abort")
  abort(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.runs.abort(id, user.id);
  }

  @Post("targets/:id/runs/skip-case")
  skip(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: CaseIdDto) {
    return this.runs.skipCase(id, dto.caseId, user.id);
  }

  @Post("targets/:id/runs/add-case")
  add(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: CaseIdDto) {
    return this.runs.addCase(id, dto.caseId, user.id);
  }

  // ---------- reading results ----------

  @Get("targets/:id/runs")
  list(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.query.listRuns(id, user.id);
  }

  /** Everything the live page and the results page need for one run. */
  @Get("runs/:runId")
  get(@CurrentUser() user: UserPrincipal, @Param("runId") runId: string) {
    return this.query.getRun(runId, user.id);
  }

  @Get("runs/:runId/steps")
  steps(@CurrentUser() user: UserPrincipal, @Param("runId") runId: string, @Query("caseId") caseId?: string) {
    return this.query.getSteps(runId, user.id, caseId);
  }

  @Post("runs/:runId/rerun-failed")
  async rerunFailed(@CurrentUser() user: UserPrincipal, @Param("runId") runId: string) {
    const run = await this.query.getRun(runId, user.id);
    const caseIds = await this.query.failedCaseIds(runId, user.id);
    return this.runs.start(run.run.targetId, user.id, caseIds);
  }

  @Get("runs/:runId/findings")
  findings(@CurrentUser() user: UserPrincipal, @Param("runId") runId: string) {
    return this.query.getFindings(runId, user.id);
  }

  /** Human review, kept separate from the model's verdict (§4.7). */
  @Post("results/:resultId/review")
  review(@CurrentUser() user: UserPrincipal, @Param("resultId") resultId: string, @Body() dto: ReviewDto) {
    return this.query.review(resultId, user.id, dto.verdict, dto.note);
  }

  /** §4.7: draft a regression case from a finding; nothing is written yet. */
  @Post("findings/:findingId/test-case/draft")
  draftCase(@CurrentUser() user: UserPrincipal, @Param("findingId") findingId: string) {
    return this.findings2case.draft(findingId, user.id);
  }

  /** Saves the draft the reviewer confirmed (and possibly edited). */
  @Post("findings/:findingId/test-case")
  convertCase(
    @CurrentUser() user: UserPrincipal,
    @Param("findingId") findingId: string,
    @Body() dto: ConvertFindingDto,
  ) {
    return this.findings2case.convert(findingId, user.id, {
      title: dto.title,
      precondition: dto.precondition ?? "",
      steps: dto.steps,
      expected: dto.expected,
      priority: dto.priority ?? Priority.P2,
      type: dto.type ?? "negative",
      featureId: dto.featureId ?? null,
      featureName: dto.featureName ?? null,
    });
  }

  /** §4.7: ask the LLM to explain a QA result, grounded in this run's evidence. */
  @Post("runs/:runId/ask")
  ask(@CurrentUser() user: UserPrincipal, @Param("runId") runId: string, @Body() dto: AskDto) {
    return this.query.ask(runId, user.id, dto.question, { resultId: dto.resultId, history: dto.history });
  }

  @Post("findings/:findingId/status")
  findingStatus(@CurrentUser() user: UserPrincipal, @Param("findingId") findingId: string, @Body() dto: FindingStatusDto) {
    return this.query.setFindingStatus(findingId, user.id, dto.status);
  }

  /** Screenshots and other evidence, streamed from object storage. */
  @Get("runs/:runId/evidence")
  async evidence(
    @CurrentUser() user: UserPrincipal,
    @Param("runId") runId: string,
    @Query("key") key: string,
    @Res() res: Response,
  ) {
    const file = await this.query.readEvidence(runId, user.id, key);
    if (!file) {
      res.status(404).json({ message: "找不到這份證據。" });
      return;
    }
    res.setHeader("content-type", file.contentType);
    res.setHeader("cache-control", "private, max-age=3600");
    res.end(file.body);
  }
}

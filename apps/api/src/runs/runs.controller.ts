import {
  Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import { ArrayNotEmpty, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { FindingStatus, Verdict } from "@prisma/client";
import type { Request, Response } from "express";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { RunService } from "./run.service";
import { RunQueryService } from "./run-query.service";

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

@Controller()
@UseGuards(UserAuthGuard)
export class RunsController {
  constructor(
    private readonly runs: RunService,
    private readonly query: RunQueryService,
  ) {}

  // ---------- running ----------

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

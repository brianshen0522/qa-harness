import {
  Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards,
} from "@nestjs/common";
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from "class-validator";
import type { Request, Response } from "express";
import { UserAuthGuard } from "../auth/guards/user-auth.guard";
import { CurrentUser } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { ExploreService, type ExploreConfig } from "./explore.service";
import { ExploreQueryService } from "./explore-query.service";
import { IdentitiesService, type IdentityInput } from "./identities.service";

class IdentityDto implements IdentityInput {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(40) role?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) credentialKeys?: string[];
  @IsOptional() loginConfig?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isAnonymous?: boolean;
}

class ExploreDto {
  @IsOptional() @IsInt() @Min(1) @Max(400) maxNodes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) maxDepth?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) seeds?: string[];
  @IsOptional() @IsBoolean() doRwd?: boolean;
  @IsOptional() @IsBoolean() doSynthesis?: boolean;
  @IsOptional() @IsBoolean() doAccessProbe?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(40) deepBudget?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) avoid?: string[];
}

@Controller()
@UseGuards(UserAuthGuard)
export class ExploreController {
  constructor(
    private readonly explore: ExploreService,
    private readonly query: ExploreQueryService,
    private readonly identities: IdentitiesService,
  ) {}

  // ---------- identities ----------

  @Get("targets/:id/identities")
  listIdentities(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.identities.list(id, user.id);
  }

  @Post("targets/:id/identities")
  createIdentity(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Body() dto: IdentityDto) {
    return this.identities.create(id, user.id, dto);
  }

  @Patch("identities/:identityId")
  updateIdentity(@CurrentUser() user: UserPrincipal, @Param("identityId") identityId: string, @Body() dto: Partial<IdentityDto>) {
    return this.identities.update(identityId, user.id, dto);
  }

  @Delete("identities/:identityId")
  deleteIdentity(@CurrentUser() user: UserPrincipal, @Param("identityId") identityId: string) {
    return this.identities.remove(identityId, user.id);
  }

  // ---------- running an exploration ----------

  @Post("targets/:id/explore")
  async start(
    @CurrentUser() user: UserPrincipal,
    @Param("id") id: string,
    @Body() dto: ExploreDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.explore.start(id, user.id, dto as Partial<ExploreConfig>);
    this.stream(id, req, res);
  }

  @Get("targets/:id/explore/stream")
  async streamOnly(@CurrentUser() user: UserPrincipal, @Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    await this.query.assertViewer(id, user.id);
    this.stream(id, req, res);
  }

  private stream(id: string, req: Request, res: Response) {
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
    const existing = this.explore.activeRun(id);
    if (!existing) {
      send({ type: "error", message: "目前沒有進行中的探索。" });
      res.end();
      return;
    }
    const unsubscribe = this.explore.subscribe(id, (event) => {
      send(event);
      if (event.type === "finished" || event.type === "error") {
        if (!res.writableEnded) res.end();
      }
    });
    if (existing.finished) {
      if (!res.writableEnded) res.end();
      return;
    }
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    });
  }

  @Post("targets/:id/explore/cancel")
  cancel(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.explore.cancel(id, user.id);
  }

  // ---------- reading results ----------

  @Get("targets/:id/explore/runs")
  runs(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.explore.runs(id, user.id);
  }

  @Get("targets/:id/explore/latest")
  latest(@CurrentUser() user: UserPrincipal, @Param("id") id: string) {
    return this.query.latest(id, user.id);
  }

  @Get("explore/:runId")
  detail(@CurrentUser() user: UserPrincipal, @Param("runId") runId: string) {
    return this.query.detail(runId, user.id);
  }

  @Get("explore/:runId/evidence")
  async evidence(@CurrentUser() user: UserPrincipal, @Param("runId") runId: string, @Req() req: Request, @Res() res: Response) {
    const key = String(req.query.key ?? "");
    const file = await this.query.readEvidence(runId, user.id, key);
    if (!file) {
      res.status(404).json({ message: "找不到這份截圖。" });
      return;
    }
    res.setHeader("content-type", file.contentType);
    res.setHeader("cache-control", "private, max-age=3600");
    res.end(file.body);
  }
}

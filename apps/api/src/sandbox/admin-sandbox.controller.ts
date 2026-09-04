import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from "class-validator";
import type { Request, Response } from "express";
import { AdminAuthGuard } from "../auth/guards/admin-auth.guard";
import { CurrentAdmin } from "../common/decorators";
import type { AdminPrincipal } from "../common/types";
import { AuditService } from "../audit/audit.service";
import { ComputerService } from "./computer.service";
import { SandboxService } from "./sandbox.service";
import { SandboxSessionService } from "./sandbox-session.service";

class CreateSandboxDto {
  @IsOptional() @IsString() startUrl?: string;
  @IsOptional() @IsInt() @Min(5) @Max(480) ttlMinutes?: number;
}

class PerformActionDto {
  @IsString() @MinLength(1) action!: string;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
}

class AgentMessageDto {
  @IsString() @MinLength(1) content!: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) maxSteps?: number;
}

@Controller("admin/sandbox")
@UseGuards(AdminAuthGuard)
export class AdminSandboxController {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly computer: ComputerService,
    private readonly session: SandboxSessionService,
    private readonly audit: AuditService,
  ) {}

  @Get("status")
  status() {
    return this.sandbox.status();
  }

  @Get("instances")
  list() {
    return this.sandbox.list();
  }

  @Post("instances")
  async create(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: CreateSandboxDto) {
    const instance = await this.sandbox.create(admin.id, {
      purpose: "admin-test",
      startUrl: dto.startUrl,
      ttlMinutes: dto.ttlMinutes,
    });
    await this.audit.log("admin", admin.id, "sandbox.start", instance.id, {
      name: instance.name, image: instance.image, startUrl: dto.startUrl ?? null,
    });
    return instance;
  }

  @Get("instances/:id")
  get(@Param("id") id: string) {
    return this.sandbox.get(id);
  }

  @Delete("instances/:id")
  async remove(@CurrentAdmin() admin: AdminPrincipal, @Param("id") id: string) {
    const r = await this.sandbox.remove(id);
    this.session.discard(id);
    await this.audit.log("admin", admin.id, "sandbox.stop", id);
    return r;
  }

  @Get("instances/:id/logs")
  async logs(@Param("id") id: string, @Query("tail") tail?: string) {
    return { logs: await this.sandbox.logs(id, Math.min(Number(tail) || 200, 2000)) };
  }

  /** Current screen, so the UI can show exactly what the model sees. */
  @Get("instances/:id/screenshot")
  async screenshot(@Param("id") id: string) {
    const { port } = await this.sandbox.requireAgentPort(id);
    const shot = await this.computer.screenshot(port);
    return {
      ok: shot.ok,
      error: shot.error ?? null,
      image: shot.image ? `data:image/png;base64,${shot.image}` : null,
      width: shot.detail.width ?? null,
      height: shot.detail.height ?? null,
    };
  }

  /** Run a single action by hand — useful for checking the environment without an LLM. */
  @Post("instances/:id/actions")
  async perform(@CurrentAdmin() admin: AdminPrincipal, @Param("id") id: string, @Body() dto: PerformActionDto) {
    const { port } = await this.sandbox.requireAgentPort(id);
    const res = await this.computer.perform(port, dto.action, dto.params ?? {});
    await this.audit.log("admin", admin.id, "sandbox.action", id, { action: dto.action, ok: res.ok });
    return {
      ...res,
      image: res.image ? `data:image/png;base64,${res.image}` : undefined,
    };
  }

  // ---------- steerable agent conversation ----------

  /** Transcript so far, for the first render before the stream attaches. */
  @Get("instances/:id/agent/session")
  async sessionSnapshot(@Param("id") id: string) {
    await this.sandbox.get(id);
    return this.session.snapshot(id);
  }

  /**
   * Live transcript. A GET so the browser can use EventSource; every subscriber
   * of the same sandbox sees the same events, and past events are replayed on
   * connect so a reload does not lose the conversation.
   */
  @Get("instances/:id/agent/stream")
  async stream(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    await this.sandbox.get(id);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const unsubscribe = this.session.subscribe(id, (event) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    // Proxies drop an idle stream; a comment every 25s keeps it open.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 25_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    });
  }

  /** Talk to the model: starts a round when idle, interrupts one that is running. */
  @Post("instances/:id/agent/messages")
  async sendMessage(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("id") id: string,
    @Body() dto: AgentMessageDto,
  ) {
    const r = await this.session.send(id, dto.content, dto.maxSteps);
    await this.audit.log("admin", admin.id, "sandbox.agent.message", id, {
      content: dto.content.slice(0, 500), interjected: r.interjected,
    });
    return r;
  }

  /** Stop the current round but keep the conversation. */
  @Post("instances/:id/agent/stop")
  async stopAgent(@CurrentAdmin() admin: AdminPrincipal, @Param("id") id: string) {
    const r = this.session.stop(id);
    await this.audit.log("admin", admin.id, "sandbox.agent.stop", id);
    return r;
  }

  /** Clear the conversation. */
  @Delete("instances/:id/agent/session")
  resetAgent(@Param("id") id: string) {
    return this.session.reset(id);
  }
}

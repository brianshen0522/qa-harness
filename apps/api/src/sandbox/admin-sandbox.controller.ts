import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from "class-validator";
import type { Request, Response } from "express";
import { AdminAuthGuard } from "../auth/guards/admin-auth.guard";
import { CurrentAdmin } from "../common/decorators";
import type { AdminPrincipal } from "../common/types";
import { AuditService } from "../audit/audit.service";
import { ComputerService } from "./computer.service";
import { SandboxService } from "./sandbox.service";
import { SandboxAgentService } from "./sandbox-agent.service";

class CreateSandboxDto {
  @IsOptional() @IsString() startUrl?: string;
  @IsOptional() @IsInt() @Min(5) @Max(480) ttlMinutes?: number;
}

class PerformActionDto {
  @IsString() @MinLength(1) action!: string;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
}

class AgentRunDto {
  @IsString() @MinLength(1) instruction!: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) maxSteps?: number;
}

@Controller("admin/sandbox")
@UseGuards(AdminAuthGuard)
export class AdminSandboxController {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly computer: ComputerService,
    private readonly agent: SandboxAgentService,
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

  /**
   * Streams the LLM agent loop as server-sent events.
   * POST (not GET) because the instruction goes in the body, so the client
   * consumes it with fetch + a stream reader rather than EventSource.
   */
  @Post("instances/:id/agent")
  async runAgent(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param("id") id: string,
    @Body() dto: AgentRunDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const send = (event: unknown) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    await this.audit.log("admin", admin.id, "sandbox.agent.run", id, {
      instruction: dto.instruction.slice(0, 500), maxSteps: dto.maxSteps ?? null,
    });

    try {
      for await (const event of this.agent.run(id, {
        instruction: dto.instruction,
        maxSteps: dto.maxSteps,
        signal: controller.signal,
      })) {
        send(event);
        if (controller.signal.aborted) break;
      }
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }
}

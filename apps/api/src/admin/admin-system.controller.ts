import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { AdminAuthGuard } from "../auth/guards/admin-auth.guard";
import { CurrentAdmin } from "../common/decorators";
import type { AdminPrincipal } from "../common/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { estimateCost } from "../llm/pricing";

class SandboxSettingsDto {
  @IsOptional() @IsString() image?: string;
  @IsOptional() @IsNumber() @Min(0.5) cpu?: number;
  @IsOptional() @IsInt() @Min(256) memoryMb?: number;
  @IsOptional() @IsString() resolution?: string;
  @IsOptional() @IsInt() @Min(1) maxConcurrent?: number;
  @IsOptional() @IsInt() @Min(1) maxStepsPerCase?: number;
  @IsOptional() @IsInt() @Min(5) stepTimeoutSec?: number;
  @IsOptional() @IsInt() @Min(1) retentionDays?: number;
  @IsOptional() @IsBoolean() recordVideo?: boolean;
}

@Controller("admin")
@UseGuards(AdminAuthGuard)
export class AdminSystemController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get("sandbox")
  async sandbox() {
    return this.prisma.sandboxSettings.upsert({ where: { id: 1 }, create: {}, update: {} });
  }

  @Put("sandbox")
  async updateSandbox(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: SandboxSettingsDto) {
    const row = await this.prisma.sandboxSettings.upsert({ where: { id: 1 }, create: { ...dto }, update: { ...dto } });
    await this.audit.log("admin", admin.id, "sandbox.update", "1", dto as object);
    return row;
  }

  @Get("audit")
  auditLogs(@Query("limit") limit?: string) {
    return this.audit.list(Math.min(Number(limit) || 100, 500));
  }

  @Get("usage")
  async usage() {
    const [byPurpose, byModel, recent, runAgg, targets, byProjectModel] = await Promise.all([
      this.prisma.llmCallLog.groupBy({
        by: ["purpose", "outcome"],
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      // Cost is per model, since price depends on which model actually served.
      this.prisma.llmCallLog.groupBy({
        by: ["model"],
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.prisma.llmCallLog.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: {
        id: true, purpose: true, schemaName: true, model: true, attempt: true, outcome: true, errorMessage: true,
        inputTokens: true, outputTokens: true, durationMs: true, createdAt: true,
      } }),
      // Per-project run count (§4.8 各 project 的 run 數).
      this.prisma.testRun.groupBy({ by: ["targetId"], _count: { _all: true }, _sum: { stepCount: true } }),
      this.prisma.qaTarget.findMany({ select: { id: true, name: true, projectId: true, project: { select: { name: true } } } }),
      // Per-project LLM cost, from the project attribution on each call (§4.8 估算成本).
      this.prisma.llmCallLog.groupBy({ by: ["projectId", "model"], _sum: { inputTokens: true, outputTokens: true } }),
    ]);

    const models = byModel.map((m) => {
      const inTok = m._sum.inputTokens ?? 0;
      const outTok = m._sum.outputTokens ?? 0;
      return { model: m.model, calls: m._count._all, inputTokens: inTok, outputTokens: outTok, costUsd: estimateCost(m.model, inTok, outTok) };
    });
    const totalCostUsd = models.reduce((a, m) => a + m.costUsd, 0);

    // Roll the per-target run/step counts, and the per-project LLM cost, up to projects.
    const byTarget = new Map(targets.map((t) => [t.id, t]));
    const projectName = new Map(targets.map((t) => [t.projectId, t.project.name]));
    const projects = new Map<string, { projectId: string; name: string; runs: number; steps: number; costUsd: number }>();
    const ensure = (projectId: string) =>
      projects.get(projectId) ??
      (() => {
        const e = { projectId, name: projectName.get(projectId) ?? "（未知專案）", runs: 0, steps: 0, costUsd: 0 };
        projects.set(projectId, e);
        return e;
      })();
    for (const r of runAgg) {
      const target = byTarget.get(r.targetId);
      if (!target) continue;
      const entry = ensure(target.projectId);
      entry.runs += r._count._all;
      entry.steps += r._sum.stepCount ?? 0;
    }
    for (const row of byProjectModel) {
      if (!row.projectId) continue; // calls not attributed to a project (older logs)
      ensure(row.projectId).costUsd += estimateCost(row.model, row._sum.inputTokens ?? 0, row._sum.outputTokens ?? 0);
    }

    return { byPurpose, models, totalCostUsd, recent, byProject: [...projects.values()] };
  }
}

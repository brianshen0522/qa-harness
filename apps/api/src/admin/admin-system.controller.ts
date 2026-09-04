import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { IsInt, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { AdminAuthGuard } from "../auth/guards/admin-auth.guard";
import { CurrentAdmin } from "../common/decorators";
import type { AdminPrincipal } from "../common/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

class SandboxSettingsDto {
  @IsOptional() @IsString() image?: string;
  @IsOptional() @IsNumber() @Min(0.5) cpu?: number;
  @IsOptional() @IsInt() @Min(256) memoryMb?: number;
  @IsOptional() @IsString() resolution?: string;
  @IsOptional() @IsInt() @Min(1) maxConcurrent?: number;
  @IsOptional() @IsInt() @Min(1) maxStepsPerCase?: number;
  @IsOptional() @IsInt() @Min(5) stepTimeoutSec?: number;
  @IsOptional() @IsInt() @Min(1) retentionDays?: number;
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
    const [byPurpose, recent] = await Promise.all([
      this.prisma.llmCallLog.groupBy({
        by: ["purpose", "outcome"],
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.prisma.llmCallLog.findMany({ orderBy: { createdAt: "desc" }, take: 50, select: {
        id: true, purpose: true, schemaName: true, model: true, attempt: true, outcome: true, errorMessage: true,
        inputTokens: true, outputTokens: true, durationMs: true, createdAt: true,
      } }),
    ]);
    return { byPurpose, recent };
  }
}

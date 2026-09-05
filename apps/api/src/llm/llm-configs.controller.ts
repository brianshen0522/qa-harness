import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import { LlmProvider, LlmPurpose } from "@prisma/client";
import { AdminGuard } from "../auth/guards/admin.guard";
import { CurrentAdmin } from "../common/decorators";
import type { UserPrincipal } from "../common/types";
import { AuditService } from "../audit/audit.service";
import { LlmConfigsService } from "./llm-configs.service";
import { LlmGatewayService } from "./llm-gateway.service";
import { LlmHealthService } from "./llm-health.service";

class CreateLlmConfigDto {
  @IsString() @MinLength(1) name!: string;
  @IsEnum(LlmProvider) provider!: LlmProvider;
  @IsOptional() @IsString() endpoint?: string | null;
  @IsOptional() @IsString() apiKey?: string | null;
  @IsString() @MinLength(1) model!: string;
  @IsArray() @ArrayMinSize(1) @IsEnum(LlmPurpose, { each: true }) purposes!: LlmPurpose[];
  @IsBoolean() supportsVision!: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class UpdateLlmConfigDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsEnum(LlmProvider) provider?: LlmProvider;
  @IsOptional() @IsString() endpoint?: string | null;
  @IsOptional() @IsString() apiKey?: string | null;
  @IsOptional() @IsString() @MinLength(1) model?: string;
  @IsOptional() @IsArray() @IsEnum(LlmPurpose, { each: true }) purposes?: LlmPurpose[];
  @IsOptional() @IsBoolean() supportsVision?: boolean;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
class TestPromptDto {
  @IsString() @MinLength(1) prompt!: string;
}
class SetChainDto {
  @IsArray() @IsUUID("4", { each: true }) configIds!: string[];
}

@Controller("admin/llm")
@UseGuards(AdminGuard)
export class LlmConfigsController {
  constructor(
    private readonly configs: LlmConfigsService,
    private readonly gateway: LlmGatewayService,
    private readonly health: LlmHealthService,
    private readonly audit: AuditService,
  ) {}

  @Get("configs")
  list() {
    return this.configs.list();
  }

  @Post("configs")
  async create(@CurrentAdmin() admin: UserPrincipal, @Body() dto: CreateLlmConfigDto) {
    const row = await this.configs.create({ ...dto, enabled: dto.enabled ?? true });
    await this.audit.log("admin", admin.id, "llm.config.create", row.id, { name: dto.name, provider: dto.provider, model: dto.model });
    return row;
  }

  @Patch("configs/:id")
  async update(@CurrentAdmin() admin: UserPrincipal, @Param("id") id: string, @Body() dto: UpdateLlmConfigDto) {
    const row = await this.configs.update(id, dto);
    // An edit is the admin saying "try this again": clear the breaker at once so
    // anything waiting on this purpose wakes up.
    await this.health.resetAfterEdit(id);
    const { apiKey, ...safe } = dto;
    await this.audit.log("admin", admin.id, "llm.config.update", id, { ...safe, apiKeyChanged: apiKey !== undefined });
    return row;
  }

  @Delete("configs/:id")
  async remove(@CurrentAdmin() admin: UserPrincipal, @Param("id") id: string) {
    const r = await this.configs.remove(id);
    await this.audit.log("admin", admin.id, "llm.config.delete", id);
    return r;
  }

  @Post("configs/:id/test")
  test(@Param("id") id: string, @Body() dto: TestPromptDto) {
    return this.gateway.testConfig(id, dto.prompt);
  }

  @Get("chains")
  chains() {
    return this.configs.chains();
  }

  @Put("chains/:purpose")
  async setChain(@CurrentAdmin() admin: UserPrincipal, @Param("purpose") purpose: LlmPurpose, @Body() dto: SetChainDto) {
    const r = await this.configs.setChain(purpose, dto.configIds);
    await this.audit.log("admin", admin.id, "llm.chain.set", purpose, { configIds: dto.configIds });
    return r;
  }

  @Get("coverage")
  coverage() {
    return this.configs.coverage();
  }

  /** Health of every config plus per-purpose coverage, for the admin page. */
  @Get("health")
  healthStatus() {
    return this.health.status();
  }

  /** Probe one config now instead of waiting for the next sweep. */
  @Post("configs/:id/probe")
  async probe(@CurrentAdmin() admin: UserPrincipal, @Param("id") id: string) {
    const r = await this.health.probeConfig(id);
    await this.audit.log("admin", admin.id, "llm.probe", id, { ok: r.ok });
    return r;
  }

  /** Force a sweep of every config the breaker has taken out. */
  @Post("probe-all")
  async probeAll() {
    const recovered = await this.health.probeOnce();
    return { recovered };
  }
}

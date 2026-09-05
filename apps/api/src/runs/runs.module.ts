import { Module } from "@nestjs/common";
import { RunsController } from "./runs.controller";
import { RunService } from "./run.service";
import { RunQueryService } from "./run-query.service";
import { FindingConversionService } from "./finding-conversion.service";
import { EvidenceService } from "./evidence.service";
import { HttpExecutorService } from "./http-executor.service";
import { ApiSetupService } from "./api-setup.service";
import { RetentionService } from "./retention.service";
import { LlmModule } from "../llm/llm.module";
import { SandboxModule } from "../sandbox/sandbox.module";
import { TargetsModule } from "../targets/targets.module";
import { SkillsModule } from "../skills/skills.module";
import { McpModule } from "../mcp/mcp.module";

@Module({
  imports: [LlmModule, SandboxModule, TargetsModule, SkillsModule, McpModule],
  controllers: [RunsController],
  providers: [RunService, RunQueryService, FindingConversionService, EvidenceService, HttpExecutorService, ApiSetupService, RetentionService],
  exports: [RunService, RunQueryService, EvidenceService, ApiSetupService, RetentionService],
})
export class RunsModule {}

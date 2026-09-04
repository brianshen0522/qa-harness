import { Module } from "@nestjs/common";
import { RunsController } from "./runs.controller";
import { RunService } from "./run.service";
import { RunQueryService } from "./run-query.service";
import { FindingConversionService } from "./finding-conversion.service";
import { EvidenceService } from "./evidence.service";
import { HttpExecutorService } from "./http-executor.service";
import { RetentionService } from "./retention.service";
import { LlmModule } from "../llm/llm.module";
import { SandboxModule } from "../sandbox/sandbox.module";
import { TargetsModule } from "../targets/targets.module";
import { SkillsModule } from "../skills/skills.module";

@Module({
  imports: [LlmModule, SandboxModule, TargetsModule, SkillsModule],
  controllers: [RunsController],
  providers: [RunService, RunQueryService, FindingConversionService, EvidenceService, HttpExecutorService, RetentionService],
  exports: [RunService, RunQueryService, EvidenceService, RetentionService],
})
export class RunsModule {}

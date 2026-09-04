import { Module } from "@nestjs/common";
import { RunsController } from "./runs.controller";
import { RunService } from "./run.service";
import { RunQueryService } from "./run-query.service";
import { EvidenceService } from "./evidence.service";
import { HttpExecutorService } from "./http-executor.service";
import { LlmModule } from "../llm/llm.module";
import { SandboxModule } from "../sandbox/sandbox.module";
import { TargetsModule } from "../targets/targets.module";

@Module({
  imports: [LlmModule, SandboxModule, TargetsModule],
  controllers: [RunsController],
  providers: [RunService, RunQueryService, EvidenceService, HttpExecutorService],
  exports: [RunService, RunQueryService, EvidenceService],
})
export class RunsModule {}

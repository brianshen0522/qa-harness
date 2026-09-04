import { Module } from "@nestjs/common";
import { ExploreController } from "./explore.controller";
import { ExploreService } from "./explore.service";
import { ExploreQueryService } from "./explore-query.service";
import { IdentitiesService } from "./identities.service";
import { LlmModule } from "../llm/llm.module";
import { SandboxModule } from "../sandbox/sandbox.module";
import { TargetsModule } from "../targets/targets.module";
import { RunsModule } from "../runs/runs.module";

@Module({
  imports: [LlmModule, SandboxModule, TargetsModule, RunsModule],
  controllers: [ExploreController],
  providers: [ExploreService, ExploreQueryService, IdentitiesService],
  exports: [ExploreService, IdentitiesService],
})
export class ExploreModule {}

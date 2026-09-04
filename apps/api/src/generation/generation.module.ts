import { Module } from "@nestjs/common";
import { GenerationController } from "./generation.controller";
import { GenerationService } from "./generation.service";
import { TestCasesService } from "./test-cases.service";
import { DiscoveryService } from "./discovery.service";
import { LlmModule } from "../llm/llm.module";
import { DiscussionModule } from "../discussion/discussion.module";

@Module({
  imports: [LlmModule, DiscussionModule],
  controllers: [GenerationController],
  providers: [GenerationService, TestCasesService, DiscoveryService],
  exports: [GenerationService, TestCasesService, DiscoveryService],
})
export class GenerationModule {}

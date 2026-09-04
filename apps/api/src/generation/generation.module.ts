import { Module } from "@nestjs/common";
import { GenerationController } from "./generation.controller";
import { GenerationService } from "./generation.service";
import { TestCasesService } from "./test-cases.service";
import { DiscoveryService } from "./discovery.service";
import { LlmModule } from "../llm/llm.module";
import { DiscussionModule } from "../discussion/discussion.module";
import { SkillsModule } from "../skills/skills.module";

@Module({
  imports: [LlmModule, DiscussionModule, SkillsModule],
  controllers: [GenerationController],
  providers: [GenerationService, TestCasesService, DiscoveryService],
  exports: [GenerationService, TestCasesService, DiscoveryService],
})
export class GenerationModule {}

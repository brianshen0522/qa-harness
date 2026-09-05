import { Module } from "@nestjs/common";
import { GenerationController } from "./generation.controller";
import { GenerationService } from "./generation.service";
import { TestCasesService } from "./test-cases.service";
import { DiscoveryService } from "./discovery.service";
import { DesktopDiscoveryService } from "./desktop-discovery.service";
import { SandboxModule } from "../sandbox/sandbox.module";
import { LlmModule } from "../llm/llm.module";
import { DiscussionModule } from "../discussion/discussion.module";
import { SkillsModule } from "../skills/skills.module";

@Module({
  imports: [LlmModule, DiscussionModule, SkillsModule, SandboxModule],
  controllers: [GenerationController],
  providers: [GenerationService, TestCasesService, DiscoveryService, DesktopDiscoveryService],
  exports: [GenerationService, TestCasesService, DiscoveryService],
})
export class GenerationModule {}

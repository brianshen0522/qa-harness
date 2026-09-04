import { Module } from "@nestjs/common";
import { DiscussionController } from "./discussion.controller";
import { DiscussionService } from "./discussion.service";
import { UrlFetchService } from "./url-fetch.service";
import { LlmModule } from "../llm/llm.module";
import { ProjectsModule } from "../projects/projects.module";
import { TargetsModule } from "../targets/targets.module";

@Module({
  imports: [LlmModule, ProjectsModule, TargetsModule],
  controllers: [DiscussionController],
  providers: [DiscussionService, UrlFetchService],
  exports: [DiscussionService, UrlFetchService],
})
export class DiscussionModule {}

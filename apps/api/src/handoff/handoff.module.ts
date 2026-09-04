import { Module } from "@nestjs/common";
import { HandoffController } from "./handoff.controller";
import { HandoffService } from "./handoff.service";
import { ProjectsModule } from "../projects/projects.module";
import { TargetsModule } from "../targets/targets.module";

@Module({
  imports: [ProjectsModule, TargetsModule],
  controllers: [HandoffController],
  providers: [HandoffService],
  exports: [HandoffService],
})
export class HandoffModule {}

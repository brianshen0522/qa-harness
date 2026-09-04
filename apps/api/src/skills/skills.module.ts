import { Module } from "@nestjs/common";
import { AdminSkillsController, ProjectSkillsController } from "./skills.controller";
import { SkillsService } from "./skills.service";

@Module({
  controllers: [AdminSkillsController, ProjectSkillsController],
  providers: [SkillsService],
  exports: [SkillsService],
})
export class SkillsModule {}

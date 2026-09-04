import { Module } from "@nestjs/common";
import { ChangesController } from "./changes.controller";
import { ChangesService } from "./changes.service";
import { LlmModule } from "../llm/llm.module";

@Module({
  imports: [LlmModule],
  controllers: [ChangesController],
  providers: [ChangesService],
  exports: [ChangesService],
})
export class ChangesModule {}

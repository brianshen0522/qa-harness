import { Module } from "@nestjs/common";
import { LlmConfigsController } from "./llm-configs.controller";
import { LlmConfigsService } from "./llm-configs.service";
import { LlmGatewayService } from "./llm-gateway.service";

@Module({
  controllers: [LlmConfigsController],
  providers: [LlmConfigsService, LlmGatewayService],
  exports: [LlmConfigsService, LlmGatewayService],
})
export class LlmModule {}

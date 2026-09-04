import { Module } from "@nestjs/common";
import { LlmConfigsController } from "./llm-configs.controller";
import { LlmConfigsService } from "./llm-configs.service";
import { LlmGatewayService } from "./llm-gateway.service";
import { LlmHealthService } from "./llm-health.service";

@Module({
  controllers: [LlmConfigsController],
  providers: [LlmConfigsService, LlmGatewayService, LlmHealthService],
  exports: [LlmConfigsService, LlmGatewayService, LlmHealthService],
})
export class LlmModule {}

import { Module } from "@nestjs/common";
import { AdminSandboxController } from "./admin-sandbox.controller";
import { DockerService } from "./docker.service";
import { ComputerService } from "./computer.service";
import { SandboxService } from "./sandbox.service";
import { SandboxAgentService } from "./sandbox-agent.service";
import { LlmModule } from "../llm/llm.module";

@Module({
  imports: [LlmModule],
  controllers: [AdminSandboxController],
  providers: [DockerService, ComputerService, SandboxService, SandboxAgentService],
  exports: [SandboxService, ComputerService, SandboxAgentService],
})
export class SandboxModule {}

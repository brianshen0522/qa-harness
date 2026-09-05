import { Module } from "@nestjs/common";
import { AdminMcpController, ProjectMcpController } from "./mcp.controller";
import { McpService } from "./mcp.service";
import { CryptoModule } from "../crypto/crypto.module";

@Module({
  imports: [CryptoModule],
  controllers: [AdminMcpController, ProjectMcpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { CryptoModule } from "./crypto/crypto.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { MeModule } from "./me/me.module";
import { PermissionsModule } from "./permissions/permissions.module";
import { TeamsModule } from "./teams/teams.module";
import { ProjectsModule } from "./projects/projects.module";
import { TargetsModule } from "./targets/targets.module";
import { AdminModule } from "./admin/admin.module";
import { LlmModule } from "./llm/llm.module";
import { DiscussionModule } from "./discussion/discussion.module";
import { HandoffModule } from "./handoff/handoff.module";
import { SandboxModule } from "./sandbox/sandbox.module";
import { GenerationModule } from "./generation/generation.module";
import { RunsModule } from "./runs/runs.module";
import { ChangesModule } from "./changes/changes.module";
import { ExploreModule } from "./explore/explore.module";
import { SkillsModule } from "./skills/skills.module";
import { McpModule } from "./mcp/mcp.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [MeModule, 
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CryptoModule,
    AuditModule,
    AuthModule,
    PermissionsModule,
    TeamsModule,
    ProjectsModule,
    TargetsModule,
    AdminModule,
    LlmModule,
    DiscussionModule,
    HandoffModule,
    SandboxModule,
    GenerationModule,
    RunsModule,
    ChangesModule,
    ExploreModule,
    SkillsModule,
    McpModule,
    HealthModule,
  ],
})
export class AppModule {}

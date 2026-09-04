-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('viewer', 'editor', 'owner');

-- CreateEnum
CREATE TYPE "DescriptionSource" AS ENUM ('manual', 'discussion', 'handoff');

-- CreateEnum
CREATE TYPE "TargetKind" AS ENUM ('api', 'web', 'desktop');

-- CreateEnum
CREATE TYPE "TargetStatus" AS ENUM ('idle', 'running');

-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('anthropic', 'openai', 'ollama');

-- CreateEnum
CREATE TYPE "LlmPurpose" AS ENUM ('discuss', 'generate', 'execute');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('admin', 'user');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "auth_provider" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "description_version" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_description_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "source" "DescriptionSource" NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_description_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE "qa_targets" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TargetKind" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "description" TEXT NOT NULL DEFAULT '',
    "description_version" INTEGER NOT NULL DEFAULT 0,
    "status" "TargetStatus" NOT NULL DEFAULT 'idle',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qa_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_target_credentials" (
    "target_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "encrypted_value" TEXT NOT NULL,

    CONSTRAINT "qa_target_credentials_pkey" PRIMARY KEY ("target_id","key")
);

-- CreateTable
CREATE TABLE "qa_target_members" (
    "target_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "qa_target_members_pkey" PRIMARY KEY ("target_id","user_id")
);

-- CreateTable
CREATE TABLE "llm_configs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "LlmProvider" NOT NULL,
    "endpoint" TEXT,
    "api_key" TEXT,
    "model" TEXT NOT NULL,
    "purposes" "LlmPurpose"[],
    "supports_vision" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_fallback_chains" (
    "purpose" "LlmPurpose" NOT NULL,
    "llm_config_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "llm_fallback_chains_pkey" PRIMARY KEY ("purpose","llm_config_id")
);

-- CreateTable
CREATE TABLE "llm_call_logs" (
    "id" TEXT NOT NULL,
    "purpose" "LlmPurpose" NOT NULL,
    "schema_name" TEXT,
    "llm_config_id" TEXT,
    "model" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "error_message" TEXT,
    "raw_output" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "image" TEXT NOT NULL DEFAULT 'ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest',
    "cpu" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "memory_mb" INTEGER NOT NULL DEFAULT 4096,
    "resolution" TEXT NOT NULL DEFAULT '1280x800',
    "max_concurrent" INTEGER NOT NULL DEFAULT 2,
    "max_steps_per_case" INTEGER NOT NULL DEFAULT 60,
    "step_timeout" INTEGER NOT NULL DEFAULT 60,
    "retention_days" INTEGER NOT NULL DEFAULT 30,

    CONSTRAINT "sandbox_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "project_description_versions_project_id_version_key" ON "project_description_versions"("project_id", "version");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_description_versions" ADD CONSTRAINT "project_description_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_targets" ADD CONSTRAINT "qa_targets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_target_credentials" ADD CONSTRAINT "qa_target_credentials_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_target_members" ADD CONSTRAINT "qa_target_members_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_target_members" ADD CONSTRAINT "qa_target_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_fallback_chains" ADD CONSTRAINT "llm_fallback_chains_llm_config_id_fkey" FOREIGN KEY ("llm_config_id") REFERENCES "llm_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

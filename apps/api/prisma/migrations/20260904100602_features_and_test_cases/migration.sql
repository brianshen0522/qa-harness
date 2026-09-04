-- CreateEnum
CREATE TYPE "FeatureStatus" AS ENUM ('active', 'removed');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('P0', 'P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "CaseType" AS ENUM ('happy', 'edge', 'negative');

-- CreateEnum
CREATE TYPE "CaseSource" AS ENUM ('generated', 'manual', 'change_proposal');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('active', 'outdated', 'deprecated');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "GenerationMode" AS ENUM ('replace', 'append');

-- CreateTable
CREATE TABLE "features" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "FeatureStatus" NOT NULL DEFAULT 'active',
    "based_on_description_version" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "feature_id" TEXT,
    "title" TEXT NOT NULL,
    "precondition" TEXT NOT NULL DEFAULT '',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "expected" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'P2',
    "type" "CaseType" NOT NULL DEFAULT 'happy',
    "source" "CaseSource" NOT NULL DEFAULT 'generated',
    "status" "CaseStatus" NOT NULL DEFAULT 'active',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,
    "based_on_description_version" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_case_versions" (
    "id" TEXT NOT NULL,
    "test_case_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "change_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_case_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_runs" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'running',
    "mode" "GenerationMode" NOT NULL,
    "description_version" INTEGER NOT NULL,
    "feature_count" INTEGER NOT NULL DEFAULT 0,
    "case_count" INTEGER NOT NULL DEFAULT 0,
    "duplicates_dropped" INTEGER NOT NULL DEFAULT 0,
    "discovery" JSONB,
    "model" TEXT,
    "error" TEXT,
    "triggered_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "features_target_id_order_idx" ON "features"("target_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "features_target_id_name_key" ON "features"("target_id", "name");

-- CreateIndex
CREATE INDEX "test_cases_target_id_order_idx" ON "test_cases"("target_id", "order");

-- CreateIndex
CREATE INDEX "test_cases_feature_id_idx" ON "test_cases"("feature_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_case_versions_test_case_id_version_key" ON "test_case_versions"("test_case_id", "version");

-- CreateIndex
CREATE INDEX "generation_runs_target_id_started_at_idx" ON "generation_runs"("target_id", "started_at");

-- AddForeignKey
ALTER TABLE "features" ADD CONSTRAINT "features_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_versions" ADD CONSTRAINT "test_case_versions_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

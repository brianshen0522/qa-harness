-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'paused', 'succeeded', 'failed', 'aborted');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('queued', 'running', 'done', 'skipped');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('pass', 'fail', 'blocked', 'skipped');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('critical', 'major', 'minor', 'info');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('open', 'converted_to_case', 'converted_to_proposal', 'dismissed');

-- CreateTable
CREATE TABLE "test_runs" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "sandbox_id" TEXT,
    "sandbox_name" TEXT,
    "view_url" TEXT,
    "llm_config_snapshot" JSONB,
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "paused_reason" TEXT,
    "error" TEXT,
    "triggered_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_case_queue" (
    "run_id" TEXT NOT NULL,
    "test_case_id" TEXT NOT NULL,
    "test_case_version" INTEGER,
    "status" "QueueStatus" NOT NULL DEFAULT 'queued',
    "order" INTEGER NOT NULL,
    "edited_after_use" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "run_case_queue_pkey" PRIMARY KEY ("run_id","test_case_id")
);

-- CreateTable
CREATE TABLE "run_steps" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "test_case_id" TEXT,
    "seq" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "action" JSONB NOT NULL,
    "intent" TEXT NOT NULL DEFAULT '',
    "observation" TEXT NOT NULL DEFAULT '',
    "screenshot_key" TEXT,
    "result" JSONB,
    "model_used" TEXT,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_results" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "test_case_id" TEXT NOT NULL,
    "test_case_version" INTEGER NOT NULL,
    "verdict" "Verdict" NOT NULL,
    "possibly_changed" BOOLEAN NOT NULL DEFAULT false,
    "llm_reasoning" TEXT NOT NULL DEFAULT '',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "repro_steps" TEXT[],
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "human_verdict" "Verdict",
    "human_note" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_findings" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "test_case_id" TEXT,
    "severity" "Severity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "related_feature_id" TEXT,
    "status" "FindingStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_runs_target_id_started_at_idx" ON "test_runs"("target_id", "started_at");

-- CreateIndex
CREATE INDEX "run_case_queue_run_id_order_idx" ON "run_case_queue"("run_id", "order");

-- CreateIndex
CREATE INDEX "run_steps_run_id_seq_idx" ON "run_steps"("run_id", "seq");

-- CreateIndex
CREATE INDEX "test_results_run_id_idx" ON "test_results"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_results_run_id_test_case_id_key" ON "test_results"("run_id", "test_case_id");

-- CreateIndex
CREATE INDEX "run_findings_run_id_created_at_idx" ON "run_findings"("run_id", "created_at");

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_case_queue" ADD CONSTRAINT "run_case_queue_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_case_queue" ADD CONSTRAINT "run_case_queue_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_findings" ADD CONSTRAINT "run_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_findings" ADD CONSTRAINT "run_findings_related_feature_id_fkey" FOREIGN KEY ("related_feature_id") REFERENCES "features"("id") ON DELETE SET NULL ON UPDATE CASCADE;

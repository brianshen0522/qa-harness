-- CreateEnum
CREATE TYPE "ChangeSource" AS ENUM ('discussion', 'handoff', 'manual', 'run_detection', 'finding');

-- CreateEnum
CREATE TYPE "ProposalState" AS ENUM ('pending', 'applied', 'rejected');

-- CreateTable
CREATE TABLE "change_proposals" (
    "id" TEXT NOT NULL,
    "scope" "Scope" NOT NULL,
    "project_id" TEXT,
    "target_id" TEXT,
    "source" "ChangeSource" NOT NULL,
    "state" "ProposalState" NOT NULL DEFAULT 'pending',
    "summary" TEXT NOT NULL DEFAULT '',
    "description_diff" TEXT NOT NULL DEFAULT '',
    "description_after" TEXT NOT NULL DEFAULT '',
    "feature_changes" JSONB NOT NULL DEFAULT '[]',
    "test_case_changes" JSONB NOT NULL DEFAULT '[]',
    "origin_note" TEXT,
    "model" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "change_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_logs" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "scope" "Scope" NOT NULL,
    "project_id" TEXT,
    "target_id" TEXT,
    "source" "ChangeSource" NOT NULL,
    "summary" TEXT NOT NULL,
    "description_version_after" INTEGER,
    "affected_feature_ids" TEXT[],
    "affected_test_case_ids" TEXT[],
    "decisions" JSONB NOT NULL DEFAULT '{}',
    "applied_by" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "change_proposals_project_id_created_at_idx" ON "change_proposals"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "change_proposals_target_id_created_at_idx" ON "change_proposals"("target_id", "created_at");

-- CreateIndex
CREATE INDEX "change_logs_project_id_applied_at_idx" ON "change_logs"("project_id", "applied_at");

-- CreateIndex
CREATE INDEX "change_logs_target_id_applied_at_idx" ON "change_logs"("target_id", "applied_at");

-- AddForeignKey
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "change_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

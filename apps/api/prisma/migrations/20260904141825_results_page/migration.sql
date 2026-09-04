-- AlterEnum
ALTER TYPE "CaseSource" ADD VALUE 'finding';

-- AlterTable
ALTER TABLE "run_findings" ADD COLUMN     "converted_case_id" TEXT,
ADD COLUMN     "converted_proposal_id" TEXT;

-- AlterTable
ALTER TABLE "sandbox_settings" ADD COLUMN     "record_video" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "test_runs" ADD COLUMN     "llm_usage" JSONB;

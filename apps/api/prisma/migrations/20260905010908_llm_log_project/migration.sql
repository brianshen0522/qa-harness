-- AlterTable
ALTER TABLE "llm_call_logs" ADD COLUMN     "project_id" TEXT,
ADD COLUMN     "target_id" TEXT;

-- CreateIndex
CREATE INDEX "llm_call_logs_project_id_created_at_idx" ON "llm_call_logs"("project_id", "created_at");

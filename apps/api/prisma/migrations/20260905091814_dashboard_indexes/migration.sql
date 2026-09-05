-- CreateIndex
CREATE INDEX "run_findings_status_idx" ON "run_findings"("status");

-- CreateIndex
CREATE INDEX "test_cases_target_id_status_idx" ON "test_cases"("target_id", "status");

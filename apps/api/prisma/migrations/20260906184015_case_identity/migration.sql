-- Bind a test case to the identity it must run as.
ALTER TABLE "test_cases" ADD COLUMN "identity_id" TEXT;
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "target_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "test_cases_identity_id_idx" ON "test_cases"("identity_id");

-- Durable abort signal so a stop reaches a run owned by another process.
ALTER TABLE "test_runs" ADD COLUMN "abort_requested" BOOLEAN NOT NULL DEFAULT false;

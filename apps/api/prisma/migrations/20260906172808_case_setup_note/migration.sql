-- Per-case setup/data requirement note (data a single run cannot create itself).
ALTER TABLE "test_cases" ADD COLUMN "setup_note" TEXT NOT NULL DEFAULT '';

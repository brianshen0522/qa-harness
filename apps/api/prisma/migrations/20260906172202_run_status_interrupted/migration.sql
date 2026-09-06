-- Add the "interrupted" run status (environment cut a run short, not a test failure).
ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'interrupted';

-- CreateEnum
CREATE TYPE "LlmHealth" AS ENUM ('healthy', 'degraded', 'down');

-- AlterEnum
ALTER TYPE "GenerationStatus" ADD VALUE 'paused';

-- AlterTable
ALTER TABLE "generation_runs" ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "paused_reason" TEXT,
ADD COLUMN     "progress" JSONB;

-- AlterTable
ALTER TABLE "llm_configs" ADD COLUMN     "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "down_since" TIMESTAMP(3),
ADD COLUMN     "health" "LlmHealth" NOT NULL DEFAULT 'healthy',
ADD COLUMN     "last_failure_at" TIMESTAMP(3),
ADD COLUMN     "last_failure_kind" TEXT,
ADD COLUMN     "last_failure_message" TEXT,
ADD COLUMN     "last_probe_at" TIMESTAMP(3),
ADD COLUMN     "last_recovered_at" TIMESTAMP(3),
ADD COLUMN     "next_probe_at" TIMESTAMP(3),
ADD COLUMN     "probe_attempts" INTEGER NOT NULL DEFAULT 0;

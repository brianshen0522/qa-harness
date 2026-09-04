-- CreateEnum
CREATE TYPE "ExplorationStatus" AS ENUM ('running', 'paused', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "ExplorationPhase" AS ENUM ('crawl', 'rwd', 'synthesis');

-- CreateEnum
CREATE TYPE "ObservationKind" AS ENUM ('page_snapshot', 'rwd_issue', 'access_denied', 'access_granted', 'finding', 'deep_note');

-- CreateTable
CREATE TABLE "target_identities" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "credential_keys" TEXT[],
    "login_config" JSONB NOT NULL DEFAULT '{}',
    "is_anonymous" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "target_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exploration_runs" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "status" "ExplorationStatus" NOT NULL DEFAULT 'running',
    "config" JSONB NOT NULL DEFAULT '{}',
    "progress" JSONB,
    "paused_reason" TEXT,
    "error" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "llm_calls" INTEGER NOT NULL DEFAULT 0,
    "triggered_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "exploration_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_nodes" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "route_key" TEXT NOT NULL,
    "sample_url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "reachable_by" TEXT[],
    "denied_for" TEXT[],
    "kind" TEXT NOT NULL DEFAULT 'page',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_edges" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "from_id" TEXT NOT NULL,
    "to_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'link',
    "label" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_observations" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT,
    "identity_id" TEXT,
    "kind" "ObservationKind" NOT NULL,
    "breakpoint" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "screenshot_key" TEXT,
    "severity" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "target_identities_target_id_name_key" ON "target_identities"("target_id", "name");

-- CreateIndex
CREATE INDEX "exploration_runs_target_id_started_at_idx" ON "exploration_runs"("target_id", "started_at");

-- CreateIndex
CREATE INDEX "site_nodes_run_id_idx" ON "site_nodes"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "site_nodes_run_id_route_key_key" ON "site_nodes"("run_id", "route_key");

-- CreateIndex
CREATE INDEX "site_edges_run_id_idx" ON "site_edges"("run_id");

-- CreateIndex
CREATE INDEX "site_observations_run_id_kind_idx" ON "site_observations"("run_id", "kind");

-- CreateIndex
CREATE INDEX "site_observations_node_id_idx" ON "site_observations"("node_id");

-- AddForeignKey
ALTER TABLE "target_identities" ADD CONSTRAINT "target_identities_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exploration_runs" ADD CONSTRAINT "exploration_runs_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_nodes" ADD CONSTRAINT "site_nodes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "exploration_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_edges" ADD CONSTRAINT "site_edges_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "exploration_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_edges" ADD CONSTRAINT "site_edges_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "site_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_edges" ADD CONSTRAINT "site_edges_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "site_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_observations" ADD CONSTRAINT "site_observations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "exploration_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_observations" ADD CONSTRAINT "site_observations_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "site_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_observations" ADD CONSTRAINT "site_observations_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "target_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

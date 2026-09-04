-- CreateEnum
CREATE TYPE "Scope" AS ENUM ('project', 'target');

-- CreateEnum
CREATE TYPE "DiscussionRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('pending', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "AttachmentSource" AS ENUM ('url', 'file', 'handoff');

-- CreateEnum
CREATE TYPE "HandoffApplyMode" AS ENUM ('overwrite', 'merge', 'attachment');

-- CreateTable
CREATE TABLE "discussions" (
    "id" TEXT NOT NULL,
    "scope" "Scope" NOT NULL,
    "project_id" TEXT,
    "target_id" TEXT,
    "completeness" JSONB NOT NULL DEFAULT '{}',
    "draft" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discussions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_messages" (
    "id" TEXT NOT NULL,
    "discussion_id" TEXT NOT NULL,
    "role" "DiscussionRole" NOT NULL,
    "content" TEXT NOT NULL,
    "structured" JSONB,
    "references" JSONB,
    "llm_config_id" TEXT,
    "model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target_proposals" (
    "id" TEXT NOT NULL,
    "discussion_id" TEXT NOT NULL,
    "message_id" TEXT,
    "kind" "TargetKind" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "credential_keys" TEXT[],
    "rationale" TEXT NOT NULL DEFAULT '',
    "status" "ProposalStatus" NOT NULL DEFAULT 'pending',
    "created_target_id" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "target_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_attachments" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_type" "AttachmentSource" NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL DEFAULT 'text/plain',
    "url" TEXT,
    "storage_key" TEXT,
    "text_content" TEXT,
    "byte_size" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handoff_documents" (
    "id" TEXT NOT NULL,
    "scope" "Scope" NOT NULL,
    "project_id" TEXT,
    "target_id" TEXT,
    "raw_content" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "harness_version" TEXT NOT NULL,
    "apply_mode" "HandoffApplyMode" NOT NULL,
    "imported_by" TEXT NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_to_description_version" INTEGER,

    CONSTRAINT "handoff_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discussions_project_id_key" ON "discussions"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "discussions_target_id_key" ON "discussions"("target_id");

-- CreateIndex
CREATE INDEX "discussion_messages_discussion_id_created_at_idx" ON "discussion_messages"("discussion_id", "created_at");

-- CreateIndex
CREATE INDEX "project_attachments_project_id_created_at_idx" ON "project_attachments"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "handoff_documents_project_id_imported_at_idx" ON "handoff_documents"("project_id", "imported_at");

-- CreateIndex
CREATE INDEX "handoff_documents_target_id_imported_at_idx" ON "handoff_documents"("target_id", "imported_at");

-- AddForeignKey
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_discussion_id_fkey" FOREIGN KEY ("discussion_id") REFERENCES "discussions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target_proposals" ADD CONSTRAINT "target_proposals_discussion_id_fkey" FOREIGN KEY ("discussion_id") REFERENCES "discussions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_documents" ADD CONSTRAINT "handoff_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_documents" ADD CONSTRAINT "handoff_documents_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

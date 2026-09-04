-- CreateEnum
CREATE TYPE "SkillScope" AS ENUM ('global', 'project');

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "scope" "SkillScope" NOT NULL DEFAULT 'global',
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skills_scope_enabled_idx" ON "skills"("scope", "enabled");

-- CreateIndex
CREATE INDEX "skills_project_id_idx" ON "skills"("project_id");

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "McpScope" AS ENUM ('global', 'project');

-- CreateTable
CREATE TABLE "mcp_servers" (
    "id" TEXT NOT NULL,
    "scope" "McpScope" NOT NULL DEFAULT 'global',
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "auth_encrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tools_cache" JSONB NOT NULL DEFAULT '[]',
    "last_checked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_servers_scope_enabled_idx" ON "mcp_servers"("scope", "enabled");

-- CreateIndex
CREATE INDEX "mcp_servers_project_id_idx" ON "mcp_servers"("project_id");

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

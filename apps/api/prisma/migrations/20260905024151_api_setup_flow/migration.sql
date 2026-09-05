-- CreateTable
CREATE TABLE "api_setups" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_setups_target_id_key" ON "api_setups"("target_id");

-- AddForeignKey
ALTER TABLE "api_setups" ADD CONSTRAINT "api_setups_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "qa_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

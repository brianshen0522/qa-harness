-- CreateTable
CREATE TABLE "feature_setups" (
    "id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feature_setups_feature_id_key" ON "feature_setups"("feature_id");

-- AddForeignKey
ALTER TABLE "feature_setups" ADD CONSTRAINT "feature_setups_feature_id_fkey" FOREIGN KEY ("feature_id") REFERENCES "features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

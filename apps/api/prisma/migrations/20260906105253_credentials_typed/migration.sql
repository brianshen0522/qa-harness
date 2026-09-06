-- Typed/paired credentials. A `password` credential binds username+password;
-- other types hold a single secret. Existing rows become single `other` secrets
-- so nothing referencing {{key}} breaks.

CREATE TYPE "CredentialType" AS ENUM ('password', 'api_key', 'bearer_token', 'cookie', 'other');

ALTER TABLE "qa_target_credentials"
  ADD COLUMN "type" "CredentialType" NOT NULL DEFAULT 'other',
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "fields" JSONB NOT NULL DEFAULT '{}';

-- Preserve every existing secret as a single-value credential.
UPDATE "qa_target_credentials"
  SET "fields" = jsonb_build_object('value', "encrypted_value")
  WHERE "encrypted_value" IS NOT NULL;

ALTER TABLE "qa_target_credentials" DROP COLUMN "encrypted_value";

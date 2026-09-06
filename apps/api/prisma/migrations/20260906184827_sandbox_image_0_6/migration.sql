-- Sandbox image 0.6: the DOM probe now reports visible alert/error messages.
-- Only move installs that are still on the previous default; a custom image is left alone.
ALTER TABLE "sandbox_settings" ALTER COLUMN "image" SET DEFAULT 'qa-harness-sandbox:0.6';
UPDATE "sandbox_settings" SET "image" = 'qa-harness-sandbox:0.6' WHERE "image" = 'qa-harness-sandbox:0.5';

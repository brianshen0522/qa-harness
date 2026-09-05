-- Unify admin accounts into the user model: admin is now a role (is_admin) on User.

-- 1) Add the flag.
ALTER TABLE "users" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;

-- 2) Promote users whose email matches an existing admin.
UPDATE "users" u SET "is_admin" = true
FROM "admins" a WHERE lower(u."email") = lower(a."email");

-- 3) Create user rows for admins that have no user yet (so no admin is lost).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
INSERT INTO "users" ("id", "email", "name", "auth_provider", "status", "is_admin", "created_at")
SELECT gen_random_uuid()::text, lower(a."email"), a."email", 'admin-migrated', 'active'::"UserStatus", true, now()
FROM "admins" a
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE lower(u."email") = lower(a."email"));

-- 4) Drop the separate admin table.
DROP TABLE "admins";

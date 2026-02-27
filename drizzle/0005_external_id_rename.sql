-- Rename clerk_org_id to external_id in orgs table
ALTER TABLE "orgs" RENAME COLUMN "clerk_org_id" TO "external_id";--> statement-breakpoint
-- Rename clerk_user_id to external_id in users table
ALTER TABLE "users" RENAME COLUMN "clerk_user_id" TO "external_id";--> statement-breakpoint
-- Drop old indexes
DROP INDEX IF EXISTS "idx_orgs_clerk_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_users_clerk_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_users_app_email";--> statement-breakpoint
-- Create new composite indexes (app_id + external_id)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_orgs_app_external_id" ON "orgs" USING btree ("app_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_app_external_id" ON "users" USING btree ("app_id","external_id");

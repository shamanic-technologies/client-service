-- Remove app_id column from orgs and users tables
-- Drop old composite indexes
DROP INDEX IF EXISTS "idx_orgs_app_external_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_users_app_external_id";--> statement-breakpoint
-- Create new unique indexes on external_id only
CREATE UNIQUE INDEX IF NOT EXISTS "idx_orgs_external_id" ON "orgs" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_external_id" ON "users" USING btree ("external_id");--> statement-breakpoint
-- Drop app_id columns
ALTER TABLE "orgs" DROP COLUMN IF EXISTS "app_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "app_id";

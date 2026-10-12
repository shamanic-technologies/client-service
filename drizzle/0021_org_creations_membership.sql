-- Whether the acting user of POST /internal/orgs was made an admin of the new
-- Clerk org (`admin`) or Clerk did not know them and the org was created with no
-- member yet (`none`). Served back on an idempotent replay.
ALTER TABLE "org_creations" ADD COLUMN IF NOT EXISTS "acting_user_membership" text DEFAULT 'admin' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_creations" DROP CONSTRAINT IF EXISTS "org_creations_acting_user_membership_check";
--> statement-breakpoint
ALTER TABLE "org_creations" ADD CONSTRAINT "org_creations_acting_user_membership_check" CHECK ("acting_user_membership" IN ('admin', 'none'));

-- An organization created for a NEW CLIENT on a staff member's behalf
-- (POST /internal/orgs, reached through the distribute MCP). One row per org
-- created that way: who asked for it, and the caller's idempotency key, so a
-- retry with the same key returns the same org instead of a second one.
-- Cascades with the org: a torn-down org leaves no row naming it.

CREATE TABLE IF NOT EXISTS "org_creations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "created_by_user_id" uuid NOT NULL,
  "idempotency_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_org_creations_org" ON "org_creations" ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_org_creations_key" ON "org_creations" ("created_by_user_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

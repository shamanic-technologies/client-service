-- Wave 0.5 (DIS-64): invite-only gate + waitlist storage.
-- Cap = 3 invites per org, counted on rows where status = 'signed_up'.
-- 'pending' and 'expired' values reserved for future flows.

CREATE TABLE IF NOT EXISTS "invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "inviter_org_id" uuid NOT NULL REFERENCES "orgs"("id"),
  "invitee_org_id" uuid REFERENCES "orgs"("id"),
  "code" text NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "signed_up_at" timestamptz,
  CONSTRAINT "invites_status_check" CHECK ("status" IN ('pending', 'signed_up', 'expired'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_invites_inviter_invitee_unique"
  ON "invites" ("inviter_org_id", "invitee_org_id")
  WHERE "invitee_org_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_invites_code" ON "invites" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invites_inviter_org_id" ON "invites" ("inviter_org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "waitlist" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL UNIQUE,
  "brand_url" text,
  "position" serial NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- SIGNUP FACTS: "a real person signed up to distribute.you" stated as a dated,
-- append-only fact other services copy (crm-service's people fact feed, then
-- lead-service, for the distribute.you brand's own sales funnel).
--
-- One `signup` per real org, EVER: an org becomes real once (created
-- non-anonymous, or claimed) and never becomes real again after it stops being
-- real (torn down, absorbed). A correction is a `withdrawn` row naming the fact
-- it corrects, never a delete or an UPDATE: a consumer copies each row once.
-- No FK to orgs on purpose: the fact must outlive the org it is about.

CREATE TABLE IF NOT EXISTS "signup_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" bigserial NOT NULL,
  "type" text NOT NULL,
  "brand_id" uuid NOT NULL,
  "customer_org_id" uuid NOT NULL,
  "clerk_org_id" text,
  "user_id" uuid,
  "clerk_user_id" text,
  "email" text,
  "first_name" text,
  "last_name" text,
  "phone" text,
  "occurred_at" timestamp with time zone NOT NULL,
  "date_basis" text NOT NULL,
  "withdrawn_of" uuid REFERENCES "signup_facts"("id"),
  "withdrawn_reason" text,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "signup_facts_type_check" CHECK ("type" IN ('signup', 'withdrawn')),
  CONSTRAINT "signup_facts_withdrawn_shape" CHECK (
    ("type" = 'withdrawn') = ("withdrawn_of" IS NOT NULL AND "withdrawn_reason" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_signup_facts_seq" ON "signup_facts" ("seq");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_signup_facts_one_signup_per_org" ON "signup_facts" ("customer_org_id") WHERE "type" = 'signup';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_signup_facts_one_withdrawal" ON "signup_facts" ("withdrawn_of") WHERE "withdrawn_of" IS NOT NULL;
--> statement-breakpoint
-- A real org whose person could not be named (its identity-provider org is gone,
-- or never existed). Looked at again once a day, so the minute tick does not ask
-- the identity provider about the same orgs forever.
CREATE TABLE IF NOT EXISTS "signup_fact_unresolved" (
  "org_id" uuid PRIMARY KEY NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "checked_at" timestamp with time zone DEFAULT now() NOT NULL
);

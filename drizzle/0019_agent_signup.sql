-- An AI agent opens an account by itself: email + phone, a one-time code sent
-- to the email, no browser and no human (owner 2026-10-12).
--
-- agent_signup_codes: one row per code SENT. A new request supersedes every
-- earlier live code for the same email, so at most one code per email can be
-- redeemed at a time. Only a hash of the code is stored. `attempts` counts wrong
-- guesses against THIS code; past the limit the code is dead and a new one must
-- be requested. `consumed_at` is set once the account was provisioned (or
-- returned) for it. `phone` is the urgent-contact number the agent supplied,
-- format-checked only, never verified; it travels to the user row at completion.

CREATE TABLE IF NOT EXISTS "agent_signup_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "phone" text NOT NULL,
  "code_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "superseded_at" timestamp with time zone,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_signup_codes_email_lower" CHECK ("email" = lower("email")),
  CONSTRAINT "agent_signup_codes_attempts_nonneg" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_signup_codes_email" ON "agent_signup_codes" ("email", "created_at");
--> statement-breakpoint
-- The person's urgent-contact phone (WhatsApp), as stated by the agent that
-- signed them up. NOT `users.phone`: that column is the WhatsApp channel's
-- mapping key (unique, it decides whose account an inbound message lands in),
-- and an unverified number must never be able to route someone else's messages.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "contact_phone" text;
--> statement-breakpoint
ALTER TABLE "org_acquisitions" DROP CONSTRAINT IF EXISTS "org_acquisitions_recorded_via_check";
--> statement-breakpoint
ALTER TABLE "org_acquisitions" ADD CONSTRAINT "org_acquisitions_recorded_via_check" CHECK ("recorded_via" IN ('resolve', 'org_id', 'external_ids', 'absorbed_shell', 'agent_signup'));

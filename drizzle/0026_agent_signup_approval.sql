-- An AI agent with no inbox access finishes signup once the inbox owner clicks
-- a link, whenever they click it (RFC 8628 device-grant shape): the start
-- returns a poll token to the agent, the email carries an approval link, and
-- the agent polls /complete with its poll token. Both secrets are 256-bit and
-- stored hashed. The phone becomes optional (data minimisation): a NULL phone
-- = the agent gave none.
ALTER TABLE "agent_signup_codes" ALTER COLUMN "phone" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_signup_codes" ADD COLUMN IF NOT EXISTS "poll_token_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_signup_codes" ADD COLUMN IF NOT EXISTS "approval_token_hash" text;
--> statement-breakpoint
ALTER TABLE "agent_signup_codes" ADD COLUMN IF NOT EXISTS "approval_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_signup_codes" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_signup_codes_poll_token" ON "agent_signup_codes" ("poll_token_hash") WHERE "poll_token_hash" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_signup_codes_approval_token" ON "agent_signup_codes" ("approval_token_hash") WHERE "approval_token_hash" IS NOT NULL;

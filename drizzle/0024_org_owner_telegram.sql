-- Where an org's OWNER is reachable on Telegram through the platform bot
-- (src/lib/org-owner-telegram.ts). One row per org, no row = not reachable.
--   target 'linked_chat': the owner linked their own chat (tapped the bot link
--     the dashboard gave them; Telegram sent the bot `/start <code>`).
--   target 'platform_owner_chat': the org's owner IS the platform owner, whose
--     chat the platform bot already holds (TELEGRAM_OWNER_CHAT_ID). No chat id
--     is copied into the row.
-- Cascades with the org: a torn-down org leaves no row naming it.

CREATE TABLE IF NOT EXISTS "org_owner_telegram" (
  "org_id" uuid PRIMARY KEY NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "target" text NOT NULL,
  "chat_id" text,
  "linked_by_user_id" uuid,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_owner_telegram_target_check" CHECK ("target" IN ('linked_chat', 'platform_owner_chat')),
  CONSTRAINT "org_owner_telegram_chat_iff_linked" CHECK (("target" = 'linked_chat') = ("chat_id" IS NOT NULL))
);
--> statement-breakpoint
-- One-time codes behind the bot link. Only the hash is stored; a code is good
-- once, for 30 minutes.
CREATE TABLE IF NOT EXISTS "org_owner_telegram_link_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "code_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_chat_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_org_owner_telegram_link_codes_hash" ON "org_owner_telegram_link_codes" ("code_hash");
--> statement-breakpoint
-- The recorded fact for distribute.you's own org (the org holding the
-- distribute.you brand): its owner is the platform owner. A no-op on any
-- database without that org.
INSERT INTO "org_owner_telegram" ("org_id", "target")
SELECT "id", 'platform_owner_chat' FROM "orgs" WHERE "id" = 'f0420eb5-8f72-4f0a-a150-f473746df1e6'
ON CONFLICT ("org_id") DO NOTHING;

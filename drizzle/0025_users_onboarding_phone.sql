-- The phone number a person typed on onboarding (Clerk publicMetadata.phone),
-- mirrored here so the WhatsApp phone resolution can find their account.
-- NOT unique and NOT users.phone: a typed number alone proves nothing, and two
-- people can type the same number. It resolves only when exactly one user holds
-- it and no WhatsApp-linked users.phone does (src/lib/onboarding-phone.ts).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_phone" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_onboarding_phone" ON "users" ("onboarding_phone");

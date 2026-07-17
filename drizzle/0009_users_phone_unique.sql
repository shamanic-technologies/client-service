-- Channel-origin (WhatsApp/phone) signups: enforce one account per phone number.
-- Postgres treats NULLs as distinct in a unique index, so the many existing users
-- with NULL phone are unaffected; uniqueness is enforced only across non-null
-- phone values. This index is the arbiter for idempotent phone-account provisioning.

CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_phone" ON "users" ("phone");--> statement-breakpoint

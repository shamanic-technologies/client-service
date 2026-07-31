-- Referral offer: a recorded claim must durably reach billing-service, which
-- opens the invitee's free-credit promise and remembers the inviter to pay on
-- conversion. The claim endpoint is idempotent per (code, invitee) and may fire
-- more than once, so the notification needs its own delivery marker: this column
-- is set only after billing-service acknowledges. A claim whose billing call
-- failed leaves it NULL, so the next (idempotent) claim retries the notification
-- instead of silently skipping it -- and a claim that already notified never
-- fires a second time.

ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "billing_notified_at" timestamp with time zone;--> statement-breakpoint

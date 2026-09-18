-- The signup wall moves to the END of onboarding: a visitor walks their whole
-- setup before creating an account. The signed-out phase is an ORDINARY org --
-- one whose external identity is a throwaway id the dashboard mints instead of
-- a Clerk org id -- so brands, funnels, audiences, runs and spend are written
-- against it exactly as for any customer. At signup the visitor gets a real
-- Clerk organisation, and the two must become one org WITHOUT moving any of
-- that work: we keep the internal uuid (every existing reference resolves
-- through it) and swap the external identity underneath it.
--
-- Two timestamps carry the whole transition, and they answer two different
-- questions that must not be conflated:
--
--   anonymous_at -- this org came into being WITHOUT an identity provider. It
--     is written at creation, by us, on the caller's declaration. It is never
--     inferred by inspecting external_id: a guard for WHERE a row came from
--     cannot be a sniff of what the row happens to look like, or the day a
--     throwaway id resembles a real one it hands a stranger an organisation.
--
--   claimed_at -- a real identity has been attached. NULL on an org still
--     anonymous; non-NULL is the one fact that makes a second claim a replay
--     rather than a takeover.
--
-- Legacy rows have both NULL: they were never throwaway orgs, so they can
-- never be claimed, which is exactly the refusal we want for them.

ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "anonymous_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;--> statement-breakpoint
-- An org cannot have been claimed unless it was anonymous in the first place.
ALTER TABLE "orgs" DROP CONSTRAINT IF EXISTS "orgs_claimed_requires_anonymous";--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_claimed_requires_anonymous" CHECK ("claimed_at" IS NULL OR "anonymous_at" IS NOT NULL);

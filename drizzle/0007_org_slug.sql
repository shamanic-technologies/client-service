-- Add slug column to orgs.
-- The slug is the Clerk organization slug (e.g. "stripe-com" from
-- createOrganization({ name: "Stripe" })). It doubles as the invite code in
-- the Wave 0.5 invite-only flow.
--
-- Backfill strategy: for each existing org with a non-NULL name, derive a
-- candidate slug using Clerk's algorithm (lowercase, replace any non
-- alphanumeric run with '-', trim leading/trailing '-'). Apply only when the
-- candidate is unique across the table; duplicates and edge cases stay NULL
-- and will be backfilled by api-service on the next POST /internal/resolve
-- (which now accepts an orgSlug field).

ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "slug" text;--> statement-breakpoint

WITH candidates AS (
  SELECT
    id,
    NULLIF(
      TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '-', 'g')),
      ''
    ) AS proposed_slug
  FROM orgs
  WHERE slug IS NULL AND name IS NOT NULL
),
uniques AS (
  SELECT proposed_slug
  FROM candidates
  WHERE proposed_slug IS NOT NULL
  GROUP BY proposed_slug
  HAVING COUNT(*) = 1
)
UPDATE orgs
SET slug = c.proposed_slug
FROM candidates c
WHERE orgs.id = c.id
  AND c.proposed_slug IN (SELECT proposed_slug FROM uniques);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_orgs_slug" ON "orgs" ("slug") WHERE "slug" IS NOT NULL;

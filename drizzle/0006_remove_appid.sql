-- Remove app_id column from orgs and users tables

-- Step 1: Deduplicate users before creating unique index on external_id.
-- Under the old schema (composite unique on app_id + external_id), the same
-- external_id could exist in multiple rows with different app_ids. Merge
-- all profile data into the oldest row per external_id, then delete the rest.
-- Uses aggregation to correctly handle 2+ duplicates in a single pass.
WITH aggregated AS (
  SELECT
    external_id,
    (array_agg(id ORDER BY created_at ASC))[1] AS keep_id,
    (array_remove(array_agg(org_id ORDER BY created_at ASC), NULL))[1] AS org_id,
    (array_remove(array_agg(email ORDER BY created_at ASC), NULL))[1] AS email,
    (array_remove(array_agg(first_name ORDER BY created_at ASC), NULL))[1] AS first_name,
    (array_remove(array_agg(last_name ORDER BY created_at ASC), NULL))[1] AS last_name,
    (array_remove(array_agg(image_url ORDER BY created_at ASC), NULL))[1] AS image_url,
    (array_remove(array_agg(phone ORDER BY created_at ASC), NULL))[1] AS phone
  FROM users
  WHERE external_id IS NOT NULL
  GROUP BY external_id
  HAVING COUNT(*) > 1
)
UPDATE users
SET
  org_id = aggregated.org_id,
  email = aggregated.email,
  first_name = aggregated.first_name,
  last_name = aggregated.last_name,
  image_url = aggregated.image_url,
  phone = aggregated.phone
FROM aggregated
WHERE users.id = aggregated.keep_id;--> statement-breakpoint

-- Delete newer duplicate rows (keep the oldest per external_id)
DELETE FROM users
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY external_id ORDER BY created_at ASC
    ) AS rn
    FROM users
    WHERE external_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint

-- Step 2: Same deduplication for orgs
WITH aggregated AS (
  SELECT
    external_id,
    (array_agg(id ORDER BY created_at ASC))[1] AS keep_id,
    (array_remove(array_agg(name ORDER BY created_at ASC), NULL))[1] AS name,
    (array_remove(array_agg(metadata ORDER BY created_at ASC), NULL))[1] AS metadata
  FROM orgs
  WHERE external_id IS NOT NULL
  GROUP BY external_id
  HAVING COUNT(*) > 1
)
UPDATE orgs
SET
  name = aggregated.name,
  metadata = aggregated.metadata
FROM aggregated
WHERE orgs.id = aggregated.keep_id;--> statement-breakpoint

DELETE FROM orgs
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY external_id ORDER BY created_at ASC
    ) AS rn
    FROM orgs
    WHERE external_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);--> statement-breakpoint

-- Step 3: Drop old composite indexes
DROP INDEX IF EXISTS "idx_orgs_app_external_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_users_app_external_id";--> statement-breakpoint

-- Step 4: Create new unique indexes on external_id only
CREATE UNIQUE INDEX IF NOT EXISTS "idx_orgs_external_id" ON "orgs" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_external_id" ON "users" USING btree ("external_id");--> statement-breakpoint

-- Step 5: Drop app_id columns
ALTER TABLE "orgs" DROP COLUMN IF EXISTS "app_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "app_id";

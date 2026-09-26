-- The reward ledger moves from the SALES FUNNEL to the OFFER (distribute.you#4413,
-- wave C3). The product retired the funnel: a brand states its conversion rates
-- per LEG (brand grain) and its lifetime revenue per OFFER, and brand-service is
-- dropping the read-only funnel route this ledger was built on. So the one reward
-- task becomes `offer_economics_refresh`, one per (org, offer): refresh the money
-- numbers every figure the product shows this customer is computed from.
--
-- CLOCKS ARE CARRIED, NOT RESET. A customer whose refresh was owed yesterday is
-- still owed it today. Each offer keeps the EARLIEST clock of the funnels it had
-- (if any funnel of the offer was due, the offer is due), with its provenance.
--
-- The fingerprint is set to NULL on those carried rows: it was taken over a
-- funnel's content and cannot be compared with an offer's. NULL means "clock
-- carried from the retired grain, content not yet read at this one", and the
-- first read at the offer grain adopts the fingerprint WITHOUT completing
-- anything — otherwise the mere change of shape would read as a refresh and pay.
--
-- The retired bronze table `reward_funnel_observations` is left in place, frozen
-- (no writer, no reader): it is the evidence behind completions already paid.

ALTER TABLE "reward_task_states" ALTER COLUMN "content_fingerprint" DROP NOT NULL;--> statement-breakpoint

-- One keeper per (org, offer): the row with the earliest clock.
CREATE TEMP TABLE "reward_offer_keepers" AS
SELECT DISTINCT ON ("org_id", "offer_id") "id", "org_id", "offer_id"
FROM "reward_task_states"
ORDER BY "org_id", "offer_id", "content_changed_at" ASC, "id" ASC;--> statement-breakpoint

-- Completions of the other funnels of the offer move to the keeper, so nothing
-- already paid is lost when the extra rows go.
UPDATE "reward_task_completions" rc
SET "reward_task_state_id" = k."id"
FROM "reward_task_states" s
JOIN "reward_offer_keepers" k ON k."org_id" = s."org_id" AND k."offer_id" = s."offer_id"
WHERE rc."reward_task_state_id" = s."id" AND s."id" <> k."id";--> statement-breakpoint

DELETE FROM "reward_task_states" s
WHERE NOT EXISTS (SELECT 1 FROM "reward_offer_keepers" k WHERE k."id" = s."id");--> statement-breakpoint

DROP TABLE "reward_offer_keepers";--> statement-breakpoint

UPDATE "reward_task_states"
SET "task_key" = 'offer_economics_refresh', "content_fingerprint" = NULL;--> statement-breakpoint

UPDATE "reward_task_completions" SET "task_key" = 'offer_economics_refresh';--> statement-breakpoint

-- The gold view reads the column being dropped, so it goes first and comes back
-- identical minus that column.
DROP VIEW IF EXISTS "reward_task_status";--> statement-breakpoint

DROP INDEX IF EXISTS "idx_reward_task_states_scope";--> statement-breakpoint

ALTER TABLE "reward_task_states" DROP COLUMN IF EXISTS "funnel_key";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_reward_task_states_offer"
  ON "reward_task_states" ("org_id", "offer_id", "task_key");--> statement-breakpoint

-- BRONZE at the offer grain: what brand-service served for one offer's money
-- content (its lifetime revenue plus the brand's stated leg rates), verbatim,
-- appended only when that content differs from the last row.
CREATE TABLE IF NOT EXISTS "reward_offer_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "content_fingerprint" text NOT NULL,
  "payload" jsonb NOT NULL,
  -- The latest statedAt the producer served for this content, kept for
  -- forensics. It also moves when a number is re-saved unchanged, so it is never
  -- a confirmation signal.
  "producer_stated_at" timestamp with time zone,
  "observed_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reward_offer_obs_offer"
  ON "reward_offer_observations" ("org_id", "offer_id", "observed_at" DESC);--> statement-breakpoint

CREATE OR REPLACE VIEW "reward_task_status" AS
SELECT
  s."id"                          AS "reward_task_state_id",
  s."org_id",
  s."brand_id",
  s."offer_id",
  s."task_key",
  s."content_fingerprint",
  s."content_changed_at",
  s."content_changed_provenance",
  "reward_task_due_at"(s."content_changed_at")        AS "due_at",
  (now() >= "reward_task_due_at"(s."content_changed_at")) AS "is_due",
  c."last_completed_at",
  COALESCE(c."completed_count", 0)                    AS "completed_count"
FROM "reward_task_states" s
LEFT JOIN LATERAL (
  SELECT
    max(rc."completed_at") AS "last_completed_at",
    count(*)               AS "completed_count"
  FROM "reward_task_completions" rc
  WHERE rc."reward_task_state_id" = s."id"
) c ON true;

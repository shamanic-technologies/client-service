-- Reward-task ledger, layered bronze / silver / gold.
--
-- client-service is the identity root and the only place in the fleet that
-- remembers a customer's product tasks, so the ledger lives here. The FIRST
-- granularity is the SALES FUNNEL and the FIRST task is `sales_funnel_refresh`:
-- a funnel's own money numbers (its conversion rates, its lifetime revenue, its
-- destination and booking links) go stale, and every figure the product shows
-- that customer is computed from them.
--
-- BRONZE (`reward_funnel_observations`) — what brand-service actually served us
-- for one funnel, verbatim, at the moment its money content differed from the
-- last thing we stored. An identical re-read carries no new information and is
-- not appended (the dashboard re-reads this on every funnel page load), so the
-- table is the change log of the content, not a log of our HTTP traffic.
--
-- SILVER (`reward_task_states`) — one canonical row per (org, offer, funnel,
-- task): the fingerprint we last saw, WHEN the money content last genuinely
-- changed, and how we know that (`observed` = we saw it change; `producer_ts` =
-- the first time we ever looked, so the best anchor available was the producer's
-- own updatedAt).
--
-- GOLD (`reward_task_status`) — the serving view: is this task DUE, since WHEN,
-- and when was it last DONE. The 30-day refresh interval is defined HERE and
-- nowhere else, so the read and the write decision cannot drift apart.
--
-- `reward_task_completions` is the money-facing ledger: one row per completed
-- window, carrying the delivery marker for billing-service. A completion is the
-- unit billing pays for, and its id IS the `completionId` we hand billing.

CREATE TABLE IF NOT EXISTS "reward_funnel_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "funnel_key" text NOT NULL,
  -- sha256 over the MONEY CONTENT only. `active` and the producer's `updatedAt`
  -- are deliberately excluded: switching a funnel off and on again moves both
  -- and changes not one number the customer was asked to refresh.
  "content_fingerprint" text NOT NULL,
  -- The funnel object brand-service served, verbatim.
  "payload" jsonb NOT NULL,
  -- The producer's own last-touched timestamp, kept for forensics. NOT a
  -- confirmation signal: a toggle moves it with nobody having looked at a number.
  "producer_updated_at" timestamp with time zone,
  "observed_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reward_funnel_obs_funnel"
  ON "reward_funnel_observations" ("org_id", "offer_id", "funnel_key", "observed_at" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reward_task_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "funnel_key" text NOT NULL,
  "task_key" text NOT NULL,
  "content_fingerprint" text NOT NULL,
  -- When the money content last genuinely changed. The clock the 30 days run from.
  "content_changed_at" timestamp with time zone NOT NULL,
  -- 'observed'    : we compared two readings and they differed. Ours, certain.
  -- 'producer_ts' : first sighting, so we fell back to the producer's updatedAt.
  --                 It is an UPPER bound on the real change time (a toggle only
  --                 ever moves it later), so the task comes due no EARLIER than
  --                 it should. We never invent an earlier date to pay sooner.
  "content_changed_provenance" text NOT NULL,
  "first_observed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_observed_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "reward_task_states_provenance_check"
    CHECK ("content_changed_provenance" IN ('observed', 'producer_ts'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_reward_task_states_scope"
  ON "reward_task_states" ("org_id", "offer_id", "funnel_key", "task_key");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reward_task_states_brand"
  ON "reward_task_states" ("org_id", "brand_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reward_task_completions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "reward_task_state_id" uuid NOT NULL
    REFERENCES "reward_task_states"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL,
  "task_key" text NOT NULL,
  -- The window this completion closed: the instant the task had become due.
  -- One completion per window, enforced below, is what makes $1 paid exactly
  -- once however many times the customer saves in that window.
  "due_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reward_cents" integer NOT NULL,
  -- Written ONLY after billing-service acknowledges. NULL means the money side
  -- has not heard about this completion: the next read retries it. Never set
  -- before the call succeeds, or a crash between the two would mark a payment
  -- delivered that never was.
  "billing_notified_at" timestamp with time zone,
  CONSTRAINT "reward_task_completions_reward_positive" CHECK ("reward_cents" > 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_reward_task_completions_window"
  ON "reward_task_completions" ("reward_task_state_id", "due_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reward_task_completions_undelivered"
  ON "reward_task_completions" ("org_id")
  WHERE "billing_notified_at" IS NULL;--> statement-breakpoint

-- The refresh cadence, defined ONCE for the whole service. The serving view
-- below and the completion decision in src/lib/reward-tasks.ts both go through
-- this function, so "is it due" cannot come to mean two different things.
CREATE OR REPLACE FUNCTION "reward_task_due_at"("content_changed_at" timestamp with time zone)
RETURNS timestamp with time zone
LANGUAGE sql IMMUTABLE
AS $$ SELECT "content_changed_at" + interval '30 days' $$;--> statement-breakpoint

-- GOLD. The single definition of DUE in the whole service: the read below and
-- the write decision in src/lib/reward-tasks.ts both go through this view, so
-- "is it due" cannot mean two things.
CREATE OR REPLACE VIEW "reward_task_status" AS
SELECT
  s."id"                          AS "reward_task_state_id",
  s."org_id",
  s."brand_id",
  s."offer_id",
  s."funnel_key",
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
) c ON true;--> statement-breakpoint

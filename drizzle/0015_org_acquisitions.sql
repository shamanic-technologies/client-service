-- Which acquisition channel brought an organisation: its FIRST TOUCH.
--
-- One row per org, written once and never updated. The dashboard knows in the
-- visitor's browser where they first came from (utm, referrer, landing path,
-- homepage variant, a Google Ads click, a partner referral link, and a channel
-- it derives from those) and hands it over at the two moments an org comes into
-- being. The first hand-over wins; every later one is accepted and ignored, so
-- a second visit can never move the credit.
--
-- Keyed on the INTERNAL org uuid, which a claim never changes: an anonymous org
-- that is later claimed keeps the touch recorded while it was anonymous.
--
-- Every value is untrusted text from a browser-derived cookie. No enum on
-- `channel`: a channel the dashboard learns to derive tomorrow must still be
-- stored rather than refused. "direct" and "unknown" are real answers the
-- dashboard sends; an org with NO row is "we never recorded anything" (every
-- org created before this table). No backfill: nothing is invented for them.

CREATE TABLE IF NOT EXISTS "org_acquisitions" (
  "org_id" uuid PRIMARY KEY NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_content" text,
  "utm_term" text,
  "referrer" text,
  "landing_path" text,
  "homepage_variant" text,
  "gclid" text,
  "referral_code" text,
  "first_seen_at" timestamp with time zone,
  "recorded_via" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_acquisitions_recorded_via_check" CHECK ("recorded_via" IN ('resolve', 'org_id', 'external_ids', 'absorbed_shell'))
);

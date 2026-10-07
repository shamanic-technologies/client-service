-- A user's OWN LinkedIn profile, resolved once from a recorded fact about the
-- person (their email) and reused. One row per user.
--
-- `status` is the answer: `found` carries the profile URL, `none_found` carries
-- the reason (never a guess: a weak vendor match is none_found). NO row means
-- "not looked up yet", which is a different answer from none_found.
--
-- `matched_on_email` is the email the answer was resolved FOR. When the user's
-- email changes the row no longer answers for them and the next resolve asks
-- again. NULL = the user had no email on record (none_found, no vendor asked).

CREATE TABLE IF NOT EXISTS "user_linkedin_profiles" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "linkedin_url" text,
  "none_found_reason" text,
  "source" text NOT NULL,
  "matched_on_email" text,
  "match_confidence" text,
  "apollo_person_id" text,
  "vendor_response" jsonb,
  "resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_linkedin_profiles_status_check" CHECK ("status" IN ('found', 'none_found')),
  CONSTRAINT "user_linkedin_profiles_found_has_url" CHECK (("status" = 'found') = ("linkedin_url" IS NOT NULL)),
  CONSTRAINT "user_linkedin_profiles_none_has_reason" CHECK (("status" = 'none_found') = ("none_found_reason" IS NOT NULL)),
  CONSTRAINT "user_linkedin_profiles_source_check" CHECK ("source" IN ('apollo_people_match_by_email', 'user_record'))
);

-- Absorbing an org hands over the WHOLE identity, not the half named external_id.
--
-- An identity-provider organisation carries a slug as well as an id, and this
-- service holds the slug under a unique index. v0.27.1 took only the external
-- id off a shell, so after an absorb the identity was SPLIT across two rows:
-- the customer's org answered to the id while the shell still held the name.
-- The very next authenticated read upserts the org WITH its slug, collides with
-- the shell, and 500s -- which the gateway turns into a 502 on every page of
-- the product at once. Measured in production on 2026-09-20: 30+ consecutive
-- `duplicate key value violates unique constraint "idx_orgs_slug"` over 90
-- seconds, on the customer the absorb had just rescued.
--
-- Two halves. Release the slug from every row that already handed its identity
-- over, and then say in the schema that a shell holds NEITHER half -- so no
-- future absorb can leave one behind.
--
-- The unique index is not touched: it is doing its job. The absorb was what was
-- incomplete.

UPDATE "orgs" SET "slug" = NULL, "updated_at" = now() WHERE "absorbed_at" IS NOT NULL AND "slug" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" DROP CONSTRAINT IF EXISTS "orgs_absorbed_has_no_identity";--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_absorbed_has_no_identity" CHECK ("absorbed_at" IS NULL OR ("external_id" IS NULL AND "slug" IS NULL));

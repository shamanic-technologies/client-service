-- An identity-provider organisation is ONE organisation. Until now two rows
-- could describe it: the anonymous org the visitor spent ten minutes building,
-- and a second row that came into being moments earlier purely because an
-- authenticated read resolved the identity the visitor had just created. The
-- claim then refused `external_id_taken` -- correctly by its own rule, and
-- wrongly for the customer, who was locked out of their own setup.
--
-- The second row is not another org in any sense a customer would recognise.
-- It was never a decision: nobody declared it anonymous, nobody has ever
-- claimed it, and it holds nothing but the person who just signed up. The claim
-- may therefore take the identity off it and give it to the org that holds the
-- work -- provided it really is that empty, which is checked and never assumed.
--
-- These two columns record that, so a shell is documented rather than silently
-- mutated: which org took its identity, and when.
--
-- ON DELETE SET NULL: the org teardown cascade deletes org rows, and a shell
-- must never stand between a customer and their own deletion.

ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "absorbed_into_org_id" uuid;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "absorbed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orgs" DROP CONSTRAINT IF EXISTS "orgs_absorbed_into_org_id_fkey";--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_absorbed_into_org_id_fkey" FOREIGN KEY ("absorbed_into_org_id") REFERENCES "orgs"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Both halves of the fact, or neither.
ALTER TABLE "orgs" DROP CONSTRAINT IF EXISTS "orgs_absorbed_both_or_neither";--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_absorbed_both_or_neither" CHECK (("absorbed_at" IS NULL) = ("absorbed_into_org_id" IS NULL));--> statement-breakpoint
-- A shell holds no identity: that is what it gave away.
ALTER TABLE "orgs" DROP CONSTRAINT IF EXISTS "orgs_absorbed_has_no_identity";--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_absorbed_has_no_identity" CHECK ("absorbed_at" IS NULL OR "external_id" IS NULL);

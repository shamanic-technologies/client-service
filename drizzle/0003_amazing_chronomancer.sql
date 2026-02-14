ALTER TABLE "anonymous_orgs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "anonymous_users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "anonymous_orgs" CASCADE;--> statement-breakpoint
DROP TABLE "anonymous_users" CASCADE;--> statement-breakpoint
ALTER TABLE "orgs" DROP CONSTRAINT "orgs_clerk_org_id_unique";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_clerk_user_id_unique";--> statement-breakpoint
ALTER TABLE "orgs" ALTER COLUMN "clerk_org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "clerk_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_app_email" ON "users" USING btree ("app_id","email");
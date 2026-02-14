CREATE TABLE IF NOT EXISTS "anonymous_orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"name" text DEFAULT 'Personal' NOT NULL,
	"clerk_org_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anonymous_users" ADD COLUMN "anonymous_org_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "anonymous_users" ADD CONSTRAINT "anonymous_users_anonymous_org_id_anonymous_orgs_id_fk" FOREIGN KEY ("anonymous_org_id") REFERENCES "public"."anonymous_orgs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

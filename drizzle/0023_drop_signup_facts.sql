-- RETIRED: the signup-facts feed (0022). Owner 2026-10-13: our own data comes in
-- through a connector any client can plug, so distribute.you's funnel reads its
-- signups from the Clerk connector (crm-service #129), not from client-service.
-- No reader remained anywhere in the fleet.
DROP TABLE IF EXISTS "signup_fact_unresolved";
--> statement-breakpoint
DROP TABLE IF EXISTS "signup_facts";

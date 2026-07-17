import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  ProvisionPhoneAccountBodySchema,
  ResolvePhoneAccountQuerySchema,
} from "../schemas.js";
import {
  createClerkPhoneAccount,
  deleteClerkOrganization,
  deleteClerkUser,
  ClerkServiceError,
} from "../lib/clerk-client.js";
import { ensureBillingWelcome, BillingServiceError } from "../lib/billing-service-client.js";

const router = Router();

interface PhoneAccountIdentity {
  orgId: string;
  userId: string;
  phone: string;
  clerkOrgId: string;
  clerkUserId: string;
}

/**
 * Resolve a phone number to its existing account identity, joining the user's
 * org for the Clerk ids. Returns null when no account exists for the phone.
 */
async function lookupByPhone(phone: string): Promise<PhoneAccountIdentity | null> {
  const [row] = await db
    .select({
      orgId: orgs.id,
      userId: users.id,
      phone: users.phone,
      clerkOrgId: orgs.externalId,
      clerkUserId: users.externalId,
    })
    .from(users)
    .innerJoin(orgs, eq(users.orgId, orgs.id))
    .where(eq(users.phone, phone))
    .limit(1);

  if (!row) return null;
  return {
    orgId: row.orgId,
    userId: row.userId,
    phone: row.phone ?? phone,
    clerkOrgId: row.clerkOrgId ?? "",
    clerkUserId: row.clerkUserId ?? "",
  };
}

/** Thrown inside the reservation tx when another concurrent call already claimed the phone. */
class PhoneRaceLostError extends Error {}

/**
 * POST /internal/phone-accounts - Provision (or return) an account for a phone.
 *
 * Idempotent per phone. A brand-new phone gets a full signup-equivalent account:
 *   1. Clerk user (phone identifier) + Clerk organization (user administers it).
 *   2. Internal org/user rows mapping the Clerk ids to internal UUIDs, phone stored.
 *   3. billing-service welcome path (welcome credit + Stripe customer) — reused,
 *      never granted here.
 * A known phone short-circuits at step 0 (no Clerk/billing calls).
 *
 * Concurrency: the DB unique index on users.phone is the arbiter. If two first
 * messages race, the loser's just-created Clerk org/user are torn down and the
 * winner's identity is returned — so we never leak a duplicate account.
 *
 * Fail loud: Clerk / billing failures surface as 502 with the upstream error.
 */
router.post("/internal/phone-accounts", requireApiKey, async (req, res) => {
  const parsed = ProvisionPhoneAccountBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const { phone } = parsed.data;

  try {
    // 0. Fast path: phone already has an account. No external calls.
    const existing = await lookupByPhone(phone);
    if (existing) {
      return res.status(200).json({ ...existing, created: false });
    }

    // 1. Create the Clerk identity (user + org). Fail loud on Clerk error.
    const orgName = `WhatsApp ${phone}`;
    const { clerkUserId, clerkOrgId } = await createClerkPhoneAccount(phone, orgName);

    // 2. Reserve internal rows. The unique phone index arbitrates the race.
    let created: { orgId: string; userId: string };
    try {
      created = await db.transaction(async (tx) => {
        const [org] = await tx
          .insert(orgs)
          .values({ externalId: clerkOrgId, name: orgName })
          .returning();
        const [user] = await tx
          .insert(users)
          .values({ externalId: clerkUserId, phone, orgId: org.id })
          .onConflictDoNothing({ target: users.phone })
          .returning();
        if (!user) {
          // Lost the phone race — abort so the org insert rolls back too.
          throw new PhoneRaceLostError();
        }
        return { orgId: org.id, userId: user.id };
      });
    } catch (txErr) {
      if (txErr instanceof PhoneRaceLostError) {
        // Tear down the Clerk org+user we created but didn't get to keep.
        await deleteClerkOrganization(clerkOrgId).catch((e) =>
          console.error(`[client-service] orphan Clerk org ${clerkOrgId} cleanup failed:`, e),
        );
        await deleteClerkUser(clerkUserId).catch((e) =>
          console.error(`[client-service] orphan Clerk user ${clerkUserId} cleanup failed:`, e),
        );
        const winner = await lookupByPhone(phone);
        if (winner) return res.status(200).json({ ...winner, created: false });
        // Winner row vanished (deleted between race + refetch) — surface loudly.
        throw txErr;
      }
      throw txErr;
    }

    // 3. Trigger billing's welcome path for the new org (welcome credit + Stripe
    //    customer). Reuses billing; we never grant credit ourselves.
    await ensureBillingWelcome(created.orgId, created.userId);

    return res.status(200).json({
      orgId: created.orgId,
      userId: created.userId,
      phone,
      clerkOrgId,
      clerkUserId,
      created: true,
    });
  } catch (error) {
    if (error instanceof ClerkServiceError) {
      return res.status(502).json({ error: `Clerk provisioning failed: ${error.body}` });
    }
    if (error instanceof BillingServiceError) {
      return res.status(502).json({ error: `billing-service welcome failed: ${error.body}` });
    }
    console.error("[client-service] Phone-account provisioning error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Phone-account provisioning failed",
    });
  }
});

/**
 * GET /internal/phone-accounts?phone=... - Resolve a KNOWN phone to its identity.
 * Read-only: never creates. 404 when no account exists for the phone.
 */
router.get("/internal/phone-accounts", requireApiKey, async (req, res) => {
  const parsed = ResolvePhoneAccountQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
  }

  try {
    const identity = await lookupByPhone(parsed.data.phone);
    if (!identity) {
      return res.status(404).json({ error: "No account exists for this phone number" });
    }
    return res.status(200).json({ ...identity, created: false });
  } catch (error) {
    console.error("[client-service] Phone-account resolve error:", error);
    return res.status(500).json({ error: "Failed to resolve phone account" });
  }
});

export default router;

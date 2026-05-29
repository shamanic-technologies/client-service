import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs, invites } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { OrgMemberCheckParamsSchema, OrgTeardownParamsSchema } from "../schemas.js";
import { deleteClerkOrganization, ClerkServiceError } from "../lib/clerk-client.js";
import { deleteStripeCustomerByOrg, StripeServiceError } from "../lib/stripe-service-client.js";

const router = Router();

/**
 * GET /internal/orgs/:orgId/members/:userId - Check if a user is a member of an org
 */
router.get("/internal/orgs/:orgId/members/:userId", requireApiKey, async (req, res) => {
  const parsed = OrgMemberCheckParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
  }

  const { orgId, userId } = parsed.data;

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1);

  if (!user) {
    return res.status(404).json({ error: "User is not a member of this org" });
  }

  return res.status(200).json({});
});

/**
 * DELETE /internal/orgs/:orgId - Cascade-teardown an org.
 *
 * `:orgId` is the internal client-service org UUID (the platform `x-org-id`).
 * Orchestrates a full teardown of everything client-service owns for the org:
 *   1. stripe-service deletes the org's Stripe customer online (keyed by the
 *      same internal UUID = stripe-service `metadata.org_id`).
 *   2. Clerk deletes the org online (keyed by the org's `external_id`, which
 *      client-service owns the mapping for).
 *   3. client-service deletes its own org-scoped rows (users, invites, org) —
 *      LAST, so the `external_id` mapping stays available for the Clerk step
 *      through every fail-loud retry.
 *
 * Fail loud: any sub-step failure surfaces as a non-2xx with the real upstream
 * error — never a silent 200 on partial teardown. Idempotent: re-running on an
 * already-gone org succeeds and reports zero rows (Clerk/Stripe report
 * "not_found").
 */
router.delete("/internal/orgs/:orgId", requireApiKey, async (req, res) => {
  const parsed = OrgTeardownParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
  }

  const { orgId } = parsed.data;

  try {
    // Resolve the org row to capture the Clerk org id (external_id) for step 2.
    // Missing row => client-service data already gone; still run 1+2 defensively
    // so the teardown converges on retry.
    const [org] = await db
      .select({ id: orgs.id, externalId: orgs.externalId })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);

    // 1. Stripe customer (online, via stripe-service). Fail loud on real error.
    const stripe = await deleteStripeCustomerByOrg(orgId);

    // 2. Clerk organization (online). Keyed by external_id. Fail loud on real error.
    let clerk: "deleted" | "not_found" = "not_found";
    if (org?.externalId) {
      clerk = await deleteClerkOrganization(org.externalId);
    }

    // 3. client-service org-scoped data (LAST). One transaction.
    let clientService = { orgs: 0, users: 0, invites: 0 };
    if (org) {
      clientService = await db.transaction(async (tx) => {
        const deletedUsers = await tx
          .delete(users)
          .where(eq(users.orgId, org.id))
          .returning({ id: users.id });
        const deletedInvites = await tx
          .delete(invites)
          .where(eq(invites.inviterOrgId, org.id))
          .returning({ id: invites.id });
        // The org may be the invitee on another org's invite — unlink (don't
        // delete the inviter's record), so the FK no longer blocks the org delete.
        await tx
          .update(invites)
          .set({ inviteeOrgId: null })
          .where(eq(invites.inviteeOrgId, org.id));
        const deletedOrgs = await tx
          .delete(orgs)
          .where(eq(orgs.id, org.id))
          .returning({ id: orgs.id });
        return {
          orgs: deletedOrgs.length,
          users: deletedUsers.length,
          invites: deletedInvites.length,
        };
      });
    }

    return res.status(200).json({ orgId, clientService, clerk, stripe });
  } catch (error) {
    if (error instanceof StripeServiceError) {
      return res.status(502).json({
        error: "stripe-service customer delete failed",
        provider: "stripe",
        upstreamStatus: error.status,
        upstreamBody: error.body,
      });
    }
    if (error instanceof ClerkServiceError) {
      return res.status(502).json({
        error: "Clerk org delete failed",
        provider: "clerk",
        upstreamStatus: error.status,
        upstreamBody: error.body,
      });
    }
    console.error("[client-service] Org teardown error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Org teardown failed",
    });
  }
});

export default router;

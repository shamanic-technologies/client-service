import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs, invites } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  OrgMemberCheckParamsSchema,
  OrgTeardownParamsSchema,
  OrgTeardownByExternalParamsSchema,
} from "../schemas.js";
import { deleteClerkOrganization, deleteClerkUser, ClerkServiceError } from "../lib/clerk-client.js";
import { deleteStripeCustomerByOrg, StripeServiceError } from "../lib/stripe-service-client.js";
import {
  deleteBillingByOrg,
  deleteCampaignsByOrg,
  deleteKeysByOrg,
  deleteRunsByOrg,
  InternalServiceTeardownError,
} from "../lib/internal-service-client.js";

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

type TeardownSummary = {
  orgId: string;
  clientService: { orgs: number; users: number; invites: number };
  billing: "deleted";
  campaign: "deleted";
  runs: "deleted";
  key: "deleted";
  stripe: "deleted";
  clerk: "deleted" | "not_found";
  clerkUsers: number;
};

/**
 * Cascade-teardown of everything client-service owns for one org, keyed by the
 * internal org UUID. Shared by both the by-UUID and by-external-id routes.
 *
 *   1. spend/security producer services delete or neutralize their org state.
 *   2. stripe-service deletes the org's Stripe customer online (keyed by the
 *      same internal UUID = stripe-service `metadata.org_id`).
 *   3. Clerk deletes every user belonging to the org (keyed by each user's
 *      `external_id` = Clerk user id), so the org's emails are freed for reuse.
 *   4. Clerk deletes the org online (keyed by the org's `external_id`, which
 *      client-service owns the mapping for).
 *   5. client-service deletes its own org-scoped rows (users, invites, org) —
 *      LAST, so the `external_id` mappings stay available for the Clerk steps
 *      through every fail-loud retry.
 *
 * Fail loud: any sub-step failure throws the real upstream error (never a silent
 * partial teardown). Idempotent: re-running on an already-gone org succeeds and
 * reports zero rows / zero Clerk users (Clerk/Stripe report "not_found").
 */
async function teardownOrg(orgId: string): Promise<TeardownSummary> {
  // Resolve the org row to capture the Clerk org id (external_id) + its users.
  // Missing row => client-service data already gone; still run producers + Stripe
  // defensively so the teardown converges on retry.
  const [org] = await db
    .select({ id: orgs.id, externalId: orgs.externalId })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  // 1. Spend/security producers. Fail loud before deleting local identity.
  const billing = await deleteBillingByOrg(orgId);
  const campaign = await deleteCampaignsByOrg(orgId);
  const runs = await deleteRunsByOrg(orgId);
  const key = await deleteKeysByOrg(orgId);

  // 2. Stripe customer (online, via stripe-service). Fail loud on real error.
  const stripe = await deleteStripeCustomerByOrg(orgId);

  // 3. Clerk users (online). Keyed by each user's external_id. Deleted BEFORE the
  // client-service rows so the external_id mapping is still present to read here,
  // and before the Clerk org delete. Fail loud on a real (non-404) error.
  let clerkUsers = 0;
  let clerk: "deleted" | "not_found" = "not_found";
  if (org) {
    const orgUsers = await db
      .select({ externalId: users.externalId })
      .from(users)
      .where(eq(users.orgId, org.id));
    for (const u of orgUsers) {
      if (!u.externalId) continue;
      const result = await deleteClerkUser(u.externalId);
      if (result === "deleted") clerkUsers++;
    }

    // 4. Clerk organization (online). Keyed by external_id. Fail loud on real error.
    if (org.externalId) {
      clerk = await deleteClerkOrganization(org.externalId);
    }
  }

  // 5. client-service org-scoped data (LAST). One transaction.
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

  return { orgId, clientService, billing, campaign, runs, key, stripe, clerk, clerkUsers };
}

function handleTeardownError(error: unknown, res: import("express").Response) {
  if (error instanceof InternalServiceTeardownError) {
    return res.status(502).json({
      error: `${error.provider}-service org teardown failed`,
      provider: error.provider,
      upstreamStatus: error.status,
      upstreamBody: error.body,
    });
  }
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
      error: "Clerk delete failed",
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

/**
 * DELETE /internal/orgs/:orgId - Cascade-teardown an org by its internal UUID
 * (the platform `x-org-id`). See teardownOrg for the full cascade.
 */
router.delete("/internal/orgs/:orgId", requireApiKey, async (req, res) => {
  const parsed = OrgTeardownParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
  }

  try {
    const summary = await teardownOrg(parsed.data.orgId);
    return res.status(200).json(summary);
  } catch (error) {
    return handleTeardownError(error, res);
  }
});

/**
 * DELETE /internal/orgs/by-external/:externalOrgId - Cascade-teardown an org by
 * its Clerk org id (external_id). Resolves external_id -> internal UUID
 * READ-ONLY (404 if unknown — never creates the org it is about to delete,
 * unlike POST /internal/resolve), then runs the same cascade as the by-UUID
 * route (including Clerk user deletion).
 */
router.delete("/internal/orgs/by-external/:externalOrgId", requireApiKey, async (req, res) => {
  const parsed = OrgTeardownByExternalParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
  }

  const { externalOrgId } = parsed.data;

  try {
    // Read-only resolve: external Clerk org id -> internal UUID. No upsert.
    const [org] = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.externalId, externalOrgId))
      .limit(1);

    if (!org) {
      return res.status(404).json({ error: "Org not found for the given Clerk org id" });
    }

    const summary = await teardownOrg(org.id);
    return res.status(200).json(summary);
  } catch (error) {
    return handleTeardownError(error, res);
  }
});

export default router;

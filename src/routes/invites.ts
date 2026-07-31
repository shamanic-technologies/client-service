import { Router } from "express";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { invites, orgs } from "../db/schema.js";
import { notifyReferralClaim } from "../lib/billing-service-client.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  ValidateInviteBodySchema,
  ClaimInviteBodySchema,
  InviteStatusParamsSchema,
} from "../schemas.js";

const router = Router();

/**
 * POST /public/invites/validate
 *
 * There is NO cap on how many signups an invite code may bring in: an inviter
 * earns the referral credit on every conversion, so refusing a code because its
 * owner already brought in N signups would silently cap their earnings.
 * valid=false therefore means one thing only: no org owns this code.
 */
router.post("/public/invites/validate", requireApiKey, async (req, res) => {
  try {
    const parsed = ValidateInviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { code } = parsed.data;

    const [inviterOrg] = await db
      .select({ id: orgs.id, name: orgs.name })
      .from(orgs)
      .where(eq(orgs.slug, code))
      .limit(1);

    if (!inviterOrg) {
      return res.json({ valid: false });
    }

    return res.json({
      valid: true,
      ...(inviterOrg.name !== null && { inviterOrgName: inviterOrg.name }),
    });
  } catch (error) {
    console.error("[client-service] Validate invite error:", error);
    return res.status(500).json({ error: "Failed to validate invite" });
  }
});

/**
 * POST /internal/invites/claim
 *
 * Records that `inviteeOrgId` signed up through `code`, then tells
 * billing-service who referred whom so it can open the invitee's free-credit
 * promise and remember the inviter to pay on conversion. No cap: an inviter may
 * bring in any number of signups.
 *
 * Idempotent on (code, inviteeOrgId): re-claiming returns the existing row
 * unchanged. The billing notification carries its own delivery marker
 * (`invites.billing_notified_at`) so a repeated claim does NOT notify twice,
 * while a claim whose notification FAILED retries on the next call.
 *
 * Fail loud: a billing-service failure is a 502, never a quiet 200 — the row is
 * recorded but the money side has not heard about it, and the caller must know.
 */
router.post("/internal/invites/claim", requireApiKey, async (req, res) => {
  try {
    const parsed = ClaimInviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { code, inviteeOrgId } = parsed.data;

    const [inviterOrg] = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.slug, code))
      .limit(1);

    if (!inviterOrg) {
      return res.status(404).json({ error: "Unknown invite code" });
    }

    const [inviteeOrg] = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.id, inviteeOrgId))
      .limit(1);

    if (!inviteeOrg) {
      return res.status(404).json({ error: "Unknown invitee org" });
    }

    // Record the claim. Serialized on the inviter's orgs row so two parallel
    // first-claims of the same pair cannot both insert (READ COMMITTED hides
    // each other's pending insert from the existence check).
    const claim = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM orgs WHERE id = ${inviterOrg.id} FOR UPDATE`);

      const [existing] = await tx
        .select({
          id: invites.id,
          status: invites.status,
          billingNotifiedAt: invites.billingNotifiedAt,
        })
        .from(invites)
        .where(
          and(
            eq(invites.inviterOrgId, inviterOrg.id),
            eq(invites.inviteeOrgId, inviteeOrgId),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.status !== "signed_up") {
          await tx
            .update(invites)
            .set({
              status: "signed_up",
              signedUpAt: sql`COALESCE(${invites.signedUpAt}, now())`,
            })
            .where(eq(invites.id, existing.id));
        }
        return { id: existing.id, alreadyNotified: existing.billingNotifiedAt !== null };
      }

      const [inserted] = await tx
        .insert(invites)
        .values({
          inviterOrgId: inviterOrg.id,
          inviteeOrgId,
          code,
          status: "signed_up",
          signedUpAt: new Date(),
        })
        .returning({ id: invites.id });

      return { id: inserted.id, alreadyNotified: false };
    });

    // Tell billing who referred whom. Only once per (code, invitee) pair: the
    // marker is written AFTER billing acknowledges, so a crash or a billing
    // failure leaves it NULL and the next claim retries rather than dropping a
    // customer's credit on the floor.
    if (!claim.alreadyNotified) {
      try {
        await notifyReferralClaim({ inviterOrgId: inviterOrg.id, inviteeOrgId });
      } catch (error) {
        console.error("[client-service] Referral notification to billing failed:", error);
        return res.status(502).json({
          error: "Invite recorded but billing-service could not be notified",
          details: error instanceof Error ? error.message : String(error),
        });
      }

      await db
        .update(invites)
        .set({ billingNotifiedAt: sql`now()` })
        .where(and(eq(invites.id, claim.id), isNull(invites.billingNotifiedAt)));
    }

    return res.json({ ok: true, inviterOrgId: inviterOrg.id });
  } catch (error) {
    console.error("[client-service] Claim invite error:", error);
    return res.status(500).json({ error: "Failed to claim invite" });
  }
});

/**
 * GET /internal/orgs/:orgId/invites/status
 *
 * `signups` is how many orgs have signed up through this org's code so far.
 * There is no quota, so there is nothing to be out of and nothing to expire —
 * the old `total` / `expired` fields only ever expressed the retired cap and
 * are gone rather than left lying with a meaningless value.
 */
router.get("/internal/orgs/:orgId/invites/status", requireApiKey, async (req, res) => {
  try {
    const parsed = InviteStatusParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid orgId", details: parsed.error.flatten() });
    }

    const { orgId } = parsed.data;

    const [org] = await db
      .select({ slug: orgs.slug })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);

    if (!org) {
      return res.status(404).json({ error: "Org not found" });
    }

    const [{ signups }] = await db
      .select({ signups: count() })
      .from(invites)
      .where(and(eq(invites.inviterOrgId, orgId), eq(invites.status, "signed_up")));

    return res.json({
      signups,
      code: org.slug,
    });
  } catch (error) {
    console.error("[client-service] Invite status error:", error);
    return res.status(500).json({ error: "Failed to get invite status" });
  }
});

export default router;

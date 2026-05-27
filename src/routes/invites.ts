import { Router } from "express";
import { and, count, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { invites, orgs } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  ValidateInviteBodySchema,
  ClaimInviteBodySchema,
  InviteStatusParamsSchema,
} from "../schemas.js";

const router = Router();

const INVITE_CAP = 3;

class InviteCapReachedError extends Error {
  constructor(public used: number) {
    super("Invite cap reached");
    this.name = "InviteCapReachedError";
  }
}

/**
 * POST /public/invites/validate
 * valid=false covers both unknown-slug AND capped-org (per locked contract).
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

    const [{ used }] = await db
      .select({ used: count() })
      .from(invites)
      .where(and(eq(invites.inviterOrgId, inviterOrg.id), eq(invites.status, "signed_up")));

    if (used >= INVITE_CAP) {
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
 * Idempotent: re-claiming the same (code, inviteeOrgId) tuple returns the
 * existing row unchanged. 4th distinct claim against a 3/3 inviter rejects
 * with HTTP 409.
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

    try {
      await db.transaction(async (tx) => {
        // Serialize concurrent claims for this inviter by locking its orgs row.
        // Without this lock, two parallel claims could both pass the cap check
        // (READ COMMITTED isolation hides each other's pending insert).
        await tx.execute(sql`SELECT 1 FROM orgs WHERE id = ${inviterOrg.id} FOR UPDATE`);

        const [existing] = await tx
          .select({ id: invites.id, status: invites.status })
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
          return;
        }

        const [{ used }] = await tx
          .select({ used: count() })
          .from(invites)
          .where(and(eq(invites.inviterOrgId, inviterOrg.id), eq(invites.status, "signed_up")));

        if (used >= INVITE_CAP) {
          throw new InviteCapReachedError(used);
        }

        await tx.insert(invites).values({
          inviterOrgId: inviterOrg.id,
          inviteeOrgId,
          code,
          status: "signed_up",
          signedUpAt: new Date(),
        });
      });
    } catch (err) {
      if (err instanceof InviteCapReachedError) {
        return res
          .status(409)
          .json({ error: "Invite cap reached", used: err.used, total: INVITE_CAP });
      }
      throw err;
    }

    return res.json({ ok: true, inviterOrgId: inviterOrg.id });
  } catch (error) {
    console.error("[client-service] Claim invite error:", error);
    return res.status(500).json({ error: "Failed to claim invite" });
  }
});

/**
 * GET /internal/orgs/:orgId/invites/status
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

    const [{ used }] = await db
      .select({ used: count() })
      .from(invites)
      .where(and(eq(invites.inviterOrgId, orgId), eq(invites.status, "signed_up")));

    return res.json({
      used,
      total: INVITE_CAP,
      code: org.slug,
      expired: used >= INVITE_CAP,
    });
  } catch (error) {
    console.error("[client-service] Invite status error:", error);
    return res.status(500).json({ error: "Failed to get invite status" });
  }
});

export default router;

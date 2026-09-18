import { Router } from "express";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { OrgClaimParamsSchema, OrgClaimBodySchema } from "../schemas.js";

const router = Router();

/** Postgres unique-violation. A concurrent claim of the same identity lands here. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * POST /internal/orgs/:orgId/claim - An org that came into being without an
 * identity provider now HAS one.
 *
 * The signup wall sits at the END of onboarding: a visitor walks their whole
 * setup signed out, against an ORDINARY org whose external identity is a
 * throwaway id. When they finally sign up they get a real identity-provider
 * organisation, and everything they built — brands, funnels, audiences, runs,
 * spend, across five services — is on the throwaway one.
 *
 * This says, once, that the two are the same organisation. The internal uuid is
 * untouched, so every reference taken before the call still resolves; only the
 * external identity is swapped underneath it. There is no copying, no
 * cross-service migration on the signup path, and nothing to lose.
 *
 * It REFUSES rather than guesses, and each refusal is its own `reason` so the
 * caller can show the customer a different thing for each:
 *   404 `org_not_found`      - no such org.
 *   409 `org_not_anonymous`  - this org was never a throwaway one. Anonymity is
 *                              a fact we RECORDED at creation, never something
 *                              inferred from what the external id looks like.
 *   409 `org_already_claimed`- it already carries a different identity.
 *   409 `external_id_taken`  - that identity already belongs to another org.
 *
 * Idempotent: replaying the exact same claim re-attaches the same person and
 * answers 200 with `alreadyClaimed: true`. A retried signup, or a browser that
 * replays the request, never produces a second organisation nor an error the
 * customer sees.
 *
 * This is NOT an org-merge or org-transfer facility. It is the one transition
 * anonymous -> identified, and that narrowness is what makes it safe.
 */
router.post("/internal/orgs/:orgId/claim", requireApiKey, async (req, res) => {
  const parsedParams = OrgClaimParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: "Invalid parameters",
      reason: "invalid_request",
      details: parsedParams.error.flatten(),
    });
  }

  const parsedBody = OrgClaimBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Invalid request body",
      reason: "invalid_request",
      details: parsedBody.error.flatten(),
    });
  }

  const { orgId } = parsedParams.data;
  const { externalOrgId, externalUserId, email, firstName, lastName, imageUrl, orgName, orgSlug } =
    parsedBody.data;

  try {
    const outcome = await db.transaction(async (tx) => {
      // Lock the org row for the whole decision. Two signups racing on the same
      // org serialise here, so exactly one performs the claim and the other
      // reads the claimed row and replays it.
      const [org] = await tx
        .select()
        .from(orgs)
        .where(eq(orgs.id, orgId))
        .for("update")
        .limit(1);

      if (!org) {
        return { status: 404 as const, body: { error: "Org not found", reason: "org_not_found" } };
      }

      if (!org.anonymousAt) {
        return {
          status: 409 as const,
          body: {
            error: "This org did not come into being without an identity provider, so it cannot be claimed",
            reason: "org_not_anonymous",
          },
        };
      }

      if (org.claimedAt && org.externalId !== externalOrgId) {
        return {
          status: 409 as const,
          body: {
            error: "This org already carries an identity",
            reason: "org_already_claimed",
          },
        };
      }

      // Somebody else's identity. Checked before the write for a clean refusal;
      // the unique index is what actually makes it impossible (see the catch).
      const [taken] = await tx
        .select({ id: orgs.id })
        .from(orgs)
        .where(and(eq(orgs.externalId, externalOrgId), ne(orgs.id, orgId)))
        .limit(1);

      if (taken) {
        return {
          status: 409 as const,
          body: {
            error: "That identity already belongs to another org",
            reason: "external_id_taken",
          },
        };
      }

      const alreadyClaimed = org.claimedAt !== null;
      const claimedAt = org.claimedAt ?? new Date();

      if (!alreadyClaimed) {
        await tx
          .update(orgs)
          .set({
            externalId: externalOrgId,
            claimedAt,
            ...(orgName !== undefined && { name: orgName }),
            ...(orgSlug !== undefined && { slug: orgSlug }),
            updatedAt: new Date(),
          })
          .where(eq(orgs.id, orgId));
      }

      // The person signing up becomes a member the way any member is. Keyed on
      // their identity-provider user id, so a replay re-attaches the same row
      // rather than creating a second one.
      const profileData = {
        ...(email !== undefined && { email }),
        ...(firstName !== undefined && { firstName }),
        ...(lastName !== undefined && { lastName }),
        ...(imageUrl !== undefined && { imageUrl }),
      };

      const [user] = await tx
        .insert(users)
        .values({ externalId: externalUserId, orgId, ...profileData })
        .onConflictDoUpdate({
          target: [users.externalId],
          set: { ...profileData, orgId, updatedAt: new Date() },
        })
        .returning();

      return {
        status: 200 as const,
        body: {
          orgId,
          userId: user.id,
          externalOrgId,
          claimedAt: claimedAt.toISOString(),
          alreadyClaimed,
        },
      };
    });

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    // A claim racing another org's claim of the SAME identity: the loser hits
    // the unique index on external_id. Same refusal as the pre-check.
    if (isUniqueViolation(error)) {
      return res.status(409).json({
        error: "That identity already belongs to another org",
        reason: "external_id_taken",
      });
    }
    console.error("[client-service] Org claim error:", error);
    return res.status(500).json({ error: "Failed to claim org", reason: "internal_error" });
  }
});

export default router;

import { Router } from "express";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { OrgClaimParamsSchema, OrgClaimBodySchema } from "../schemas.js";
import {
  findIdentityHolder,
  assessHolderLocally,
  assessHolderUpstream,
} from "../lib/identity-holder.js";

const router = Router();

/** Postgres unique-violation. A concurrent claim of the same identity lands here. */
const UNIQUE_VIOLATION = "23505";

/** The unique index each half of an identity is held under. */
const EXTERNAL_ID_INDEX = "idx_orgs_external_id";
const SLUG_INDEX = "idx_orgs_slug";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * WHICH uniqueness a violation was about. An identity is two fields, so a
 * collision on the slug must never be reported as `external_id_taken`: that
 * refusal tells the customer the identity belongs to somebody else, when in
 * fact only a name did.
 */
function violatedConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { constraint_name?: unknown; constraint?: unknown };
  const name = candidate.constraint_name ?? candidate.constraint;
  return typeof name === "string" ? name : null;
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
 *   409 `external_id_taken`  - that identity belongs to another org, and that org
 *                              is somebody's: anonymous, claimed, or holding
 *                              work, money or members of its own.
 *   409 `org_slug_taken`     - the identity's SLUG belongs to another org that
 *                              is somebody's. Only a name is taken, so it is
 *                              never reported as the identity being taken.
 *   502 `identity_holder_unverifiable`
 *                            - another org holds the identity and we could not
 *                              find out whether anything of anybody's sits on
 *                              it. Not knowing is never read as "it is empty".
 *
 * THE SHELL. An identity-provider organisation is ONE organisation, and by the
 * time the claim arrives a SECOND row of ours can already describe it: an
 * authenticated read resolved the identity a second earlier and, as designed,
 * brought an org into being for it. That row was never a decision — nobody
 * declared it anonymous, nobody ever claimed it, and it holds nothing but the
 * person who just signed up. Refusing on its account locks a customer out of ten
 * minutes of their own work, so the claim takes the identity off it and records
 * where it went (`absorbed_into_org_id`). Every other refusal stands untouched:
 * an org that IS anonymous, or HAS been claimed, or that anybody built anything
 * in, keeps its identity and the claim still answers `external_id_taken`.
 * What is handed over is the WHOLE identity — the external id AND the slug,
 * which came from the same identity-provider organisation and is held here
 * under a unique index. A field left on the shell is a field the identity's own
 * org cannot be resolved with, and the next authenticated read 500s on it.
 * Emptiness is CHECKED — members and state here, brands and money at the
 * services that own them — never assumed, and never inferred from what an
 * external id looks like.
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
    // Is another org already holding this identity, and is it a shell? The
    // upstream half of that question is HTTP, so it is answered BEFORE the
    // transaction — a row lock is never held across the network. What it decides
    // is only a PERMISSION: the local half is re-checked under the lock below,
    // and nothing is absorbed that does not pass both.
    let absorbableHolderId: string | null = null;
    const preflightHolder = await findIdentityHolder(db, externalOrgId, orgId);

    if (preflightHolder) {
      const local = await assessHolderLocally(db, preflightHolder, externalUserId);
      if (local.shell) {
        try {
          const upstream = await assessHolderUpstream(preflightHolder.id, orgId);
          if (upstream.shell) {
            absorbableHolderId = preflightHolder.id;
          }
        } catch (error) {
          console.error("[client-service] Identity holder could not be verified:", error);
          return res.status(502).json({
            error: "Could not find out whether the org holding that identity is empty",
            reason: "identity_holder_unverifiable",
          });
        }
      }
    }

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

      // Somebody else's identity — unless that somebody is a shell. Locked for
      // the whole decision, so the assessment and the taking are one act; the
      // unique index is what makes a race impossible either way (see the catch).
      const holder = await findIdentityHolder(tx, externalOrgId, orgId, true);
      let absorbedOrgId: string | null = null;

      if (holder) {
        const refuse = {
          status: 409 as const,
          body: {
            error: "That identity already belongs to another org",
            reason: "external_id_taken",
          },
        };

        // A different row than the one we cleared upstream, or one that has
        // gained a member since: refuse. Re-reading under the lock is what makes
        // the pre-flight safe.
        if (holder.id !== absorbableHolderId) return refuse;

        const local = await assessHolderLocally(tx, holder, externalUserId);
        if (!local.shell) return refuse;

        // Hand the identity over — the WHOLE identity. The slug came from the
        // same identity-provider organisation the external id came from, and
        // this service holds it under a unique index, so a slug left on the
        // shell splits one organisation across two rows: the next
        // authenticated read upserts the claiming org WITH its slug, collides,
        // and 502s every page of the product. The shell keeps its uuid and its
        // rows — absorbing is not a delete, and anything already pointing at it
        // still resolves. It simply stops answering to an identity that was
        // never its.
        await tx
          .update(orgs)
          .set({
            externalId: null,
            slug: null,
            absorbedIntoOrgId: orgId,
            absorbedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(orgs.id, holder.id));

        absorbedOrgId = holder.id;

        // The first touch follows the person, not the row. If the shell was
        // handed one (an ordinary-signup hand-over that landed before this
        // claim) and the claiming org has none, it moves across. If the claiming
        // org already has its own — the touch recorded while it was anonymous —
        // that one stands and the shell keeps its own: nothing is stolen,
        // nothing is overwritten.
        await tx.execute(sql`
          UPDATE org_acquisitions
             SET org_id = ${orgId}, recorded_via = 'absorbed_shell'
           WHERE org_id = ${holder.id}
             AND NOT EXISTS (SELECT 1 FROM org_acquisitions WHERE org_id = ${orgId})
        `);
      }

      const alreadyClaimed = org.claimedAt !== null;
      const claimedAt = org.claimedAt ?? new Date();

      // The slug is the other half of the identity, and it is held here under a
      // unique index. The shell that just handed the identity over released its
      // slug in the same act above, so a slug still held at this point is
      // somebody else's name — and the refusal says exactly that. Reporting it
      // as `external_id_taken` would tell the customer the identity belongs to
      // another org when only a name does.
      if (!alreadyClaimed && orgSlug !== undefined) {
        const [slugHolder] = await tx
          .select({ id: orgs.id })
          .from(orgs)
          .where(and(eq(orgs.slug, orgSlug), ne(orgs.id, orgId)))
          .for("update")
          .limit(1);

        if (slugHolder) {
          return {
            status: 409 as const,
            body: {
              error: "That organisation slug already belongs to another org",
              reason: "org_slug_taken",
            },
          };
        }
      }

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
          // Present only when a shell had to hand the identity over. The consumer
          // does not act on it; it is how the transition stays readable later.
          ...(absorbedOrgId !== null && { absorbedOrgId }),
        },
      };
    });

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    // A claim racing another org's claim of the SAME identity: the loser hits
    // one of the two unique indexes. WHICH one decides what the customer is
    // told — a collision on the slug is a name being taken, and reporting it
    // as `external_id_taken` says the identity belongs to somebody else when
    // it does not.
    if (isUniqueViolation(error)) {
      const constraint = violatedConstraint(error);
      if (constraint === SLUG_INDEX) {
        return res.status(409).json({
          error: "That organisation slug already belongs to another org",
          reason: "org_slug_taken",
        });
      }
      if (constraint === null || constraint === EXTERNAL_ID_INDEX) {
        return res.status(409).json({
          error: "That identity already belongs to another org",
          reason: "external_id_taken",
        });
      }
    }
    console.error("[client-service] Org claim error:", error);
    return res.status(500).json({ error: "Failed to claim org", reason: "internal_error" });
  }
});

export default router;

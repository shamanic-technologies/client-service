import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";
import { findIdentityHolder, assessHolderLocally, assessHolderUpstream } from "./identity-holder.js";
import { pgDriverError } from "./pg-error.js";

/**
 * The ONE transition anonymous -> identified, shared by its two callers so an
 * org is never claimed two different ways:
 *   - `POST /internal/orgs/:orgId/claim` (the signup page's wall), where the
 *     full story of every refusal and of the shell is told;
 *   - the agent-signup completion naming an unclaimed org (`claimOrgId`), where
 *     the person proved their email in a conversation instead of on the page.
 *
 * It answers the route's own status and body, untouched: this module was lifted
 * out of the route, not rewritten.
 */

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

export type OrgClaimInput = {
  externalOrgId: string;
  externalUserId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
  orgName?: string;
  orgSlug?: string;
};

export type OrgClaimRefusalReason =
  | "org_not_found"
  | "org_not_anonymous"
  | "org_already_claimed"
  | "external_id_taken"
  | "org_slug_taken"
  | "identity_holder_unverifiable"
  | "internal_error";

export type OrgClaimSuccess = {
  status: 200;
  body: {
    orgId: string;
    userId: string;
    externalOrgId: string;
    claimedAt: string;
    alreadyClaimed: boolean;
    absorbedOrgId?: string;
  };
};

export type OrgClaimRefusal = {
  status: 404 | 409 | 500 | 502;
  body: { error: string; reason: OrgClaimRefusalReason };
};

export type OrgClaimOutcome = OrgClaimSuccess | OrgClaimRefusal;

/**
 * Attach the identity `externalOrgId` / `externalUserId` to the anonymous org
 * `orgId`, or say exactly why not. Never throws: a failure it did not expect is
 * the `internal_error` 500, logged.
 */
export async function claimOrg(orgId: string, input: OrgClaimInput): Promise<OrgClaimOutcome> {
  const { externalOrgId, externalUserId, email, firstName, lastName, imageUrl, orgName, orgSlug } = input;

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
          return {
            status: 502,
            body: {
              error: "Could not find out whether the org holding that identity is empty",
              reason: "identity_holder_unverifiable",
            },
          };
        }
      }
    }

    return await db.transaction(async (tx): Promise<OrgClaimOutcome> => {
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
        return { status: 404, body: { error: "Org not found", reason: "org_not_found" } };
      }

      if (!org.anonymousAt) {
        return {
          status: 409,
          body: {
            error: "This org did not come into being without an identity provider, so it cannot be claimed",
            reason: "org_not_anonymous",
          },
        };
      }

      if (org.claimedAt && org.externalId !== externalOrgId) {
        return {
          status: 409,
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
        const refuse: OrgClaimRefusal = {
          status: 409,
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
            status: 409,
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
        status: 200,
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
  } catch (error) {
    // A claim racing another org's claim of the SAME identity: the loser hits
    // one of the two unique indexes. WHICH one decides what the customer is
    // told — a collision on the slug is a name being taken, and reporting it
    // as `external_id_taken` says the identity belongs to somebody else when
    // it does not.
    // drizzle wraps the driver error (DrizzleQueryError): code and constraint live on it.
    const driverError = pgDriverError(error);
    if (isUniqueViolation(driverError)) {
      const constraint = violatedConstraint(driverError);
      if (constraint === SLUG_INDEX) {
        return {
          status: 409,
          body: { error: "That organisation slug already belongs to another org", reason: "org_slug_taken" },
        };
      }
      if (constraint === null || constraint === EXTERNAL_ID_INDEX) {
        return {
          status: 409,
          body: { error: "That identity already belongs to another org", reason: "external_id_taken" },
        };
      }
    }
    console.error("[client-service] Org claim error:", error);
    return { status: 500, body: { error: "Failed to claim org", reason: "internal_error" } };
  }
}

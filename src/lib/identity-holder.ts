import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  orgs,
  users,
  invites,
  rewardFunnelObservations,
  rewardTaskStates,
  rewardTaskCompletions,
} from "../db/schema.js";
import { listBrandsClaimedByOrg } from "./brand-service-client.js";
import { getOrgPaymentTotals } from "./stripe-service-client.js";

/**
 * An identity-provider organisation is ONE organisation, and at signup two of
 * our rows can describe it: the anonymous org the visitor spent ten minutes
 * building, and a row that came into being seconds earlier because an
 * authenticated read resolved the identity they had just created.
 *
 * This decides whether the second one is a SHELL — a row that was never a
 * decision — so the claim may take the identity off it instead of refusing the
 * customer their own work.
 *
 * SHELL, and every condition is load-bearing:
 *   - it was never declared anonymous (an anonymous org is somebody's signed-out
 *     walk, and taking its identity would take their work);
 *   - it has never been claimed (a claimed org is somebody's, full stop);
 *   - it is not already a shell (it has nothing left to give);
 *   - every member it has is the person signing up, and it holds none of our own
 *     org-scoped state (invites, reward ledger);
 *   - it claims no brand and has paid no money in — the two places where "somebody
 *     built something in it" lives outside this service.
 *
 * Anything else REFUSES, exactly as the claim refuses today. And a check that
 * could not be performed is neither yes nor no: it throws, and the claim answers
 * 502 rather than absorbing an org it could not look inside.
 */

/** Anything that can run a query: the db, or an open transaction. */
type Executor = Pick<typeof db, "select">;

export type HolderAssessment =
  /** Never a decision: the claim may take its identity. */
  | { shell: true }
  /** Somebody's organisation. The claim refuses, with the reason it always gave. */
  | { shell: false; because: HolderKeeps };

export type HolderKeeps =
  | "holder_is_anonymous"
  | "holder_is_claimed"
  | "holder_already_absorbed"
  | "holder_has_other_members"
  | "holder_has_state"
  | "holder_claims_a_brand"
  | "holder_has_paid";

/** The identity-holding org, as far as this service records it. */
export type HolderRow = {
  id: string;
  anonymousAt: Date | null;
  claimedAt: Date | null;
  absorbedAt: Date | null;
};

/**
 * The org currently holding `externalOrgId`, if any other org holds it.
 *
 * `lock` takes the row FOR UPDATE, which the claim does inside its transaction:
 * the decision to take an identity and the taking of it must be one act.
 */
export async function findIdentityHolder(
  executor: Executor,
  externalOrgId: string,
  claimingOrgId: string,
  lock = false,
): Promise<HolderRow | null> {
  const query = executor
    .select({
      id: orgs.id,
      anonymousAt: orgs.anonymousAt,
      claimedAt: orgs.claimedAt,
      absorbedAt: orgs.absorbedAt,
    })
    .from(orgs)
    .where(and(eq(orgs.externalId, externalOrgId), ne(orgs.id, claimingOrgId)));

  const [row] = lock ? await query.for("update").limit(1) : await query.limit(1);

  return row ?? null;
}

/**
 * What this service itself knows about the holder. Cheap, transactional, and
 * re-run under the row lock so a member appearing mid-claim cannot be missed.
 */
export async function assessHolderLocally(
  executor: Executor,
  holder: HolderRow,
  externalUserId: string,
): Promise<HolderAssessment> {
  if (holder.anonymousAt) return { shell: false, because: "holder_is_anonymous" };
  if (holder.claimedAt) return { shell: false, because: "holder_is_claimed" };
  if (holder.absorbedAt) return { shell: false, because: "holder_already_absorbed" };

  // Members other than the person signing up. Theirs is the only membership a
  // read can have created.
  const [otherMember] = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.orgId, holder.id),
        or(isNull(users.externalId), ne(users.externalId, externalUserId)),
      ),
    )
    .limit(1);

  if (otherMember) return { shell: false, because: "holder_has_other_members" };

  // Anything this service records against an org is something somebody did.
  const [state] = await executor
    .select({ found: sql<number>`1` })
    .from(invites)
    .where(or(eq(invites.inviterOrgId, holder.id), eq(invites.inviteeOrgId, holder.id)))
    .limit(1);

  if (state) return { shell: false, because: "holder_has_state" };

  for (const table of [rewardTaskStates, rewardTaskCompletions, rewardFunnelObservations]) {
    const [row] = await executor
      .select({ found: sql<number>`1` })
      .from(table)
      .where(eq(table.orgId, holder.id))
      .limit(1);
    if (row) return { shell: false, because: "holder_has_state" };
  }

  return { shell: true };
}

/**
 * What the rest of the fleet knows: does anybody's work or money sit on the
 * holder? Read live from the services that own each — brand-service owns the
 * brand claim, stripe-service owns the money.
 *
 * Deliberately OUTSIDE the claim's transaction: these are HTTP calls, and a row
 * lock is not held across the network. The local half is re-checked under the
 * lock afterwards.
 *
 * Fail loud: an upstream that cannot answer throws. "We could not find out" must
 * never read as "nobody built anything here".
 */
export async function assessHolderUpstream(holderId: string): Promise<HolderAssessment> {
  const [brands, payments] = await Promise.all([
    listBrandsClaimedByOrg(holderId),
    getOrgPaymentTotals(holderId),
  ]);

  if (brands.length > 0) return { shell: false, because: "holder_claims_a_brand" };
  // Gross paid in, never net: a refund does not un-happen a checkout.
  if (payments.some((total) => total.amountReceivedCents > 0)) {
    return { shell: false, because: "holder_has_paid" };
  }

  return { shell: true };
}

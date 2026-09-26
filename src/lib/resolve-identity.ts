import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs, type Org, type User } from "../db/schema.js";

export type ResolveIdentityInput = {
  externalOrgId: string;
  externalUserId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
  orgName?: string;
  orgSlug?: string;
  anonymous?: boolean;
};

export type ResolvedIdentity = {
  org: Org;
  user: User;
  orgCreated: boolean;
  userCreated: boolean;
};

/**
 * Resolve external org/user ids to our rows, creating them if they do not exist.
 * Idempotent. Shared by POST /internal/resolve and by the acquisition hand-over
 * keyed on external ids, so both bring an org into being in exactly one way.
 *
 * orgSlug, when supplied, is set on the org row only when the existing slug is
 * NULL (self-healing backfill from the upstream Clerk org slug). Pre-existing
 * slugs are never overwritten: Clerk slugs are immutable per org.
 */
export async function resolveIdentity(input: ResolveIdentityInput): Promise<ResolvedIdentity> {
  const { externalOrgId, externalUserId, email, firstName, lastName, imageUrl, orgName, orgSlug, anonymous } = input;

  // `anonymous` marks an org that comes into being WITHOUT an identity
  // provider: the signed-out phase of onboarding, where the dashboard mints
  // the external id itself. It is recorded ONLY on the row we create, and on
  // the caller's declaration — the marker is what POST /internal/orgs/:orgId/claim
  // later checks, and it must never be re-derived by looking at the id.
  // On conflict the existing row keeps whatever it already says it is: a real
  // Clerk org can never be re-labelled anonymous by a later resolve.
  const orgInsertData = {
    externalId: externalOrgId,
    ...(orgName !== undefined && { name: orgName }),
    ...(orgSlug !== undefined && { slug: orgSlug }),
    ...(anonymous === true && { anonymousAt: new Date() }),
  };

  const orgUpdateSet: Record<string, unknown> = {
    ...(orgName !== undefined && { name: orgName }),
    updatedAt: new Date(),
  };
  if (orgSlug !== undefined) {
    orgUpdateSet.slug = sql`COALESCE(${orgs.slug}, ${orgSlug})`;
  }

  const [org] = await db
    .insert(orgs)
    .values(orgInsertData)
    .onConflictDoUpdate({
      target: [orgs.externalId],
      set: orgUpdateSet,
    })
    .returning();

  const orgCreated = org.createdAt.getTime() === org.updatedAt.getTime();

  const profileData = {
    ...(email !== undefined && { email }),
    ...(firstName !== undefined && { firstName }),
    ...(lastName !== undefined && { lastName }),
    ...(imageUrl !== undefined && { imageUrl }),
  };

  const [user] = await db
    .insert(users)
    .values({ externalId: externalUserId, orgId: org.id, ...profileData })
    .onConflictDoUpdate({
      target: [users.externalId],
      set: { ...profileData, orgId: org.id, updatedAt: new Date() },
    })
    .returning();

  const userCreated = user.createdAt.getTime() === user.updatedAt.getTime();

  return { org, user, orgCreated, userCreated };
}

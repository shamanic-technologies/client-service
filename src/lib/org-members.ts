import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import {
  createClerkOrgMembership,
  createClerkUserForEmail,
  findClerkUserByEmail,
  listClerkUserMemberships,
} from "./clerk-client.js";
import { forgetMembership } from "./user-memberships.js";
import { clerkOrgIdOf, INVITE_ROLE, normalizeEmail } from "./org-member-invitations.js";

/**
 * Make a person (by email) a member of an org WITHOUT inviting them: nothing is
 * emailed. Staff open an account for a prospect and hand them an API key of
 * their own in our reply; the gateway gates staff and mints that key for the
 * user returned here, so the key reaches exactly the orgs this person is a
 * member of.
 *
 * The person is the identity provider's user for the email: found, or created
 * admin-side (verified, never mailed, no password). When they later sign in
 * with that email they ARE that user, so they keep the membership and the key.
 * Same role as an invitation (one role per team). Idempotent per (org, email).
 *
 * Our `users` row is created when missing, with this org as its last-active
 * org; an existing row's last-active org is left alone (it is the dashboard's,
 * not ours to move).
 */

const CALLER = { method: "POST", path: "/internal/orgs/:orgId/members" };

export interface AddedMember {
  member: { userId: string; clerkUserId: string; email: string; orgId: string; role: string };
  userCreated: boolean;
  membershipCreated: boolean;
}

export async function addOrgMember(input: { orgId: string; email: string }): Promise<AddedMember> {
  const clerkOrgId = await clerkOrgIdOf(input.orgId);
  const email = normalizeEmail(input.email);

  const existing = await findClerkUserByEmail(email, CALLER);
  const clerkUserId = existing?.clerkUserId ?? (await createClerkUserForEmail(email));

  const memberships = existing ? await listClerkUserMemberships(clerkUserId) : [];
  const alreadyMember = (memberships ?? []).some((m) => m.clerkOrgId === clerkOrgId);
  if (!alreadyMember) {
    await createClerkOrgMembership({ clerkOrgId, clerkUserId, role: INVITE_ROLE });
    // The gateway reads the membership set on every key request: the new org
    // must be reachable at once, not after the cache TTL.
    forgetMembership(clerkUserId, clerkOrgId);
  }

  const [inserted] = await db
    .insert(users)
    .values({ externalId: clerkUserId, email, orgId: input.orgId })
    .onConflictDoNothing({ target: [users.externalId] })
    .returning({ id: users.id });
  const userId =
    inserted?.id ??
    (await db.select({ id: users.id }).from(users).where(eq(users.externalId, clerkUserId)).limit(1))[0].id;

  return {
    member: { userId, clerkUserId, email, orgId: input.orgId, role: INVITE_ROLE },
    userCreated: Boolean(inserted),
    membershipCreated: !alreadyMember,
  };
}

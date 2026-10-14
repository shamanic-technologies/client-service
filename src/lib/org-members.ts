import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import {
  createClerkOrgMembership,
  createClerkUserForEmail,
  deleteClerkOrgMembership,
  findClerkUserByEmail,
  listClerkUserMemberships,
} from "./clerk-client.js";
import { forgetMembership } from "./user-memberships.js";
import { clerkOrgIdOf, INVITE_ROLE, normalizeEmail, OrgInvitationError } from "./org-member-invitations.js";

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

export interface RemovedMember {
  userId: string;
  orgId: string;
  /** False: the person was not a member (idempotent replay). */
  membershipRemoved: boolean;
  /** True: this org was the user's last active org, which no longer names it. */
  lastActiveOrgCleared: boolean;
}

/**
 * Take a person out of an org: the identity provider's membership ends, so the
 * dashboard, the gateway (membership set read live) and the org's member list
 * stop seeing them there. When this org was their last active org, that pointer
 * is cleared too, or the org's default user list would still name them; the
 * dashboard sets it again on their next sign-in, to an org they still belong
 * to. The user, their other memberships and their own orgs are untouched.
 * Idempotent per (org, user).
 */
export async function removeOrgMember(input: { orgId: string; userId: string }): Promise<RemovedMember> {
  const clerkOrgId = await clerkOrgIdOf(input.orgId);
  const [user] = await db
    .select({ externalId: users.externalId })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!user?.externalId) {
    throw new OrgInvitationError("user_not_found", "No user with an identity-provider account has this id.");
  }

  const membershipRemoved = await deleteClerkOrgMembership({ clerkOrgId, clerkUserId: user.externalId });
  forgetMembership(user.externalId, clerkOrgId);

  const cleared = await db
    .update(users)
    .set({ orgId: null, updatedAt: new Date() })
    .where(and(eq(users.id, input.userId), eq(users.orgId, input.orgId)))
    .returning({ id: users.id });

  return { userId: input.userId, orgId: input.orgId, membershipRemoved, lastActiveOrgCleared: cleared.length > 0 };
}

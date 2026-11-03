import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import {
  createClerkOrgMembership,
  createClerkUserForEmail,
  findClerkUserByEmail,
  listClerkUserMemberships,
  syntheticPhoneEmail,
} from "./clerk-client.js";
import { forgetMembership } from "./user-memberships.js";
import { clerkOrgIdOf, INVITE_ROLE } from "./org-member-invitations.js";
import { resolveByPhone } from "./phone-identity.js";

/**
 * Make a PHONE NUMBER a member of an existing org, with no email: the person
 * Sophie reaches on WhatsApp/Telegram (a client's teammate we hold no email
 * for) resolves to that org on their next message (GET /internal/phone-accounts
 * reads `users.phone` -> `users.org_id`), instead of landing as a stranger or
 * in a brand-new empty account.
 *
 * The person is a Clerk user keyed on the same synthetic placeholder email a
 * phone-born account uses (`syntheticPhoneEmail`: Clerk refuses phone
 * identifiers for many countries), made a Clerk MEMBER of the org (nothing is
 * sent), and our `users` row carries the number in `users.phone` with this org
 * as its org. When the person later adds a real email to that Clerk user (or
 * signs in to the dashboard as it), they are the same user, so the membership
 * stays.
 *
 * One number, one account: a number that already answers for ANOTHER account
 * (a `users.phone` holder in another org, or the one user who typed it on
 * onboarding) is refused `phone_belongs_to_another_account`, never moved and
 * never given a second org. A number that already answers for THIS org is a
 * replay (200). A phone-only person removed from every org (no email, no org)
 * is re-added as themselves.
 */

const CALLER = { method: "POST", path: "/internal/orgs/:orgId/phone-members" };

/** Clerk `privateMetadata.signupSource` of a person added by phone only. */
export const PHONE_MEMBER_SOURCE = "phone_member_added";

export class PhoneMemberError extends Error {
  constructor(
    public readonly code: "phone_belongs_to_another_account",
    message: string,
  ) {
    super(message);
    this.name = "PhoneMemberError";
  }
}

export interface AddedPhoneMember {
  member: { userId: string; clerkUserId: string; phone: string; orgId: string; role: string };
  userCreated: boolean;
  membershipCreated: boolean;
}

function belongsElsewhere(): PhoneMemberError {
  return new PhoneMemberError(
    "phone_belongs_to_another_account",
    "This phone number already answers for another account; it is not moved.",
  );
}

/** Clerk membership of the user in the org, created when missing. */
async function ensureMembership(clerkUserId: string, clerkOrgId: string, knownUser: boolean): Promise<boolean> {
  const memberships = knownUser ? await listClerkUserMemberships(clerkUserId) : [];
  if ((memberships ?? []).some((m) => m.clerkOrgId === clerkOrgId)) return false;
  await createClerkOrgMembership({ clerkOrgId, clerkUserId, role: INVITE_ROLE });
  // The gateway reads the membership set on every key request.
  forgetMembership(clerkUserId, clerkOrgId);
  return true;
}

export async function addOrgPhoneMember(input: { orgId: string; phone: string }): Promise<AddedPhoneMember> {
  const { orgId, phone } = input;
  const clerkOrgId = await clerkOrgIdOf(orgId);

  // 1. Who does the number answer for today?
  const [holder] = await db
    .select({ id: users.id, externalId: users.externalId, email: users.email, orgId: users.orgId })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);
  if (holder) {
    const reAdd = holder.orgId === null && !holder.email && holder.externalId;
    if (holder.orgId !== orgId && !reAdd) throw belongsElsewhere();
    if (!holder.externalId) throw belongsElsewhere();
    const membershipCreated = await ensureMembership(holder.externalId, clerkOrgId, true);
    if (reAdd) {
      await db
        .update(users)
        .set({ orgId, updatedAt: new Date() })
        .where(and(eq(users.id, holder.id), isNull(users.orgId)));
    }
    return {
      member: { userId: holder.id, clerkUserId: holder.externalId, phone, orgId, role: INVITE_ROLE },
      userCreated: false,
      membershipCreated,
    };
  }
  const typed = await resolveByPhone(phone);
  if (typed) {
    if (typed.orgId !== orgId) throw belongsElsewhere();
    return {
      member: { userId: typed.userId, clerkUserId: typed.clerkUserId, phone, orgId, role: INVITE_ROLE },
      userCreated: false,
      membershipCreated: false,
    };
  }

  // 2. Nobody: the person's Clerk user (found again on a retry), then the membership.
  const placeholder = syntheticPhoneEmail(phone);
  const existing = await findClerkUserByEmail(placeholder, CALLER);
  const clerkUserId =
    existing?.clerkUserId ??
    (await createClerkUserForEmail(placeholder, { caller: CALLER, signupSource: PHONE_MEMBER_SOURCE }));
  const membershipCreated = await ensureMembership(clerkUserId, clerkOrgId, Boolean(existing));

  // 3. Our row: the number is the identity key the channel turn reads.
  const [inserted] = await db
    .insert(users)
    .values({ externalId: clerkUserId, phone, orgId })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (inserted) {
    return {
      member: { userId: inserted.id, clerkUserId, phone, orgId, role: INVITE_ROLE },
      userCreated: true,
      membershipCreated,
    };
  }

  // A concurrent call took the number, or this Clerk user already had a row.
  const [raced] = await db.select({ id: users.id, orgId: users.orgId }).from(users).where(eq(users.phone, phone)).limit(1);
  if (raced) {
    if (raced.orgId !== orgId) throw belongsElsewhere();
    return { member: { userId: raced.id, clerkUserId, phone, orgId, role: INVITE_ROLE }, userCreated: false, membershipCreated };
  }
  const [own] = await db
    .update(users)
    .set({ phone, orgId, updatedAt: new Date() })
    .where(and(eq(users.externalId, clerkUserId), isNull(users.phone), isNull(users.orgId)))
    .returning({ id: users.id });
  if (!own) throw belongsElsewhere();
  return { member: { userId: own.id, clerkUserId, phone, orgId, role: INVITE_ROLE }, userCreated: false, membershipCreated };
}

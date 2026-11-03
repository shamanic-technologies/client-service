import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs } from "../db/schema.js";
import { refreshOnboardingPhones } from "./onboarding-phone.js";

/**
 * Which account a phone number answers for (WhatsApp / Telegram turns read it
 * through GET /internal/phone-accounts). Shared by the phone-account routes and
 * by the phone-member add (src/lib/org-phone-members.ts), so "is this number
 * already someone's?" has one answer.
 */

export interface PhoneAccountIdentity {
  orgId: string;
  userId: string;
  phone: string;
  clerkOrgId: string;
  clerkUserId: string;
}

const identityColumns = {
  orgId: orgs.id,
  userId: users.id,
  clerkOrgId: orgs.externalId,
  clerkUserId: users.externalId,
};

type IdentityRow = { orgId: string; userId: string; clerkOrgId: string | null; clerkUserId: string | null };

function toIdentity(row: IdentityRow, phone: string): PhoneAccountIdentity {
  return {
    orgId: row.orgId,
    userId: row.userId,
    phone,
    clerkOrgId: row.clerkOrgId ?? "",
    clerkUserId: row.clerkUserId ?? "",
  };
}

/**
 * Resolve a phone number to its existing account identity, joining the user's
 * org for the Clerk ids. Rule (src/lib/onboarding-phone.ts): a `users.phone`
 * holder wins; else the ONE user who typed it on onboarding; two or more = null.
 * Reads our rows only; returns null when no account owns the phone.
 */
export async function lookupByPhone(phone: string): Promise<PhoneAccountIdentity | null> {
  const [linked] = await db
    .select(identityColumns)
    .from(users)
    .innerJoin(orgs, eq(users.orgId, orgs.id))
    .where(eq(users.phone, phone))
    .limit(1);
  if (linked) return toIdentity(linked, phone);

  const typed = await db
    .select(identityColumns)
    .from(users)
    .innerJoin(orgs, eq(users.orgId, orgs.id))
    .where(eq(users.onboardingPhone, phone))
    .limit(2);
  if (typed.length === 1) return toIdentity(typed[0], phone);
  if (typed.length > 1) {
    console.warn(
      `[client-service] phone typed on onboarding by several users, resolving to nobody: ${typed
        .map((r) => r.userId)
        .join(", ")}`,
    );
  }
  return null;
}

/**
 * lookupByPhone, and on a miss re-read the onboarding numbers from Clerk once
 * and look again: someone who typed their number a minute ago resolves on their
 * first message. Clerk unreachable throws ClerkServiceError (a 502, never "unknown").
 */
export async function resolveByPhone(phone: string): Promise<PhoneAccountIdentity | null> {
  const known = await lookupByPhone(phone);
  if (known) return known;
  await refreshOnboardingPhones();
  return lookupByPhone(phone);
}


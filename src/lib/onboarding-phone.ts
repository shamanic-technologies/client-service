import { and, eq, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { listClerkUserOnboardingPhones } from "./clerk-client.js";

/**
 * The number a person typed on onboarding, mirrored from Clerk so the WhatsApp
 * phone resolution (`/internal/phone-accounts`) can answer with their account.
 *
 * Owner rule (2026-10-18 / 2026-10-27): a WhatsApp sender's number IS their
 * identity, WhatsApp verified it; a number the person gave us is theirs. So a
 * number typed on onboarding + that same number messaging us on WhatsApp is
 * proven. The typed number ALONE proves nothing, which is why it never goes into
 * `users.phone` (the channel's unique, verified key) and is only ever matched
 * against a sender WhatsApp already verified.
 *
 * Who owns the number, stated rule:
 *   1. a `users.phone` holder (linked by WhatsApp sign-in, or a phone-origin
 *      account) always wins;
 *   2. else the ONE user whose onboarding number it is;
 *   3. two or more users typed it: nobody. The sender is unknown and proves who
 *      they are the usual way (their email), which links the number for good.
 *   One number never silently resolves to two accounts.
 *
 * The dashboard writes the number to Clerk only (`/api/onboarding/phone`), so
 * the mirror is read from Clerk: a full sweep at boot (backfill) and again on
 * every resolution miss, so a person who signed up a minute ago resolves on
 * their first WhatsApp message with no manual step. A number taken OFF Clerk
 * keeps resolving until the next sweep (boot or any miss): the dashboard only
 * ever sets it, so that window is rare and short.
 */

const E164 = /^\+[1-9]\d{6,14}$/;

/** E.164 or null. The dashboard already stores strict E.164; anything else is not matched. */
export function normalizeOnboardingPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.replace(/[\s\-.()/]/g, "");
  return E164.test(compact) ? compact : null;
}

export interface OnboardingPhoneSyncResult {
  clerkUsers: number;
  withPhone: number;
  updated: number;
  cleared: number;
}

/**
 * Mirror every Clerk user's onboarding number onto their `users` row. The Clerk
 * list is complete (it throws rather than return a partial one), so a number no
 * longer on Clerk is cleared here. A Clerk user with no `users` row is skipped:
 * there is no account to resolve to until the dashboard has resolved them.
 */
export async function syncOnboardingPhones(): Promise<OnboardingPhoneSyncResult> {
  const clerkUsers = await listClerkUserOnboardingPhones();
  const withPhone = new Map<string, string>();
  for (const u of clerkUsers) {
    const phone = normalizeOnboardingPhone(u.phone);
    if (phone) withPhone.set(u.clerkUserId, phone);
  }

  return db.transaction(async (tx) => {
    let updated = 0;
    for (const [clerkUserId, phone] of withPhone) {
      const rows = await tx
        .update(users)
        .set({ onboardingPhone: phone, updatedAt: new Date() })
        .where(
          and(
            eq(users.externalId, clerkUserId),
            or(isNull(users.onboardingPhone), ne(users.onboardingPhone, phone)),
          ),
        )
        .returning({ id: users.id });
      updated += rows.length;
    }
    const holders = [...withPhone.keys()];
    const cleared = await tx
      .update(users)
      .set({ onboardingPhone: null, updatedAt: new Date() })
      .where(
        and(
          isNotNull(users.onboardingPhone),
          holders.length > 0
            ? or(isNull(users.externalId), notInArray(users.externalId, holders))
            : sql`true`,
        ),
      )
      .returning({ id: users.id });
    return { clerkUsers: clerkUsers.length, withPhone: withPhone.size, updated, cleared: cleared.length };
  });
}

/** A miss-triggered sweep within this window reuses the last one instead of asking Clerk again. */
const FRESH_MS = 15_000;
let inFlight: Promise<OnboardingPhoneSyncResult> | null = null;
let lastDoneAt = 0;

/**
 * Sweep unless one just finished; concurrent callers share the one in flight.
 * Throws when Clerk could not be asked: "could not find out" is not "unknown".
 */
export async function refreshOnboardingPhones(): Promise<void> {
  if (inFlight) {
    await inFlight;
    return;
  }
  if (Date.now() - lastDoneAt < FRESH_MS) return;
  inFlight = syncOnboardingPhones();
  try {
    const result = await inFlight;
    lastDoneAt = Date.now();
    if (result.updated > 0 || result.cleared > 0) {
      console.log("[client-service] onboarding phones synced from Clerk:", JSON.stringify(result));
    }
  } finally {
    inFlight = null;
  }
}

/** Test seam: forget the last sweep so the next miss asks Clerk again. */
export function resetOnboardingPhoneSyncState(): void {
  inFlight = null;
  lastDoneAt = 0;
}

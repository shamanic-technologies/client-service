/**
 * "What is this user's own LinkedIn profile?" Resolved ONCE from a recorded fact
 * about the person (their email), then reused.
 *
 * Discovery: apollo-service `POST /internal/person-identity` (Apollo people/match
 * by email; never by name, two people share a name). Only Apollo's
 * `match_confidence: "high"` counts: a weaker match is `none_found` with the
 * reason, never a guess.
 *
 * States: no row = `not_looked_up`; `found` = URL; `none_found` = reason. A row
 * answers only for the email it was resolved for (`matched_on_email`): when the
 * user's email changes, reads report `not_looked_up` and the next resolve asks
 * again. A vendor failure stores nothing and fails loud (502).
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, userLinkedinProfiles, type UserLinkedinProfile } from "../db/schema.js";
import { lookupPersonIdentity, type PersonIdentity } from "./apollo-service-client.js";

export const NONE_FOUND_REASONS = [
  "no_email_on_record",
  "no_match",
  "weak_match",
  "no_linkedin_on_match",
  "unrecognised_linkedin_url",
] as const;
export type NoneFoundReason = (typeof NONE_FOUND_REASONS)[number];

export const ACCEPTED_MATCH_CONFIDENCE = "high";

export interface LinkedinProfileAnswer {
  userId: string;
  status: "found" | "none_found" | "not_looked_up";
  linkedinUrl: string | null;
  noneFoundReason: NoneFoundReason | null;
  provenance: {
    source: "apollo_people_match_by_email" | "user_record";
    matchedOnEmail: string | null;
    matchConfidence: string | null;
    apolloPersonId: string | null;
    resolvedAt: string;
  } | null;
}

/**
 * `http://www.linkedin.com/in/Patrick-Collison/` → `https://www.linkedin.com/in/patrick-collison`.
 * null when it is not a member profile URL (a company page, a search link...).
 */
export function normalizeLinkedinProfileUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const m = url.pathname.match(/^\/in\/([^/]+)\/?$/);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (!slug.trim()) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(slug.trim().toLowerCase())}`;
}

/** The verdict on one vendor answer. Pure. */
export function judgePersonIdentity(
  identity: Pick<PersonIdentity, "matched" | "matchConfidence" | "linkedinUrl">,
): { status: "found"; linkedinUrl: string } | { status: "none_found"; reason: NoneFoundReason } {
  if (!identity.matched) return { status: "none_found", reason: "no_match" };
  if (identity.matchConfidence !== ACCEPTED_MATCH_CONFIDENCE) return { status: "none_found", reason: "weak_match" };
  if (!identity.linkedinUrl) return { status: "none_found", reason: "no_linkedin_on_match" };
  const url = normalizeLinkedinProfileUrl(identity.linkedinUrl);
  if (!url) return { status: "none_found", reason: "unrecognised_linkedin_url" };
  return { status: "found", linkedinUrl: url };
}

const normEmail = (e: string | null | undefined) => {
  const t = e?.trim().toLowerCase();
  return t ? t : null;
};

function toAnswer(userId: string, row: UserLinkedinProfile): LinkedinProfileAnswer {
  return {
    userId,
    status: row.status as "found" | "none_found",
    linkedinUrl: row.linkedinUrl,
    noneFoundReason: (row.noneFoundReason as NoneFoundReason | null) ?? null,
    provenance: {
      source: row.source as "apollo_people_match_by_email" | "user_record",
      matchedOnEmail: row.matchedOnEmail,
      matchConfidence: row.matchConfidence,
      apolloPersonId: row.apolloPersonId,
      resolvedAt: row.resolvedAt.toISOString(),
    },
  };
}

const notLookedUp = (userId: string): LinkedinProfileAnswer => ({
  userId,
  status: "not_looked_up",
  linkedinUrl: null,
  noneFoundReason: null,
  provenance: null,
});

async function load(userId: string): Promise<{ email: string | null; row: UserLinkedinProfile | null } | null> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  const [row] = await db.select().from(userLinkedinProfiles).where(eq(userLinkedinProfiles.userId, userId)).limit(1);
  const email = normEmail(user.email);
  // A row resolved for another email does not answer for this user any more.
  return { email, row: row && normEmail(row.matchedOnEmail) === email ? row : null };
}

/** Read only: never spends. null = no such user. */
export async function readLinkedinProfile(userId: string): Promise<LinkedinProfileAnswer | null> {
  const loaded = await load(userId);
  if (!loaded) return null;
  return loaded.row ? toAnswer(userId, loaded.row) : notLookedUp(userId);
}

/**
 * Resolve once: a stored answer is returned as is (nothing spent); otherwise
 * ask apollo-service, store the verdict, return it. null = no such user.
 * Throws on a vendor failure (nothing stored).
 */
export async function resolveLinkedinProfile(
  userId: string,
): Promise<{ answer: LinkedinProfileAnswer; lookedUpNow: boolean } | null> {
  const loaded = await load(userId);
  if (!loaded) return null;
  if (loaded.row) return { answer: toAnswer(userId, loaded.row), lookedUpNow: false };

  let values: typeof userLinkedinProfiles.$inferInsert;
  if (!loaded.email) {
    values = {
      userId,
      status: "none_found",
      linkedinUrl: null,
      noneFoundReason: "no_email_on_record",
      source: "user_record",
      matchedOnEmail: null,
      matchConfidence: null,
      apolloPersonId: null,
      vendorResponse: null,
      resolvedAt: new Date(),
    };
  } else {
    const identity = await lookupPersonIdentity(loaded.email);
    const verdict = judgePersonIdentity(identity);
    values = {
      userId,
      status: verdict.status,
      linkedinUrl: verdict.status === "found" ? verdict.linkedinUrl : null,
      noneFoundReason: verdict.status === "none_found" ? verdict.reason : null,
      source: "apollo_people_match_by_email",
      matchedOnEmail: loaded.email,
      matchConfidence: identity.matchConfidence,
      apolloPersonId: identity.apolloPersonId,
      vendorResponse: identity,
      resolvedAt: new Date(),
    };
  }

  const [row] = await db
    .insert(userLinkedinProfiles)
    .values(values)
    .onConflictDoUpdate({ target: userLinkedinProfiles.userId, set: values })
    .returning();
  return { answer: toAnswer(userId, row), lookedUpNow: true };
}

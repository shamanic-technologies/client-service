import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";
import {
  getClerkOrganizationNames,
  listClerkUserMemberships,
  type ClerkUserMembership,
} from "./clerk-client.js";

/**
 * How long an identity-provider answer is reused. This IS the staleness bound
 * published on GET /internal/users/:userId/orgs: a user removed from an
 * organization in Clerk stops being listed at most this long afterwards. It is
 * called on every request a user API key makes, so asking Clerk each time would
 * put Clerk's latency and rate limit on every request of the platform.
 */
export const MEMBERSHIP_CACHE_TTL_MS = 60_000;

/** Bound on cached entries so a key-spraying caller cannot grow memory without limit. */
const MAX_CACHE_ENTRIES = 10_000;

interface CachedMemberships {
  /** null = Clerk does not know this user. */
  memberships: ClerkUserMembership[] | null;
  checkedAt: Date;
}

/**
 * Successful Clerk answers only. A failure is never cached: the next request
 * asks again, and a stale positive answer is never served in place of an error.
 */
const membershipCache = new Map<string, CachedMemberships>();
/** One in-flight Clerk read per user: a burst of requests shares it. */
const inFlight = new Map<string, Promise<CachedMemberships>>();

/** Test hook. */
export function clearMembershipCache(): void {
  membershipCache.clear();
  inFlight.clear();
  nameCache.clear();
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

async function clerkMemberships(clerkUserId: string): Promise<CachedMemberships> {
  const hit = membershipCache.get(clerkUserId);
  if (hit && Date.now() - hit.checkedAt.getTime() < MEMBERSHIP_CACHE_TTL_MS) return hit;

  const pending = inFlight.get(clerkUserId);
  if (pending) return pending;

  const read = (async () => {
    const memberships = await listClerkUserMemberships(clerkUserId);
    const entry = { memberships, checkedAt: new Date(Date.now()) };
    remember(membershipCache, clerkUserId, entry);
    return entry;
  })().finally(() => inFlight.delete(clerkUserId));
  inFlight.set(clerkUserId, read);
  return read;
}

export interface UserOrganization {
  orgId: string;
  externalOrgId: string;
  name: string | null;
  role: string;
}

export interface UnresolvedOrganization {
  externalOrgId: string;
  name: string | null;
  role: string;
  reason: "not_yet_known_to_client_service";
}

export type UserOrganizationsResult =
  | { kind: "user_not_found" }
  | { kind: "user_has_no_identity" }
  | { kind: "identity_not_found" }
  | {
      kind: "ok";
      userId: string;
      organizations: UserOrganization[];
      unresolved: UnresolvedOrganization[];
      checkedAt: Date;
    };

/**
 * The organizations a user belongs to RIGHT NOW, as internal org ids.
 *
 * Membership truth is the identity provider's (Clerk). Our `users.org_id` is the
 * org the user was last active in, not the membership set, so it is not read.
 * Each Clerk organization is mapped to our row by `orgs.external_id`; one we
 * have no row for yet is reported in `unresolved` rather than created here (a
 * row brought into being by a read would make the next /internal/resolve report
 * `orgCreated: false` for a genuinely new org) and rather than dropped silently.
 *
 * Throws ClerkServiceError when Clerk could not be asked.
 */
export async function getUserOrganizations(userId: string): Promise<UserOrganizationsResult> {
  const [user] = await db
    .select({ id: users.id, externalId: users.externalId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return { kind: "user_not_found" };
  if (!user.externalId) return { kind: "user_has_no_identity" };

  const { memberships, checkedAt } = await clerkMemberships(user.externalId);
  if (memberships === null) return { kind: "identity_not_found" };

  const externalIds = memberships.map((m) => m.clerkOrgId);
  const rows =
    externalIds.length === 0
      ? []
      : await db
          .select({ id: orgs.id, externalId: orgs.externalId, name: orgs.name })
          .from(orgs)
          .where(inArray(orgs.externalId, externalIds));
  const byExternal = new Map(rows.map((r) => [r.externalId as string, r]));

  const organizations: UserOrganization[] = [];
  const unresolved: UnresolvedOrganization[] = [];
  for (const m of memberships) {
    const clerkName = m.name || null;
    const row = byExternal.get(m.clerkOrgId);
    if (!row) {
      unresolved.push({
        externalOrgId: m.clerkOrgId,
        name: clerkName,
        role: m.role,
        reason: "not_yet_known_to_client_service",
      });
      continue;
    }
    organizations.push({
      orgId: row.id,
      externalOrgId: m.clerkOrgId,
      // The identity provider's name is the current one; ours can lag or be NULL.
      name: clerkName ?? row.name,
      role: m.role,
    });
    if (row.name === null && clerkName !== null) {
      await backfillName(row.id, clerkName);
    }
  }

  return { kind: "ok", userId: user.id, organizations, unresolved, checkedAt };
}

/**
 * Fill a NULL `orgs.name` with the identity provider's name. Never overwrites a
 * name we hold: /internal/resolve owns name updates; this only closes the gap
 * for orgs no caller ever named.
 */
async function backfillName(orgId: string, name: string): Promise<void> {
  await db
    .update(orgs)
    .set({ name })
    .where(and(eq(orgs.id, orgId), isNull(orgs.name)));
}

/** Clerk org id -> name (null = Clerk does not know it), with the time it was asked. */
const nameCache = new Map<string, { name: string | null; at: number }>();

export interface OrgName {
  orgId: string;
  name: string | null;
}

/**
 * Display names for a set of internal org ids, in one read.
 *
 * Our stored name is returned when we hold one. An org whose name we never
 * recorded, and which carries an identity-provider id (not an anonymous org
 * awaiting a claim), is named from Clerk in one batched call, and the name is
 * written back so the next read does not ask again. Clerk answers are reused for
 * MEMBERSHIP_CACHE_TTL_MS. Throws ClerkServiceError when Clerk could not be asked.
 */
export async function getOrgNames(
  orgIds: string[],
): Promise<{ orgs: OrgName[]; notFound: string[] }> {
  const unique = [...new Set(orgIds)];
  if (unique.length === 0) return { orgs: [], notFound: [] };

  const rows = await db
    .select({
      id: orgs.id,
      externalId: orgs.externalId,
      name: orgs.name,
      anonymousAt: orgs.anonymousAt,
      claimedAt: orgs.claimedAt,
    })
    .from(orgs)
    .where(inArray(orgs.id, unique));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Unnamed orgs that carry an identity-provider identity. An anonymous org
  // still awaiting a claim holds a dashboard-minted id Clerk has never seen.
  const unnamed = rows.filter(
    (r) => r.name === null && r.externalId !== null && (r.anonymousAt === null || r.claimedAt !== null),
  );

  const now = Date.now();
  const toAsk = unnamed
    .map((r) => r.externalId as string)
    .filter((ext) => {
      const hit = nameCache.get(ext);
      return !hit || now - hit.at >= MEMBERSHIP_CACHE_TTL_MS;
    });
  if (toAsk.length > 0) {
    const fetched = await getClerkOrganizationNames(toAsk);
    for (const ext of toAsk) remember(nameCache, ext, { name: fetched.get(ext) ?? null, at: now });
  }

  const resolvedNames = new Map<string, string>();
  for (const r of unnamed) {
    const name = nameCache.get(r.externalId as string)?.name ?? null;
    if (name !== null) {
      resolvedNames.set(r.id, name);
      await backfillName(r.id, name);
    }
  }

  const out: OrgName[] = [];
  const notFound: string[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (!row) {
      notFound.push(id);
      continue;
    }
    out.push({ orgId: id, name: row.name ?? resolvedNames.get(id) ?? null });
  }
  return { orgs: out, notFound };
}

import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs } from "../db/schema.js";
import {
  getClerkOrganizationNames,
  listClerkUserMemberships,
  type ClerkUserMembership,
} from "./clerk-client.js";

/**
 * How long a Clerk answer is reused. This IS the staleness bound both reads
 * document: a user removed from an organization in Clerk stops being listed at
 * most this long after the removal, and a renamed org shows its new name at most
 * this long after the rename. Called on every request made with a user API key,
 * so a live Clerk round trip per request is not affordable; one per user per
 * minute is.
 */
export const IDENTITY_CACHE_TTL_MS = 60_000;

/** Upper bound on cached entries per cache, so a burst of distinct ids cannot grow memory without limit. */
const MAX_ENTRIES = 10_000;

/**
 * A TTL cache over an async loader. Only SUCCESSES are cached: a failed load is
 * dropped, so the next call asks Clerk again rather than replaying the failure
 * (or worse, a defaulted answer). Concurrent misses for the same key share one
 * in-flight request.
 */
function ttlCache<V>() {
  const entries = new Map<string, { expiresAt: number; value: Promise<V> }>();
  return {
    get(key: string, load: () => Promise<V>): Promise<V> {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now) return hit.value;
      if (entries.size >= MAX_ENTRIES) {
        for (const [k, e] of entries) if (e.expiresAt <= now) entries.delete(k);
        if (entries.size >= MAX_ENTRIES) entries.clear();
      }
      const value = load();
      entries.set(key, { expiresAt: now + IDENTITY_CACHE_TTL_MS, value });
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

const membershipCache = ttlCache<ClerkUserMembership[] | "not_found">();
const orgNameCache = ttlCache<string | null>();

/** Test hook: forget every cached Clerk answer. */
export function clearIdentityCaches(): void {
  membershipCache.clear();
  orgNameCache.clear();
}

export interface UserOrg {
  id: string;
  name: string;
  role: string;
}

export interface UnresolvedUserOrg {
  externalOrgId: string;
  name: string;
  role: string;
}

export interface UserOrgs {
  orgs: UserOrg[];
  unresolved: UnresolvedUserOrg[];
}

/**
 * The organizations a Clerk user belongs to, each mapped to the internal org
 * uuid (`x-org-id`). Membership comes from Clerk (cached for the TTL above); the
 * external -> internal mapping is read fresh from our table on every call, so an
 * org that first resolves here a second ago is listed with its id immediately.
 *
 * A Clerk org with no row here is returned under `unresolved`, never dropped and
 * never created: bringing an org into being on an auth read would mint exactly
 * the kind of shell the claim then has to absorb.
 *
 * "not_found" = Clerk does not know this user. Clerk failures propagate.
 */
export async function getUserOrgs(clerkUserId: string): Promise<UserOrgs | "not_found"> {
  const memberships = await membershipCache.get(clerkUserId, () =>
    listClerkUserMemberships(clerkUserId),
  );
  if (memberships === "not_found") return "not_found";
  if (memberships.length === 0) return { orgs: [], unresolved: [] };

  const rows = await db
    .select({ id: orgs.id, externalId: orgs.externalId })
    .from(orgs)
    .where(inArray(orgs.externalId, memberships.map((m) => m.clerkOrgId)));
  const internalIdByExternal = new Map(rows.map((r) => [r.externalId, r.id]));

  const result: UserOrgs = { orgs: [], unresolved: [] };
  for (const m of memberships) {
    const id = internalIdByExternal.get(m.clerkOrgId);
    if (id) result.orgs.push({ id, name: m.name, role: m.role });
    else result.unresolved.push({ externalOrgId: m.clerkOrgId, name: m.name, role: m.role });
  }
  return result;
}

/**
 * Display name for each clerk org id: Clerk's current name (cached for the TTL),
 * or null when Clerk does not know the org. Clerk failures propagate.
 */
export async function getOrgNamesByExternalId(
  clerkOrgIds: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(clerkOrgIds)];
  const result = new Map<string, string | null>();
  const misses: string[] = [];
  const pending: Promise<void>[] = [];

  // One Clerk batch for every id not already cached; each cached entry resolves
  // from that same batch.
  let batch: Promise<Map<string, string>> | null = null;
  const loadBatch = () => {
    batch ??= getClerkOrganizationNames(misses);
    return batch;
  };
  for (const externalId of unique) {
    const value = orgNameCache.get(externalId, () => {
      misses.push(externalId);
      return Promise.resolve().then(() => loadBatch()).then((names) => names.get(externalId) ?? null);
    });
    pending.push(value.then((name) => void result.set(externalId, name)));
  }
  await Promise.all(pending);
  return result;
}

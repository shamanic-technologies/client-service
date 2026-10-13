import { asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { signupFacts, signupFactUnresolved, users, type SignupFact } from "../db/schema.js";
import {
  getClerkOrganizationCreators,
  getClerkUserProfiles,
  isSyntheticPhoneEmail,
} from "./clerk-client.js";

/**
 * SIGNUP FACTS — "a real person signed up to distribute.you", stated by the
 * service that owns the account, for the distribute.you brand's own sales
 * funnel (crm-service copies the feed into its people fact feed, lead-service
 * copies that). Before this, the signup reached the funnel as an echo of Clerk
 * and PostHog mirrored by crm-service.
 *
 * - SIGNUP = an org became REAL: created with an identity provider, or claimed
 *   after a signed-out walk. Same predicate as POST /internal/orgs/real.
 * - The PERSON is the identity-provider user who CREATED the org (Clerk
 *   `createdBy`). `users.org_id` is the last org a user was active in, not who
 *   made it (most orgs a person made earlier hold no user row of ours any more).
 * - `occurredAt` = `claimed_at` for a claimed org, else `created_at`. Never now().
 * - A CORRECTION (the org was torn down, or was a shell absorbed at a claim) is a
 *   `withdrawn` fact naming the one it corrects. Nothing is ever deleted or
 *   updated: a consumer copies each row once.
 * - Derived by DIFF, so the first pass is the backfill and a re-run states
 *   nothing new. An org whose person cannot be named (identity-provider org gone,
 *   no creator) states nothing and is looked at again once a day.
 *
 * The brand is named on every fact and nowhere else: this is the platform's own
 * account ledger, and distribute.you is the brand it is about.
 */
export const DISTRIBUTE_YOU_BRAND_ID = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";

/** A REAL org: never a shell, and not an anonymous walk still awaiting its claim. */
const REAL_ORG = sql`o.absorbed_at IS NULL AND (o.anonymous_at IS NULL OR o.claimed_at IS NOT NULL)`;

const UNRESOLVED_RETRY = sql`interval '1 day'`;

/** Synthetic identities the platform runs itself (probes, workflow admins): never a signup. */
const SYSTEM_IDENTITY_PREFIX = "system-";

export type UnresolvedReason = "identity_provider_org_not_found" | "no_creator" | "creator_not_found" | "system_identity";

export interface ReconcileSummary {
  stated: number;
  withdrawn: number;
  unresolved: number;
}

/** Raw rows: postgres.js hands timestamps of a raw `execute` back as strings. */
interface Candidate {
  id: string;
  external_id: string | null;
  created_at: string;
  claimed_at: string | null;
}

interface Orphan {
  id: string;
  customer_org_id: string;
  org_exists: boolean;
}

async function readCandidates(): Promise<Candidate[]> {
  return db.execute(sql`
    SELECT o.id, o.external_id, o.created_at, o.claimed_at
    FROM orgs o
    WHERE ${REAL_ORG}
      AND NOT EXISTS (SELECT 1 FROM signup_facts f WHERE f.customer_org_id = o.id AND f.type = 'signup')
      AND NOT EXISTS (
        SELECT 1 FROM signup_fact_unresolved u
        WHERE u.org_id = o.id AND u.checked_at > now() - ${UNRESOLVED_RETRY}
      )
    ORDER BY COALESCE(o.claimed_at, o.created_at), o.id
  `) as unknown as Promise<Candidate[]>;
}

/** Live signup facts whose org is no longer real (gone, or absorbed into another org). */
async function readOrphans(): Promise<Orphan[]> {
  return db.execute(sql`
    SELECT f.id, f.customer_org_id, (o.id IS NOT NULL) AS org_exists
    FROM signup_facts f
    LEFT JOIN orgs o ON o.id = f.customer_org_id
    WHERE f.type = 'signup'
      AND NOT EXISTS (SELECT 1 FROM signup_facts w WHERE w.withdrawn_of = f.id)
      AND (o.id IS NULL OR NOT (${REAL_ORG}))
    ORDER BY f.seq
  `) as unknown as Promise<Orphan[]>;
}

/**
 * One pass: state every new signup, withdraw every signup whose org stopped
 * being real. Idle passes (nothing to state, nothing to withdraw) touch no
 * identity provider. The network reads happen BEFORE the transaction; the
 * writes re-check under one advisory lock so `seq` commits in order.
 */
export async function reconcileSignupFacts(): Promise<ReconcileSummary> {
  const [candidates, orphans] = await Promise.all([readCandidates(), readOrphans()]);
  if (candidates.length === 0 && orphans.length === 0) return { stated: 0, withdrawn: 0, unresolved: 0 };

  const creators = await getClerkOrganizationCreators(
    candidates.map((c) => c.external_id).filter((id): id is string => id !== null),
  );
  const creatorIds = [...new Set([...creators.values()].filter((id): id is string => id !== null))];
  const profiles = await getClerkUserProfiles(creatorIds.filter((id) => !id.startsWith(SYSTEM_IDENTITY_PREFIX)));
  const localUsers = creatorIds.length
    ? await db
        .select({ id: users.id, externalId: users.externalId, phone: users.phone })
        .from(users)
        .where(inArray(users.externalId, creatorIds))
    : [];
  const localByExternal = new Map(localUsers.map((u) => [u.externalId, u]));

  const toState: (typeof signupFacts.$inferInsert)[] = [];
  const toSkip: { orgId: string; reason: UnresolvedReason }[] = [];
  for (const c of candidates) {
    const creator = c.external_id === null ? undefined : creators.get(c.external_id);
    if (creator === undefined) {
      toSkip.push({ orgId: c.id, reason: "identity_provider_org_not_found" });
      continue;
    }
    if (creator === null) {
      toSkip.push({ orgId: c.id, reason: "no_creator" });
      continue;
    }
    if (creator.startsWith(SYSTEM_IDENTITY_PREFIX)) {
      toSkip.push({ orgId: c.id, reason: "system_identity" });
      continue;
    }
    const profile = profiles.get(creator);
    if (!profile) {
      toSkip.push({ orgId: c.id, reason: "creator_not_found" });
      continue;
    }
    const local = localByExternal.get(creator);
    toState.push({
      type: "signup",
      brandId: DISTRIBUTE_YOU_BRAND_ID,
      customerOrgId: c.id,
      clerkOrgId: c.external_id,
      userId: local?.id ?? null,
      clerkUserId: creator,
      // A phone-origin account's address is a placeholder no one reads: the
      // person is reachable on the phone, so the fact says that instead.
      email: profile.email && !isSyntheticPhoneEmail(profile.email) ? profile.email : null,
      firstName: profile.firstName,
      lastName: profile.lastName,
      phone: local?.phone ?? null,
      occurredAt: new Date(c.claimed_at ?? c.created_at),
      dateBasis: c.claimed_at ? "org_claimed_at" : "org_created_at",
    });
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('client-service:signup_facts'))`);
    let stated = 0;
    let withdrawn = 0;

    for (const fact of toState) {
      // Re-checked under the lock: still real, still without a fact.
      const [still] = (await tx.execute(sql`
        SELECT 1 AS ok FROM orgs o
        WHERE o.id = ${fact.customerOrgId} AND ${REAL_ORG}
          AND NOT EXISTS (SELECT 1 FROM signup_facts f WHERE f.customer_org_id = o.id AND f.type = 'signup')
      `)) as unknown as { ok: number }[];
      if (!still) continue;
      await tx.insert(signupFacts).values(fact);
      await tx.delete(signupFactUnresolved).where(eq(signupFactUnresolved.orgId, fact.customerOrgId));
      stated++;
    }

    for (const orphan of orphans) {
      const [original] = await tx.select().from(signupFacts).where(eq(signupFacts.id, orphan.id));
      const [already] = await tx
        .select({ id: signupFacts.id })
        .from(signupFacts)
        .where(eq(signupFacts.withdrawnOf, orphan.id));
      if (already) continue;
      const [org] = (await tx.execute(sql`
        SELECT (${REAL_ORG}) AS real FROM orgs o WHERE o.id = ${orphan.customer_org_id}
      `)) as unknown as { real: boolean }[];
      if (org?.real) continue;
      await tx.insert(signupFacts).values({
        ...withoutServedBookkeeping(original),
        type: "withdrawn",
        withdrawnOf: original.id,
        withdrawnReason: org ? "org_absorbed" : "org_deleted",
      });
      withdrawn++;
    }

    for (const skip of toSkip) {
      await tx
        .insert(signupFactUnresolved)
        .values({ orgId: skip.orgId, reason: skip.reason })
        .onConflictDoUpdate({
          target: signupFactUnresolved.orgId,
          set: { reason: skip.reason, checkedAt: new Date() },
        });
    }

    return { stated, withdrawn, unresolved: toSkip.length };
  });
}

/** The subject of a fact, copied onto its withdrawal so a consumer needs no join. */
function withoutServedBookkeeping(fact: SignupFact): typeof signupFacts.$inferInsert {
  const { id: _id, seq: _seq, recordedAt: _recordedAt, withdrawnOf: _of, withdrawnReason: _reason, ...subject } = fact;
  return subject;
}

export interface SignupFactView {
  factId: string;
  seq: number;
  type: "signup" | "withdrawn";
  brandId: string;
  customerOrgId: string;
  clerkOrgId: string | null;
  userId: string | null;
  clerkUserId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  phone: string | null;
  occurredAt: string;
  dateBasis: string;
  withdrawnOf: string | null;
  withdrawnReason: string | null;
  recordedAt: string;
}

function toView(f: SignupFact): SignupFactView {
  const fullName = [f.firstName, f.lastName].filter((p) => p && p.trim()).join(" ") || null;
  return {
    factId: f.id,
    seq: f.seq,
    type: f.type as SignupFactView["type"],
    brandId: f.brandId,
    customerOrgId: f.customerOrgId,
    clerkOrgId: f.clerkOrgId,
    userId: f.userId,
    clerkUserId: f.clerkUserId,
    email: f.email,
    firstName: f.firstName,
    lastName: f.lastName,
    fullName,
    phone: f.phone,
    occurredAt: f.occurredAt.toISOString(),
    dateBasis: f.dateBasis,
    withdrawnOf: f.withdrawnOf,
    withdrawnReason: f.withdrawnReason,
    recordedAt: f.recordedAt.toISOString(),
  };
}

/** The feed, in `seq` order after the cursor. */
export async function readSignupFacts(since: number, limit: number) {
  const rows = await db
    .select()
    .from(signupFacts)
    .where(gt(signupFacts.seq, since))
    .orderBy(asc(signupFacts.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    facts: page.map(toView),
    nextCursor: String(page.length ? page[page.length - 1].seq : since),
    hasMore: rows.length > limit,
  };
}

const TICK_MS = 60_000;
let running = false;

/** One tick, never overlapping the last. A failure is logged loud and retried next tick. */
export async function signupFactTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const summary = await reconcileSignupFacts();
    if (summary.stated || summary.withdrawn || summary.unresolved) {
      console.log("[client-service] signup facts:", JSON.stringify(summary));
    }
  } catch (err) {
    console.error("[client-service] signup-fact reconciliation failed:", err);
  } finally {
    running = false;
  }
}

/** Started after listen: first pass a minute after boot, then every minute. */
export function startSignupFactTicker(): void {
  setInterval(() => void signupFactTick(), TICK_MS).unref();
}

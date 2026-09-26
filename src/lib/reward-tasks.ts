import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifyProductTaskCompleted } from "./billing-service-client.js";
import {
  listOrgsClaimingBrand,
  readBrandOfferEconomics,
  type BrandLegRate,
  type OfferLifetimeRevenue,
} from "./brand-service-client.js";

/**
 * The reward ledger: which product tasks exist for a scope, whether each is DUE,
 * since when, and when it was last DONE.
 *
 * client-service owns this because it is the identity root and nothing else in
 * the fleet remembers it. The ledger is layered: BRONZE is what brand-service
 * actually served us, SILVER is the canonical per-task state derived from it,
 * GOLD is the `reward_task_status` view that answers the question.
 *
 * THE GRANULARITY IS THE OFFER. A brand states its conversion rates per LEG
 * (brand grain, shared by every offer) and its lifetime revenue per OFFER, and
 * brand-service serves both in one read. An offer's money content is therefore
 * its own lifetime revenue plus the brand's stated leg rates. (The ledger was
 * first built on the sales funnel; the product retired that concept, and
 * migration 0016 carried every funnel's clock onto its offer.)
 *
 * WHY A LEDGER AT ALL — brand-service serves a `statedAt` with each number, but
 * that timestamp is NOT a confirmation that anybody refreshed anything: it also
 * moves when an unchanged number is saved again. A ledger keyed on it would mark
 * a task done that nobody did, and pay a dollar for it. So we judge a completion
 * on the only evidence that cannot be faked that way: the MONEY CONTENT itself,
 * compared against what we last stored.
 *
 * NO BACKGROUND JOB. Every state transition is observed on READ. The customer is
 * on the offer's page when they save their numbers and the dashboard re-reads
 * the task list immediately after, so the read that matters always happens; a
 * sweep nobody reads would be worse than none.
 */

/** The first, and so far only, reward task. */
export const OFFER_ECONOMICS_REFRESH_TASK = "offer_economics_refresh";

/** What one completed task pays the customer. */
export const REWARD_CENTS = 100;

/** Raised when a brand is claimed by several orgs and the caller named none. */
export class RewardScopeAmbiguousError extends Error {
  constructor(public readonly orgIds: string[]) {
    super(
      `[client-service] ${orgIds.length} orgs claim this brand; x-org-id is required to say whose reward ledger to read`,
    );
    this.name = "RewardScopeAmbiguousError";
  }
}

/**
 * Raised when brand-service serves a STATED number with no usable `statedAt`.
 * A first sighting needs that instant as its baseline, and we refuse to invent one.
 */
export class StatedAtMissingError extends Error {
  constructor(offerId: string, detail: string) {
    super(
      `[client-service] brand-service served offer ${offerId} with ${detail}; refusing to invent a baseline for its refresh clock`,
    );
    this.name = "StatedAtMissingError";
  }
}

export type RewardTaskScope = {
  type: "offer";
  brandId: string;
  offerId: string;
};

export type RewardTask = {
  taskKey: string;
  scope: RewardTaskScope;
  rewardCents: number;
  /** True when the refresh is currently owed. */
  due: boolean;
  /**
   * The instant this task becomes due. While `due` is false it is in the future;
   * when `due` is true it is SINCE WHEN the refresh has been owed.
   */
  dueAt: string;
  lastCompletedAt: string | null;
  completedCount: number;
  contentChangedAt: string;
  contentChangedProvenance: "observed" | "producer_ts";
};

export type RewardTaskRollup = { dueCount: number; taskCount: number };

export type BrandRewardTasks = {
  brandId: string;
  /** Null only when no org claims the brand — there is then nobody to reward. */
  orgId: string | null;
  status: "ok" | "no_org_claims_brand";
  rewardCentsPerTask: number;
  tasks: RewardTask[];
  /**
   * How many children of a SUPERIOR scope have something due, without restating
   * the children's tasks: a brand page renders `brand`, an offer page renders its
   * entry in `offers`.
   */
  rollup: { brand: RewardTaskRollup; offers: Array<{ offerId: string } & RewardTaskRollup> };
};

/** Recursively order object keys so equal content always stringifies identically. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
    return out;
  }
  return value;
}

/** The leg rates the brand has actually STATED. An unstated leg is not content. */
function statedLegs(legRates: readonly BrandLegRate[]): BrandLegRate[] {
  return legRates.filter((leg) => leg.stated);
}

/**
 * Fingerprint the MONEY CONTENT of an offer — the numbers the customer is asked
 * to refresh, and nothing else: the offer's lifetime revenue and the brand's
 * STATED leg rates.
 *
 * `statedAt` is deliberately absent: re-saving an unchanged number moves it, so
 * including it would let a no-op save complete the task and pay for it. Unstated
 * legs are absent too: brand-service lists every leg it knows, stated or not, so
 * a leg it newly learns would otherwise change the fingerprint with nobody
 * having touched a number. `name` is absent: renaming an offer refreshes nothing.
 */
export function fingerprintOfferContent(
  offer: Pick<OfferLifetimeRevenue, "lifetimeRevenueUsd">,
  legRates: readonly BrandLegRate[],
): string {
  const legs = statedLegs(legRates)
    .map((leg) => ({ fromStep: leg.fromStep, toStep: leg.toStep, ratePct: leg.ratePct }))
    .sort((a, b) =>
      a.fromStep === b.fromStep
        ? a.toStep.localeCompare(b.toStep)
        : a.fromStep.localeCompare(b.fromStep),
    );
  const content = canonical({ lifetimeRevenueUsd: offer.lifetimeRevenueUsd, legRates: legs });
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/**
 * brand-service serves Postgres-style instants (`2026-09-25 07:03:47.40352+00`),
 * which `Date` does not reliably parse. Normalise to ISO or refuse.
 */
function parseProducerInstant(value: string): number | null {
  const iso = value.trim().replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The latest `statedAt` across an offer's money content, or null when nothing is
 * stated at all. A STATED number without a usable instant is a producer defect,
 * and we fail loud rather than guess.
 */
export function latestStatedAt(
  offer: OfferLifetimeRevenue,
  legRates: readonly BrandLegRate[],
): string | null {
  const instants: number[] = [];
  const take = (statedAt: string | null, what: string) => {
    const ms = statedAt === null ? null : parseProducerInstant(statedAt);
    if (ms === null) throw new StatedAtMissingError(offer.offerId, `${what} stated without a usable statedAt (${statedAt})`);
    instants.push(ms);
  };
  if (offer.lifetimeRevenueUsd !== null) take(offer.lifetimeRevenueStatedAt, "lifetime revenue");
  for (const leg of statedLegs(legRates)) take(leg.statedAt, `leg ${leg.fromStep} -> ${leg.toStep}`);
  return instants.length === 0 ? null : new Date(Math.max(...instants)).toISOString();
}

type LockedState = {
  id: string;
  content_fingerprint: string | null;
  due_at: string;
  is_due: boolean;
};

/**
 * Record one observation of one offer's money content, and complete the task
 * when that content genuinely changed while the refresh was owed.
 *
 * Serialized per (org, offer) on the silver row, so two dashboard reads landing
 * together cannot both see the old fingerprint. The unique index on
 * (state, due_at) is the hard backstop: one completion per window, whatever races.
 */
async function observeOffer(params: {
  orgId: string;
  brandId: string;
  offer: OfferLifetimeRevenue;
  legRates: readonly BrandLegRate[];
  statedAt: string;
}): Promise<void> {
  const { orgId, brandId, offer, legRates, statedAt } = params;
  const fingerprint = fingerprintOfferContent(offer, legRates);

  await db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT
        id,
        content_fingerprint,
        reward_task_due_at(content_changed_at) AS due_at,
        (now() >= reward_task_due_at(content_changed_at)) AS is_due
      FROM reward_task_states
      WHERE org_id = ${orgId}
        AND offer_id = ${offer.offerId}
        AND task_key = ${OFFER_ECONOMICS_REFRESH_TASK}
      FOR UPDATE
    `)) as unknown as LockedState[];

    const state = locked[0];

    const appendBronze = async () => {
      await tx.execute(sql`
        INSERT INTO reward_offer_observations
          (org_id, brand_id, offer_id, content_fingerprint, payload, producer_stated_at)
        VALUES (
          ${orgId}, ${brandId}, ${offer.offerId}, ${fingerprint},
          ${JSON.stringify({ offer: offer.raw, legRates: statedLegs(legRates) })}::jsonb,
          ${statedAt}
        )
      `);
    };

    // FIRST SIGHTING. We have never seen this offer, so we cannot know when its
    // numbers last changed — only the producer's latest statedAt, which a no-op
    // re-save may have moved forward. Using it makes the task come due no
    // EARLIER than it should; we never invent an earlier date to pay sooner. No
    // completion here: nobody refreshed anything by us looking.
    if (!state) {
      await tx.execute(sql`
        INSERT INTO reward_task_states
          (org_id, brand_id, offer_id, task_key, content_fingerprint,
           content_changed_at, content_changed_provenance)
        VALUES (
          ${orgId}, ${brandId}, ${offer.offerId}, ${OFFER_ECONOMICS_REFRESH_TASK},
          ${fingerprint}, ${statedAt}, 'producer_ts'
        )
        ON CONFLICT (org_id, offer_id, task_key) DO NOTHING
      `);
      await appendBronze();
      return;
    }

    // CARRIED CLOCK. Migration 0016 moved this offer's clock over from the
    // retired sales-funnel grain with no fingerprint, because the old one was
    // over a different shape. Adopt the current content as the baseline and keep
    // the clock: the change of SHAPE is not a refresh and must not pay.
    if (state.content_fingerprint === null) {
      await tx.execute(sql`
        UPDATE reward_task_states
        SET content_fingerprint = ${fingerprint}, last_observed_at = now()
        WHERE id = ${state.id}
      `);
      await appendBronze();
      return;
    }

    // UNCHANGED. Includes an unchanged number saved again: its statedAt moved,
    // not one number did, so there is nothing to complete and nothing to pay.
    // Only the observation clock moves.
    if (state.content_fingerprint === fingerprint) {
      await tx.execute(sql`
        UPDATE reward_task_states SET last_observed_at = now() WHERE id = ${state.id}
      `);
      return;
    }

    // CHANGED. The customer edited a number we are tracking.
    if (state.is_due) {
      // The refresh was owed, so this closes the window and earns the reward.
      // ON CONFLICT is the backstop that makes the dollar payable once per window
      // however many times they save inside it.
      await tx.execute(sql`
        INSERT INTO reward_task_completions
          (reward_task_state_id, org_id, task_key, due_at, reward_cents)
        VALUES (${state.id}, ${orgId}, ${OFFER_ECONOMICS_REFRESH_TASK}, ${state.due_at}, ${REWARD_CENTS})
        ON CONFLICT (reward_task_state_id, due_at) DO NOTHING
      `);
    }

    // Whether or not it was owed, the numbers are fresh again: the clock restarts
    // from now, and this time we OBSERVED the change rather than inheriting a
    // producer timestamp. An edit made early simply buys the customer another 30
    // days; it does not pay, because nothing was owed.
    await tx.execute(sql`
      UPDATE reward_task_states
      SET content_fingerprint = ${fingerprint},
          content_changed_at = now(),
          content_changed_provenance = 'observed',
          last_observed_at = now()
      WHERE id = ${state.id}
    `);
    await appendBronze();
  });
}

/**
 * Hand billing every completion of this org it has not acknowledged yet.
 *
 * Org-wide rather than brand-wide on purpose: a completion whose notification
 * failed must not be stranded because the customer stopped visiting that one
 * brand's page. The marker is written only AFTER billing answers, so a failure
 * leaves it NULL and the next read retries; a crash between the two cannot mark
 * a payment delivered that never was.
 *
 * Fail loud: the first failure throws, and the route turns it into a 502.
 */
async function deliverPendingCompletions(orgId: string): Promise<void> {
  const pending = (await db.execute(sql`
    SELECT id, reward_cents
    FROM reward_task_completions
    WHERE org_id = ${orgId} AND billing_notified_at IS NULL
    ORDER BY completed_at ASC
  `)) as unknown as Array<{ id: string; reward_cents: number }>;

  for (const completion of pending) {
    await notifyProductTaskCompleted({
      orgId,
      completionId: completion.id,
      amountCents: completion.reward_cents,
    });

    await db.execute(sql`
      UPDATE reward_task_completions
      SET billing_notified_at = now()
      WHERE id = ${completion.id} AND billing_notified_at IS NULL
    `);
  }
}

type GoldRow = {
  offer_id: string;
  task_key: string;
  content_changed_at: string;
  content_changed_provenance: "observed" | "producer_ts";
  due_at: string;
  is_due: boolean;
  last_completed_at: string | null;
  completed_count: string | number;
};

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The reward tasks of one brand's offers: observe what brand-service is
 * serving right now, pay for anything that completed, then answer from gold.
 *
 * `orgId` names whose ledger to read. It may be omitted when exactly one org
 * claims the brand; several claiming orgs is a caller error (we will not guess
 * whose money it is) and none means nobody can be rewarded at all.
 */
export async function resolveBrandRewardTasks(
  brandId: string,
  requestedOrgId?: string,
): Promise<BrandRewardTasks> {
  let orgId = requestedOrgId ?? null;

  if (!orgId) {
    const claims = await listOrgsClaimingBrand(brandId);
    const orgIds = [...new Set(claims.map((claim) => claim.orgId))];

    if (orgIds.length === 0) {
      // Not a failure and not a silent "nothing is due": brand-service reports
      // that no org claims this id, so there is no customer to reward. The status
      // says so in as many words.
      return {
        brandId,
        orgId: null,
        status: "no_org_claims_brand",
        rewardCentsPerTask: REWARD_CENTS,
        tasks: [],
        rollup: { brand: { dueCount: 0, taskCount: 0 }, offers: [] },
      };
    }

    if (orgIds.length > 1) throw new RewardScopeAmbiguousError(orgIds);
    orgId = orgIds[0];
  }

  const { legRates, offers } = await readBrandOfferEconomics(brandId, orgId);

  // A brand with no offers answers cleanly: there are no tasks at this scope,
  // which is a real answer, not a gap.
  //
  // An offer whose money content has never been stated at all (no lifetime
  // revenue, no leg rate) has nothing that can go stale, so it has no refresh
  // task: we have no instant to start its clock from, and we will not invent
  // one. The moment a number is stated, the next read starts the clock from it.
  const live = new Set<string>();
  for (const offer of offers) {
    const statedAt = latestStatedAt(offer, legRates);
    if (statedAt === null) continue;
    await observeOffer({ orgId, brandId, offer, legRates, statedAt });
    live.add(offer.offerId);
  }

  await deliverPendingCompletions(orgId);

  const rows = (await db.execute(sql`
    SELECT offer_id, task_key, content_changed_at, content_changed_provenance,
           due_at, is_due, last_completed_at, completed_count
    FROM reward_task_status
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
      AND task_key = ${OFFER_ECONOMICS_REFRESH_TASK}
    ORDER BY offer_id
  `)) as unknown as GoldRow[];

  const tasks: RewardTask[] = rows
    .filter((row) => live.has(row.offer_id))
    .map((row) => ({
      taskKey: row.task_key,
      scope: { type: "offer", brandId, offerId: row.offer_id },
      rewardCents: REWARD_CENTS,
      due: row.is_due === true,
      dueAt: iso(row.due_at),
      lastCompletedAt: row.last_completed_at === null ? null : iso(row.last_completed_at),
      completedCount: Number(row.completed_count),
      contentChangedAt: iso(row.content_changed_at),
      contentChangedProvenance: row.content_changed_provenance,
    }));

  const perOffer = new Map<string, RewardTaskRollup>();
  for (const offer of offers) perOffer.set(offer.offerId, { dueCount: 0, taskCount: 0 });
  for (const task of tasks) {
    const entry = perOffer.get(task.scope.offerId) ?? { dueCount: 0, taskCount: 0 };
    entry.taskCount += 1;
    if (task.due) entry.dueCount += 1;
    perOffer.set(task.scope.offerId, entry);
  }

  return {
    brandId,
    orgId,
    status: "ok",
    rewardCentsPerTask: REWARD_CENTS,
    tasks,
    rollup: {
      brand: {
        dueCount: tasks.filter((task) => task.due).length,
        taskCount: tasks.length,
      },
      offers: [...perOffer.entries()].map(([offerId, rollup]) => ({ offerId, ...rollup })),
    },
  };
}

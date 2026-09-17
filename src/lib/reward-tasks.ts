import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { notifyProductTaskCompleted } from "./billing-service-client.js";
import {
  listBrandOffers,
  listOfferSalesFunnels,
  listOrgsClaimingBrand,
  type OfferSalesFunnel,
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
 * WHY A LEDGER AT ALL — brand-service owns a funnel's money numbers and serves a
 * last-touched timestamp with them, but that timestamp is NOT a confirmation
 * that anybody refreshed anything: it also moves when a funnel is merely
 * switched off or back on. A ledger keyed on it would mark a task done that
 * nobody did, and pay a dollar for it. So we judge a completion on the only
 * evidence that cannot be faked by a toggle: the MONEY CONTENT itself, compared
 * against what we last stored.
 *
 * NO BACKGROUND JOB. Every state transition is observed on READ. The customer is
 * on the funnel's page when they save their numbers and the dashboard re-reads
 * the task list immediately after, so the read that matters always happens; a
 * sweep nobody reads would be worse than none.
 */

/** The first, and so far only, reward task. */
export const SALES_FUNNEL_REFRESH_TASK = "sales_funnel_refresh";

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

/** Raised when brand-service serves a funnel with no last-touched timestamp. */
export class FunnelTimestampMissingError extends Error {
  constructor(offerId: string, funnelKey: string) {
    super(
      `[client-service] brand-service served offer ${offerId} funnel ${funnelKey} with no updatedAt; refusing to invent a baseline for its refresh clock`,
    );
    this.name = "FunnelTimestampMissingError";
  }
}

export type RewardTaskScope = {
  type: "sales_funnel";
  brandId: string;
  offerId: string;
  funnelKey: string;
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

/**
 * Fingerprint the MONEY CONTENT of a funnel — the numbers and links the customer
 * is asked to refresh, and nothing else.
 *
 * `active` and `updatedAt` are deliberately absent. Those two are exactly what a
 * toggle moves, so including either would let switching a funnel off and back on
 * complete a task and pay for it. `name` is absent for the same reason in
 * reverse: renaming a funnel refreshes no number.
 */
export function fingerprintFunnelContent(funnel: OfferSalesFunnel): string {
  const content = canonical({
    rates: funnel.rates,
    arrows: funnel.arrows,
    lifetimeRevenueUsd: funnel.lifetimeRevenueUsd,
    destinationUrl: funnel.destinationUrl,
    bookingUrl: funnel.bookingUrl,
  });
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

type LockedState = {
  id: string;
  content_fingerprint: string;
  due_at: string;
  is_due: boolean;
};

/**
 * Record one observation of one funnel, and complete the task when the money
 * content genuinely changed while the refresh was owed.
 *
 * Serialized per (org, offer, funnel) on the silver row, so two dashboard reads
 * landing together cannot both see the old fingerprint. The unique index on
 * (state, due_at) is the hard backstop: one completion per window, whatever races.
 */
async function observeFunnel(params: {
  orgId: string;
  brandId: string;
  offerId: string;
  funnel: OfferSalesFunnel;
}): Promise<void> {
  const { orgId, brandId, offerId, funnel } = params;
  const fingerprint = fingerprintFunnelContent(funnel);

  if (!funnel.updatedAt) {
    throw new FunnelTimestampMissingError(offerId, funnel.funnelKey);
  }

  await db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      SELECT
        id,
        content_fingerprint,
        reward_task_due_at(content_changed_at) AS due_at,
        (now() >= reward_task_due_at(content_changed_at)) AS is_due
      FROM reward_task_states
      WHERE org_id = ${orgId}
        AND offer_id = ${offerId}
        AND funnel_key = ${funnel.funnelKey}
        AND task_key = ${SALES_FUNNEL_REFRESH_TASK}
      FOR UPDATE
    `)) as unknown as LockedState[];

    const state = locked[0];

    const appendBronze = async () => {
      await tx.execute(sql`
        INSERT INTO reward_funnel_observations
          (org_id, brand_id, offer_id, funnel_key, content_fingerprint, payload, producer_updated_at)
        VALUES (
          ${orgId}, ${brandId}, ${offerId}, ${funnel.funnelKey}, ${fingerprint},
          ${JSON.stringify(funnel.raw)}::jsonb, ${funnel.updatedAt}
        )
      `);
    };

    // FIRST SIGHTING. We have never seen this funnel, so we cannot know when its
    // numbers last changed — only the producer's own updatedAt, which a toggle
    // may have moved forward. Using it makes the task come due no EARLIER than it
    // should; we never invent an earlier date to pay sooner. No completion here:
    // nobody refreshed anything by us looking.
    if (!state) {
      await tx.execute(sql`
        INSERT INTO reward_task_states
          (org_id, brand_id, offer_id, funnel_key, task_key, content_fingerprint,
           content_changed_at, content_changed_provenance)
        VALUES (
          ${orgId}, ${brandId}, ${offerId}, ${funnel.funnelKey}, ${SALES_FUNNEL_REFRESH_TASK},
          ${fingerprint}, ${funnel.updatedAt}, 'producer_ts'
        )
        ON CONFLICT (org_id, offer_id, funnel_key, task_key) DO NOTHING
      `);
      await appendBronze();
      return;
    }

    // UNCHANGED. Includes a funnel that was switched off and back on: it vanishes
    // from brand-service's active list and returns with the same numbers, so
    // there is nothing to complete and nothing to pay. Only the observation clock
    // moves.
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
        VALUES (${state.id}, ${orgId}, ${SALES_FUNNEL_REFRESH_TASK}, ${state.due_at}, ${REWARD_CENTS})
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
  funnel_key: string;
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
 * The reward tasks of one brand's sales funnels: observe what brand-service is
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

  const offers = await listBrandOffers(brandId, orgId);

  // A brand with no offers, or an offer with no active funnels, answers cleanly:
  // there are no tasks at this scope, which is a real answer, not a gap.
  //
  // brand-service lists only ACTIVE funnels, so `live` is exactly the set that
  // exists for the customer right now. A funnel switched off keeps its silver row
  // — that is what lets its refresh clock survive the toggle — but it is not
  // served as a task: nobody can refresh numbers on a funnel that is off, and we
  // will not nag them about one.
  const live = new Set<string>();
  for (const offer of offers) {
    const funnels = await listOfferSalesFunnels(offer.offerId);
    for (const funnel of funnels) {
      await observeFunnel({ orgId, brandId, offerId: offer.offerId, funnel });
      live.add(`${offer.offerId}:${funnel.funnelKey}`);
    }
  }

  await deliverPendingCompletions(orgId);

  const rows = (await db.execute(sql`
    SELECT offer_id, funnel_key, task_key, content_changed_at, content_changed_provenance,
           due_at, is_due, last_completed_at, completed_count
    FROM reward_task_status
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
    ORDER BY offer_id, funnel_key
  `)) as unknown as GoldRow[];

  const tasks: RewardTask[] = rows
    .filter((row) => live.has(`${row.offer_id}:${row.funnel_key}`))
    .map((row) => ({
      taskKey: row.task_key,
      scope: { type: "sales_funnel", brandId, offerId: row.offer_id, funnelKey: row.funnel_key },
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

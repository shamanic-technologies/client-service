import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * Moves everything this service holds for one brand from one org to another:
 * the brand's reward-task ledger. Nothing else here is keyed on a brand —
 * members, invites, first touch and phone accounts belong to the ORG and never
 * move with a brand.
 *
 * HISTORY, NOT MONEY. A completion billing-service already acknowledged is
 * paid; its grant lives in billing's ledger and this transfer never calls
 * billing, so moving the row relabels history and moves no money. The content
 * fingerprint and the 30-day clock travel with the silver row, so the first
 * read under the target org sees unchanged content and pays nothing.
 *
 * A completion NOT yet acknowledged is money still owed to the source org: the
 * next read of whichever org holds it pays it. Moving it would pay the target
 * for the source's work, so we refuse instead of changing either balance.
 */

export type TransferBrandParams = {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
};

export type UpdatedTable = { tableName: string; count: number };

export type TransferBrandRefusal =
  | { reason: "target_org_not_found" }
  | { reason: "undelivered_reward_completions"; count: number }
  | { reason: "target_already_holds_offer_task"; offerIds: string[] };

export type TransferBrandResult =
  | { ok: true; updatedTables: UpdatedTable[] }
  | { ok: false; refusal: TransferBrandRefusal };

class Refused extends Error {
  constructor(readonly refusal: TransferBrandRefusal) {
    super(refusal.reason);
  }
}

export async function transferBrand(params: TransferBrandParams): Promise<TransferBrandResult> {
  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = params;
  const brandAfter = targetBrandId ?? sourceBrandId;

  try {
    const updatedTables = await db.transaction(async (tx) => {
      const target = (await tx.execute(sql`
        SELECT id FROM orgs WHERE id = ${targetOrgId}
      `)) as unknown as Array<{ id: string }>;
      if (target.length === 0) throw new Refused({ reason: "target_org_not_found" });

      // Lock the source ledger so a concurrent reward read cannot record or
      // deliver a completion between the checks below and the move.
      const states = (await tx.execute(sql`
        SELECT id, offer_id, task_key
        FROM reward_task_states
        WHERE org_id = ${sourceOrgId} AND brand_id = ${sourceBrandId}
        FOR UPDATE
      `)) as unknown as Array<{ id: string; offer_id: string; task_key: string }>;

      if (states.length > 0) {
        const undelivered = (await tx.execute(sql`
          SELECT count(*)::int AS count
          FROM reward_task_completions c
          JOIN reward_task_states s ON s.id = c.reward_task_state_id
          WHERE s.org_id = ${sourceOrgId} AND s.brand_id = ${sourceBrandId}
            AND c.billing_notified_at IS NULL
        `)) as unknown as Array<{ count: number }>;
        if (undelivered[0].count > 0) {
          throw new Refused({ reason: "undelivered_reward_completions", count: undelivered[0].count });
        }

        // (org, offer, task) is unique: the target cannot already track the
        // same offer. Merging two ledgers is not something we can do honestly.
        const clashes = (await tx.execute(sql`
          SELECT t.offer_id
          FROM reward_task_states t
          JOIN reward_task_states s
            ON s.offer_id = t.offer_id AND s.task_key = t.task_key
          WHERE t.org_id = ${targetOrgId}
            AND s.org_id = ${sourceOrgId} AND s.brand_id = ${sourceBrandId}
        `)) as unknown as Array<{ offer_id: string }>;
        if (clashes.length > 0) {
          throw new Refused({
            reason: "target_already_holds_offer_task",
            offerIds: clashes.map((row) => row.offer_id),
          });
        }
      }

      const completions = (await tx.execute(sql`
        UPDATE reward_task_completions c
        SET org_id = ${targetOrgId}
        FROM reward_task_states s
        WHERE s.id = c.reward_task_state_id
          AND s.org_id = ${sourceOrgId} AND s.brand_id = ${sourceBrandId}
        RETURNING c.id
      `)) as unknown as unknown[];

      const movedStates = (await tx.execute(sql`
        UPDATE reward_task_states
        SET org_id = ${targetOrgId}, brand_id = ${brandAfter}
        WHERE org_id = ${sourceOrgId} AND brand_id = ${sourceBrandId}
        RETURNING id
      `)) as unknown as unknown[];

      const movedObservations = (await tx.execute(sql`
        UPDATE reward_offer_observations
        SET org_id = ${targetOrgId}, brand_id = ${brandAfter}
        WHERE org_id = ${sourceOrgId} AND brand_id = ${sourceBrandId}
        RETURNING id
      `)) as unknown as unknown[];

      // MERGE: the source brand id ceases to exist fleet-wide (brand-service
      // rewrites every reference), so any other org's rows naming it follow.
      let remappedStates: unknown[] = [];
      let remappedObservations: unknown[] = [];
      if (targetBrandId) {
        remappedStates = (await tx.execute(sql`
          UPDATE reward_task_states SET brand_id = ${targetBrandId}
          WHERE brand_id = ${sourceBrandId}
          RETURNING id
        `)) as unknown as unknown[];
        remappedObservations = (await tx.execute(sql`
          UPDATE reward_offer_observations SET brand_id = ${targetBrandId}
          WHERE brand_id = ${sourceBrandId}
          RETURNING id
        `)) as unknown as unknown[];
      }

      return [
        { tableName: "reward_task_states", count: movedStates.length + remappedStates.length },
        { tableName: "reward_offer_observations", count: movedObservations.length + remappedObservations.length },
        { tableName: "reward_task_completions", count: completions.length },
      ];
    });

    return { ok: true, updatedTables };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

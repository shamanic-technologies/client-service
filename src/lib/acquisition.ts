import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgAcquisitions, type OrgAcquisition } from "../db/schema.js";

/**
 * An org's FIRST TOUCH: which acquisition channel brought it.
 *
 * Written once and never updated. Every hand-over after the first is accepted
 * and ignored (INSERT … ON CONFLICT DO NOTHING on the org's uuid), so a later
 * visit, a replayed request or the ordinary-signup hand-over that follows a
 * claim can never move the credit. The uuid is what a claim preserves, which is
 * why an anonymous org keeps the touch recorded before it was claimed.
 *
 * Every value is untrusted browser-derived text: bounded by the request schema,
 * stored verbatim, nothing assumed about which fields are present.
 */

/** What a caller hands over. Mirrors AcquisitionSchema in schemas.ts. */
export type AcquisitionInput = {
  channel: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
  homepageVariant?: string | null;
  gclid?: string | null;
  referralCode?: string | null;
  firstSeenAt?: string | null;
};

export type RecordedVia = "resolve" | "org_id" | "external_ids" | "absorbed_shell";

/** Anything that can run a query: the db, or an open transaction. */
type Executor = Pick<typeof db, "select" | "insert">;

/**
 * Record the first touch if the org has none. Returns whether THIS call wrote it.
 */
export async function recordFirstTouch(
  executor: Executor,
  orgId: string,
  input: AcquisitionInput,
  via: RecordedVia,
): Promise<boolean> {
  const inserted = await executor
    .insert(orgAcquisitions)
    .values({
      orgId,
      channel: input.channel,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      utmContent: input.utmContent ?? null,
      utmTerm: input.utmTerm ?? null,
      referrer: input.referrer ?? null,
      landingPath: input.landingPath ?? null,
      homepageVariant: input.homepageVariant ?? null,
      gclid: input.gclid ?? null,
      referralCode: input.referralCode ?? null,
      firstSeenAt: input.firstSeenAt ? new Date(input.firstSeenAt) : null,
      recordedVia: via,
    })
    .onConflictDoNothing({ target: orgAcquisitions.orgId })
    .returning({ orgId: orgAcquisitions.orgId });

  return inserted.length > 0;
}

export async function readFirstTouch(executor: Executor, orgId: string): Promise<OrgAcquisition | null> {
  const [row] = await executor
    .select()
    .from(orgAcquisitions)
    .where(eq(orgAcquisitions.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/** The wire shape. `null` fields mean the browser did not supply them. */
export function serializeFirstTouch(row: OrgAcquisition) {
  return {
    channel: row.channel,
    utmSource: row.utmSource,
    utmMedium: row.utmMedium,
    utmCampaign: row.utmCampaign,
    utmContent: row.utmContent,
    utmTerm: row.utmTerm,
    referrer: row.referrer,
    landingPath: row.landingPath,
    homepageVariant: row.homepageVariant,
    gclid: row.gclid,
    referralCode: row.referralCode,
    firstSeenAt: row.firstSeenAt ? row.firstSeenAt.toISOString() : null,
    recordedVia: row.recordedVia,
    recordedAt: row.recordedAt.toISOString(),
  };
}

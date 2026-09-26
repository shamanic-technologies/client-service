import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb, serial, integer, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id"),
    name: text("name"),
    slug: text("slug"),
    metadata: jsonb("metadata"),
    /**
     * This org came into being WITHOUT an identity provider — the signed-out
     * phase of onboarding, whose `external_id` is a throwaway id the dashboard
     * minted. Written at creation on the caller's declaration, never inferred
     * from what `external_id` looks like: a guard for WHERE a row came from
     * cannot be a sniff of the row's own contents.
     */
    anonymousAt: timestamp("anonymous_at", { withTimezone: true }),
    /**
     * A real identity-provider organisation has been attached (the visitor
     * signed up). NULL while still anonymous; non-NULL is what makes a second
     * claim of the same identity a replay rather than a takeover.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /**
     * This row is a SHELL. It came into being purely as the side effect of an
     * authenticated read resolving an identity, it was never declared anonymous
     * and never claimed, and it held nothing but the person who had just signed
     * up — so the claim took its identity and gave it to the org that holds the
     * customer's work. This names that org.
     *
     * Written ONLY by the claim, and only after the emptiness is CHECKED (local
     * membership and state here, brands and money at their owning services). A
     * shell keeps its uuid and its rows: absorbing is not a delete.
     */
    absorbedIntoOrgId: uuid("absorbed_into_org_id"),
    /** When the identity was handed over. NULL for every org that is not a shell. */
    absorbedAt: timestamp("absorbed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_orgs_external_id").on(table.externalId),
    uniqueIndex("idx_orgs_slug").on(table.slug).where(sql`${table.slug} IS NOT NULL`),
    check(
      "orgs_claimed_requires_anonymous",
      sql`${table.claimedAt} IS NULL OR ${table.anonymousAt} IS NOT NULL`,
    ),
    check(
      "orgs_absorbed_both_or_neither",
      sql`(${table.absorbedAt} IS NULL) = (${table.absorbedIntoOrgId} IS NULL)`,
    ),
    // A shell holds no identity: that is exactly what it gave away. BOTH
    // halves — the id and the slug. Leaving the slug behind splits one
    // identity-provider organisation across two rows, and the next
    // authenticated read collides with the shell on idx_orgs_slug.
    check(
      "orgs_absorbed_has_no_identity",
      sql`${table.absorbedAt} IS NULL OR (${table.externalId} IS NULL AND ${table.slug} IS NULL)`,
    ),
  ]
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalId: text("external_id"),
    email: text("email"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    imageUrl: text("image_url"),
    phone: text("phone"),
    orgId: uuid("org_id").references(() => orgs.id),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_users_external_id").on(table.externalId),
    // One account per phone number (channel-origin signups). Postgres treats
    // NULLs as distinct, so the many existing users with NULL phone are
    // unaffected; uniqueness is enforced only across non-null phone values.
    uniqueIndex("idx_users_phone").on(table.phone),
  ]
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inviterOrgId: uuid("inviter_org_id").notNull().references(() => orgs.id),
    inviteeOrgId: uuid("invitee_org_id").references(() => orgs.id),
    code: text("code").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    signedUpAt: timestamp("signed_up_at", { withTimezone: true }),
    // Set only once billing-service has acknowledged the referral for this row.
    // NULL means "not delivered yet" — the next idempotent claim of the same
    // (code, invitee) retries; a non-NULL value is the guard that stops us
    // notifying billing twice for the same pair.
    billingNotifiedAt: timestamp("billing_notified_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_invites_inviter_invitee_unique")
      .on(table.inviterOrgId, table.inviteeOrgId)
      .where(sql`${table.inviteeOrgId} IS NOT NULL`),
    index("idx_invites_code").on(table.code),
    index("idx_invites_inviter_org_id").on(table.inviterOrgId),
    check(
      "invites_status_check",
      sql`${table.status} IN ('pending', 'signed_up', 'expired')`,
    ),
  ]
);

/**
 * BRONZE — what brand-service actually served us for one OFFER's money content
 * (its lifetime revenue plus the brand's stated leg rates), verbatim, at the
 * moment that content differed from the last thing we stored.
 *
 * An identical re-read carries no new information and is not appended: the
 * dashboard re-reads the task list on every offer page load, so appending every
 * HTTP response would make this a log of our own traffic rather than of the
 * customer's numbers. What lands here is therefore the change log of the
 * content, which is exactly the evidence a completion is judged on.
 */
export const rewardOfferObservations = pgTable(
  "reward_offer_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    /**
     * sha256 over the MONEY CONTENT only — the offer's lifetime revenue and the
     * brand's STATED leg rates. The producer's `statedAt` timestamps are
     * deliberately excluded: re-saving an unchanged number moves them and
     * changes nothing the customer was asked to refresh.
     */
    contentFingerprint: text("content_fingerprint").notNull(),
    /** The offer + leg rates brand-service served, verbatim. */
    payload: jsonb("payload").notNull(),
    /** The latest producer `statedAt` for this content. Forensics only, never a confirmation. */
    producerStatedAt: timestamp("producer_stated_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_reward_offer_obs_offer").on(table.orgId, table.offerId, table.observedAt),
  ]
);

/**
 * SILVER — one canonical row per (org, offer, task): the fingerprint we last
 * saw, WHEN the money content last genuinely changed, and how we know that.
 */
export const rewardTaskStates = pgTable(
  "reward_task_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    taskKey: text("task_key").notNull(),
    /**
     * NULL only on a clock carried over from the retired sales-funnel grain
     * (migration 0016): the old fingerprint was over a different shape and
     * cannot be compared. The first read adopts one without completing anything.
     */
    contentFingerprint: text("content_fingerprint"),
    /** When the money content last genuinely changed — the clock the 30 days run from. */
    contentChangedAt: timestamp("content_changed_at", { withTimezone: true }).notNull(),
    /**
     * `observed`: we compared two readings and they differed. Ours, certain.
     * `producer_ts`: first sighting, so the best anchor available was the
     * producer's own latest `statedAt`. That is an UPPER bound on the real change
     * time (re-saving an unchanged number only ever moves it later), so the task
     * comes due no EARLIER than it should — we never invent an earlier date to
     * pay sooner.
     */
    contentChangedProvenance: text("content_changed_provenance").notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_reward_task_states_offer").on(table.orgId, table.offerId, table.taskKey),
    index("idx_reward_task_states_brand").on(table.orgId, table.brandId),
    check(
      "reward_task_states_provenance_check",
      sql`${table.contentChangedProvenance} IN ('observed', 'producer_ts')`,
    ),
  ]
);

/**
 * The money-facing ledger: one row per completed window. A completion is the
 * unit billing-service pays for, and its id IS the `completionId` we hand it.
 *
 * `billing_notified_at` is written ONLY after billing acknowledges. NULL means
 * the money side has not heard about this completion, so the next read retries
 * it; a non-NULL value is the guard that stops us paying the same window twice.
 */
export const rewardTaskCompletions = pgTable(
  "reward_task_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rewardTaskStateId: uuid("reward_task_state_id")
      .notNull()
      .references(() => rewardTaskStates.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    taskKey: text("task_key").notNull(),
    /**
     * The window this completion closed: the instant the task had become due.
     * One completion per window is what makes $1 paid exactly once however many
     * times the customer saves inside that window.
     */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    rewardCents: integer("reward_cents").notNull(),
    billingNotifiedAt: timestamp("billing_notified_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_reward_task_completions_window").on(table.rewardTaskStateId, table.dueAt),
    index("idx_reward_task_completions_undelivered")
      .on(table.orgId)
      .where(sql`${table.billingNotifiedAt} IS NULL`),
    check("reward_task_completions_reward_positive", sql`${table.rewardCents} > 0`),
  ]
);

/**
 * FIRST TOUCH — which acquisition channel brought this org. One row per org,
 * written once and never updated: the first hand-over wins and every later one
 * is ignored, so a second visit can never move the credit.
 *
 * Keyed on the internal uuid, which a claim never changes, so an anonymous org
 * keeps the touch recorded before its claim. No row = we never recorded
 * anything (every org older than this table); "direct" / "unknown" are real
 * answers the dashboard sends. Every column is untrusted browser-derived text.
 */
export const orgAcquisitions = pgTable(
  "org_acquisitions",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => orgs.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    referrer: text("referrer"),
    landingPath: text("landing_path"),
    homepageVariant: text("homepage_variant"),
    gclid: text("gclid"),
    referralCode: text("referral_code"),
    /** When the browser says it first saw the visitor. Untrusted, kept as stated. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    /** Which hand-over recorded it. `absorbed_shell`: moved off a shell at claim. */
    recordedVia: text("recorded_via").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check(
      "org_acquisitions_recorded_via_check",
      sql`recorded_via IN ('resolve', 'org_id', 'external_ids', 'absorbed_shell')`,
    ),
  ]
);

export const waitlist = pgTable("waitlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  brandUrl: text("brand_url"),
  position: serial("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
export type RewardOfferObservation = typeof rewardOfferObservations.$inferSelect;
export type RewardTaskState = typeof rewardTaskStates.$inferSelect;
export type RewardTaskCompletion = typeof rewardTaskCompletions.$inferSelect;
export type OrgAcquisition = typeof orgAcquisitions.$inferSelect;
export type Waitlist = typeof waitlist.$inferSelect;
export type NewWaitlist = typeof waitlist.$inferInsert;

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_orgs_external_id").on(table.externalId),
    uniqueIndex("idx_orgs_slug").on(table.slug).where(sql`${table.slug} IS NOT NULL`),
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
 * BRONZE — what brand-service actually served us for one sales funnel, verbatim,
 * at the moment its money content differed from the last thing we stored.
 *
 * An identical re-read carries no new information and is not appended: the
 * dashboard re-reads the task list on every funnel page load, so appending every
 * HTTP response would make this a log of our own traffic rather than of the
 * customer's numbers. What lands here is therefore the change log of the
 * content, which is exactly the evidence a completion is judged on.
 */
export const rewardFunnelObservations = pgTable(
  "reward_funnel_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    funnelKey: text("funnel_key").notNull(),
    /**
     * sha256 over the MONEY CONTENT only — rates, arrows, lifetime revenue,
     * destination and booking links. `active` and the producer's `updatedAt` are
     * deliberately excluded: switching a funnel off and back on moves both and
     * changes not one number the customer was asked to refresh.
     */
    contentFingerprint: text("content_fingerprint").notNull(),
    /** The funnel object brand-service served, verbatim. */
    payload: jsonb("payload").notNull(),
    /**
     * The producer's own last-touched timestamp, kept for forensics. NOT a
     * confirmation signal: a toggle moves it with nobody having looked at a number.
     */
    producerUpdatedAt: timestamp("producer_updated_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_reward_funnel_obs_funnel").on(
      table.orgId,
      table.offerId,
      table.funnelKey,
      table.observedAt,
    ),
  ]
);

/**
 * SILVER — one canonical row per (org, offer, funnel, task): the fingerprint we
 * last saw, WHEN the money content last genuinely changed, and how we know that.
 */
export const rewardTaskStates = pgTable(
  "reward_task_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    funnelKey: text("funnel_key").notNull(),
    taskKey: text("task_key").notNull(),
    contentFingerprint: text("content_fingerprint").notNull(),
    /** When the money content last genuinely changed — the clock the 30 days run from. */
    contentChangedAt: timestamp("content_changed_at", { withTimezone: true }).notNull(),
    /**
     * `observed`: we compared two readings and they differed. Ours, certain.
     * `producer_ts`: first sighting, so the best anchor available was the
     * producer's own updatedAt. That is an UPPER bound on the real change time
     * (a toggle only ever moves it later), so the task comes due no EARLIER than
     * it should — we never invent an earlier date to pay sooner.
     */
    contentChangedProvenance: text("content_changed_provenance").notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_reward_task_states_scope").on(
      table.orgId,
      table.offerId,
      table.funnelKey,
      table.taskKey,
    ),
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
export type RewardFunnelObservation = typeof rewardFunnelObservations.$inferSelect;
export type RewardTaskState = typeof rewardTaskStates.$inferSelect;
export type RewardTaskCompletion = typeof rewardTaskCompletions.$inferSelect;
export type Waitlist = typeof waitlist.$inferSelect;
export type NewWaitlist = typeof waitlist.$inferInsert;

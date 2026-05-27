import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb, serial, check } from "drizzle-orm/pg-core";
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
export type Waitlist = typeof waitlist.$inferSelect;
export type NewWaitlist = typeof waitlist.$inferInsert;

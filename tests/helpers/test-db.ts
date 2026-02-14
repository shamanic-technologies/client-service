import { db, sql } from "../../src/db/index.js";
import { orgs, users } from "../../src/db/schema.js";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  await db.delete(users);
  await db.delete(orgs);
}

/**
 * Insert a test org (Clerk-based)
 */
export async function insertTestOrg(data: { clerkOrgId?: string } = {}) {
  const [org] = await db
    .insert(orgs)
    .values({
      clerkOrgId: data.clerkOrgId || `test-org-${Date.now()}`,
    })
    .returning();
  return org;
}

/**
 * Insert a test user (Clerk-based)
 */
export async function insertTestUser(data: { clerkUserId?: string } = {}) {
  const [user] = await db
    .insert(users)
    .values({
      clerkUserId: data.clerkUserId || `test-user-${Date.now()}`,
    })
    .returning();
  return user;
}

/**
 * Insert a test org (anonymous/app-based)
 */
export async function insertTestAnonymousOrg(
  data: { appId?: string; name?: string; metadata?: Record<string, unknown> } = {}
) {
  const [org] = await db
    .insert(orgs)
    .values({
      appId: data.appId || "test-app",
      name: data.name ?? "Personal",
      metadata: data.metadata,
    })
    .returning();
  return org;
}

/**
 * Insert a test user (anonymous/app-based)
 */
export async function insertTestAnonymousUser(
  data: { appId?: string; email?: string; firstName?: string; lastName?: string; phone?: string; orgId?: string; metadata?: Record<string, unknown> } = {}
) {
  const [user] = await db
    .insert(users)
    .values({
      appId: data.appId || "test-app",
      email: data.email || `test-${Date.now()}@example.com`,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      orgId: data.orgId,
      metadata: data.metadata,
    })
    .returning();
  return user;
}

/**
 * Close database connection
 */
export async function closeDb() {
  await sql.end();
}

/**
 * Generate a random UUID
 */
export function randomId(): string {
  return crypto.randomUUID();
}

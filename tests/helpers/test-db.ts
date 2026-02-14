import { db, sql } from "../../src/db/index.js";
import { orgs, users, anonymousUsers } from "../../src/db/schema.js";

/**
 * Clean all test data from the database
 */
export async function cleanTestData() {
  await db.delete(anonymousUsers);
  await db.delete(users);
  await db.delete(orgs);
}

/**
 * Insert a test org
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
 * Insert a test user
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
 * Insert a test anonymous user
 */
export async function insertTestAnonymousUser(
  data: { appId?: string; email?: string; firstName?: string; lastName?: string; phone?: string; metadata?: Record<string, unknown> } = {}
) {
  const [anonymousUser] = await db
    .insert(anonymousUsers)
    .values({
      appId: data.appId || "test-app",
      email: data.email || `test-${Date.now()}@example.com`,
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      metadata: data.metadata,
    })
    .returning();
  return anonymousUser;
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

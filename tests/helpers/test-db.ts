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
 * Insert a test org
 */
export async function insertTestOrg(data: { appId?: string; externalId?: string; name?: string } = {}) {
  const [org] = await db
    .insert(orgs)
    .values({
      appId: data.appId || "test-app",
      externalId: data.externalId || `ext-org-${Date.now()}`,
      name: data.name,
    })
    .returning();
  return org;
}

/**
 * Insert a test user
 */
export async function insertTestUser(data: {
  appId?: string;
  externalId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  orgId?: string;
} = {}) {
  const [user] = await db
    .insert(users)
    .values({
      appId: data.appId || "test-app",
      externalId: data.externalId || `ext-user-${Date.now()}`,
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      orgId: data.orgId,
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

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = process.env.CLIENT_SERVICE_DATABASE_URL &&
  process.env.CLIENT_SERVICE_DATABASE_URL !== "postgresql://test:test@localhost/test";

describe.skipIf(!hasDb)("Client Service Database", () => {
  let db: typeof import("../../src/db/index.js").db;
  let orgs: typeof import("../../src/db/schema.js").orgs;
  let users: typeof import("../../src/db/schema.js").users;
  let cleanTestData: typeof import("../helpers/test-db.js").cleanTestData;
  let closeDb: typeof import("../helpers/test-db.js").closeDb;
  let insertTestOrg: typeof import("../helpers/test-db.js").insertTestOrg;
  let insertTestUser: typeof import("../helpers/test-db.js").insertTestUser;

  beforeEach(async () => {
    // Lazy import to avoid connecting to DB when skipped
    const dbMod = await import("../../src/db/index.js");
    const schemaMod = await import("../../src/db/schema.js");
    const helpersMod = await import("../helpers/test-db.js");
    db = dbMod.db;
    orgs = schemaMod.orgs;
    users = schemaMod.users;
    cleanTestData = helpersMod.cleanTestData;
    closeDb = helpersMod.closeDb;
    insertTestOrg = helpersMod.insertTestOrg;
    insertTestUser = helpersMod.insertTestUser;
    await cleanTestData();
  });

  afterAll(async () => {
    if (cleanTestData) await cleanTestData();
    if (closeDb) await closeDb();
  });

  describe("orgs table", () => {
    it("should create and query an org", async () => {
      const org = await insertTestOrg({ clerkOrgId: "org_test123" });

      expect(org.id).toBeDefined();
      expect(org.clerkOrgId).toBe("org_test123");

      const found = await db.query.orgs.findFirst({
        where: eq(orgs.id, org.id),
      });
      expect(found?.clerkOrgId).toBe("org_test123");
    });

    it("should enforce unique clerkOrgId", async () => {
      await insertTestOrg({ clerkOrgId: "org_unique" });

      await expect(
        insertTestOrg({ clerkOrgId: "org_unique" })
      ).rejects.toThrow();
    });
  });

  describe("users table", () => {
    it("should create and query a user", async () => {
      const user = await insertTestUser({ clerkUserId: "user_test123" });

      expect(user.id).toBeDefined();
      expect(user.clerkUserId).toBe("user_test123");

      const found = await db.query.users.findFirst({
        where: eq(users.id, user.id),
      });
      expect(found?.clerkUserId).toBe("user_test123");
    });

    it("should enforce unique clerkUserId", async () => {
      await insertTestUser({ clerkUserId: "user_unique" });

      await expect(
        insertTestUser({ clerkUserId: "user_unique" })
      ).rejects.toThrow();
    });
  });
});

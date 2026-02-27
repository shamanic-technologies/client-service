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
      const org = await insertTestOrg({ appId: "test-app", externalId: "ext-org-123" });

      expect(org.id).toBeDefined();
      expect(org.externalId).toBe("ext-org-123");
      expect(org.appId).toBe("test-app");

      const found = await db.query.orgs.findFirst({
        where: eq(orgs.id, org.id),
      });
      expect(found?.externalId).toBe("ext-org-123");
    });

    it("should enforce unique (appId, externalId)", async () => {
      await insertTestOrg({ appId: "test-app", externalId: "org-unique" });

      await expect(
        insertTestOrg({ appId: "test-app", externalId: "org-unique" })
      ).rejects.toThrow();
    });

    it("should allow same externalId for different apps", async () => {
      await insertTestOrg({ appId: "app-a", externalId: "same-id" });
      const org2 = await insertTestOrg({ appId: "app-b", externalId: "same-id" });
      expect(org2.id).toBeDefined();
    });
  });

  describe("users table", () => {
    it("should create and query a user", async () => {
      const user = await insertTestUser({ appId: "test-app", externalId: "ext-user-123" });

      expect(user.id).toBeDefined();
      expect(user.externalId).toBe("ext-user-123");

      const found = await db.query.users.findFirst({
        where: eq(users.id, user.id),
      });
      expect(found?.externalId).toBe("ext-user-123");
    });

    it("should enforce unique (appId, externalId)", async () => {
      await insertTestUser({ appId: "test-app", externalId: "user-unique" });

      await expect(
        insertTestUser({ appId: "test-app", externalId: "user-unique" })
      ).rejects.toThrow();
    });

    it("should allow same externalId for different apps", async () => {
      await insertTestUser({ appId: "app-a", externalId: "same-id" });
      const user2 = await insertTestUser({ appId: "app-b", externalId: "same-id" });
      expect(user2.id).toBeDefined();
    });
  });
});

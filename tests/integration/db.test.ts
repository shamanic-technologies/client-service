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
      const org = await insertTestOrg({ externalId: "ext-org-123" });

      expect(org.id).toBeDefined();
      expect(org.externalId).toBe("ext-org-123");

      const found = await db.query.orgs.findFirst({
        where: eq(orgs.id, org.id),
      });
      expect(found?.externalId).toBe("ext-org-123");
    });

    it("should enforce unique externalId", async () => {
      await insertTestOrg({ externalId: "org-unique" });

      await expect(
        insertTestOrg({ externalId: "org-unique" })
      ).rejects.toThrow();
    });
  });

  describe("users table", () => {
    it("should create and query a user", async () => {
      const user = await insertTestUser({ externalId: "ext-user-123" });

      expect(user.id).toBeDefined();
      expect(user.externalId).toBe("ext-user-123");

      const found = await db.query.users.findFirst({
        where: eq(users.id, user.id),
      });
      expect(found?.externalId).toBe("ext-user-123");
    });

    it("should enforce unique externalId", async () => {
      await insertTestUser({ externalId: "user-unique" });

      await expect(
        insertTestUser({ externalId: "user-unique" })
      ).rejects.toThrow();
    });
  });
});

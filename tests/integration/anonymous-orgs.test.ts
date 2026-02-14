import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = process.env.CLIENT_SERVICE_DATABASE_URL &&
  process.env.CLIENT_SERVICE_DATABASE_URL !== "postgresql://test:test@localhost/test";

describe.skipIf(!hasDb)("Anonymous Orgs Database", () => {
  let db: typeof import("../../src/db/index.js").db;
  let anonymousOrgs: typeof import("../../src/db/schema.js").anonymousOrgs;
  let cleanTestData: typeof import("../helpers/test-db.js").cleanTestData;
  let closeDb: typeof import("../helpers/test-db.js").closeDb;
  let insertTestAnonymousOrg: typeof import("../helpers/test-db.js").insertTestAnonymousOrg;

  beforeEach(async () => {
    const dbMod = await import("../../src/db/index.js");
    const schemaMod = await import("../../src/db/schema.js");
    const helpersMod = await import("../helpers/test-db.js");
    db = dbMod.db;
    anonymousOrgs = schemaMod.anonymousOrgs;
    cleanTestData = helpersMod.cleanTestData;
    closeDb = helpersMod.closeDb;
    insertTestAnonymousOrg = helpersMod.insertTestAnonymousOrg;
    await cleanTestData();
  });

  afterAll(async () => {
    if (cleanTestData) await cleanTestData();
    if (closeDb) await closeDb();
  });

  it("should create and query an anonymous org", async () => {
    const org = await insertTestAnonymousOrg({
      appId: "polaritycourse",
      name: "Team Alpha",
    });

    expect(org.id).toBeDefined();
    expect(org.appId).toBe("polaritycourse");
    expect(org.name).toBe("Team Alpha");

    const found = await db.query.anonymousOrgs.findFirst({
      where: eq(anonymousOrgs.id, org.id),
    });
    expect(found?.name).toBe("Team Alpha");
  });

  it("should default name to Personal", async () => {
    const org = await insertTestAnonymousOrg({
      appId: "polaritycourse",
    });

    expect(org.name).toBe("Personal");
  });

  it("should store metadata as jsonb", async () => {
    const org = await insertTestAnonymousOrg({
      appId: "polaritycourse",
      metadata: { plan: "free", source: "webinar" },
    });

    const found = await db.query.anonymousOrgs.findFirst({
      where: eq(anonymousOrgs.id, org.id),
    });
    expect(found?.metadata).toEqual({ plan: "free", source: "webinar" });
  });

  it("should allow multiple orgs per app", async () => {
    const org1 = await insertTestAnonymousOrg({ appId: "polaritycourse", name: "Team A" });
    const org2 = await insertTestAnonymousOrg({ appId: "polaritycourse", name: "Team B" });

    expect(org1.id).not.toBe(org2.id);
    expect(org1.appId).toBe(org2.appId);
  });
});

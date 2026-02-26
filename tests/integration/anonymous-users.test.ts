import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const hasDb = process.env.CLIENT_SERVICE_DATABASE_URL &&
  process.env.CLIENT_SERVICE_DATABASE_URL !== "postgresql://test:test@localhost/test";

describe.skipIf(!hasDb)("Anonymous Users Database", () => {
  let db: typeof import("../../src/db/index.js").db;
  let users: typeof import("../../src/db/schema.js").users;
  let cleanTestData: typeof import("../helpers/test-db.js").cleanTestData;
  let closeDb: typeof import("../helpers/test-db.js").closeDb;
  let insertTestAnonymousUser: typeof import("../helpers/test-db.js").insertTestAnonymousUser;
  let insertTestAnonymousOrg: typeof import("../helpers/test-db.js").insertTestAnonymousOrg;

  beforeEach(async () => {
    const dbMod = await import("../../src/db/index.js");
    const schemaMod = await import("../../src/db/schema.js");
    const helpersMod = await import("../helpers/test-db.js");
    db = dbMod.db;
    users = schemaMod.users;
    cleanTestData = helpersMod.cleanTestData;
    closeDb = helpersMod.closeDb;
    insertTestAnonymousUser = helpersMod.insertTestAnonymousUser;
    insertTestAnonymousOrg = helpersMod.insertTestAnonymousOrg;
    await cleanTestData();
  });

  afterAll(async () => {
    if (cleanTestData) await cleanTestData();
    if (closeDb) await closeDb();
  });

  it("should create and query an anonymous user", async () => {
    const user = await insertTestAnonymousUser({
      appId: "polaritycourse",
      email: "test@example.com",
      firstName: "John",
    });

    expect(user.id).toBeDefined();
    expect(user.appId).toBe("polaritycourse");
    expect(user.email).toBe("test@example.com");
    expect(user.firstName).toBe("John");

    const found = await db.query.users.findFirst({
      where: eq(users.id, user.id),
    });
    expect(found?.email).toBe("test@example.com");
  });

  it("should enforce unique constraint on (appId, email)", async () => {
    await insertTestAnonymousUser({
      appId: "polaritycourse",
      email: "duplicate@example.com",
    });

    await expect(
      insertTestAnonymousUser({
        appId: "polaritycourse",
        email: "duplicate@example.com",
      })
    ).rejects.toThrow();
  });

  it("should allow same email for different appIds", async () => {
    const user1 = await insertTestAnonymousUser({
      appId: "polaritycourse",
      email: "shared@example.com",
    });
    const user2 = await insertTestAnonymousUser({
      appId: "mcpfactory",
      email: "shared@example.com",
    });

    expect(user1.id).not.toBe(user2.id);
    expect(user1.appId).toBe("polaritycourse");
    expect(user2.appId).toBe("mcpfactory");
  });

  it("should store metadata as jsonb", async () => {
    const user = await insertTestAnonymousUser({
      appId: "polaritycourse",
      email: "meta@example.com",
      metadata: { source: "landing_page", utm_campaign: "webinar_q1" },
    });

    const found = await db.query.users.findFirst({
      where: eq(users.id, user.id),
    });
    expect(found?.metadata).toEqual({ source: "landing_page", utm_campaign: "webinar_q1" });
  });

  it("should allow nullable optional fields", async () => {
    const user = await insertTestAnonymousUser({
      appId: "polaritycourse",
      email: "minimal@example.com",
    });

    expect(user.firstName).toBeNull();
    expect(user.lastName).toBeNull();
    expect(user.imageUrl).toBeNull();
    expect(user.phone).toBeNull();
    expect(user.clerkUserId).toBeNull();
    expect(user.orgId).toBeNull();
    expect(user.metadata).toBeNull();
  });

  it("should store and retrieve imageUrl", async () => {
    const user = await insertTestAnonymousUser({
      appId: "polaritycourse",
      email: "avatar@example.com",
      imageUrl: "https://example.com/photo.jpg",
    });

    expect(user.imageUrl).toBe("https://example.com/photo.jpg");

    const found = await db.query.users.findFirst({
      where: eq(users.id, user.id),
    });
    expect(found?.imageUrl).toBe("https://example.com/photo.jpg");
  });

  it("should link anonymous user to org via FK", async () => {
    const org = await insertTestAnonymousOrg({ appId: "polaritycourse" });
    const user = await insertTestAnonymousUser({
      appId: "polaritycourse",
      email: "linked@example.com",
      orgId: org.id,
    });

    expect(user.orgId).toBe(org.id);

    const found = await db.query.users.findFirst({
      where: eq(users.id, user.id),
    });
    expect(found?.orgId).toBe(org.id);
  });
});

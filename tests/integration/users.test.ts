import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb } from "../helpers/test-db.js";

const API_KEY = "test_api_key";
const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("GET /users", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should list users for an org by internal orgId", async () => {
    const org = await insertTestOrg({ externalId: "org-1" });
    await insertTestUser({ externalId: "user-1", email: "a@test.com", orgId: org.id });
    await insertTestUser({ externalId: "user-2", email: "b@test.com", orgId: org.id });

    const res = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .query({ orgId: org.id });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.users[0]).toHaveProperty("id");
    expect(res.body.users[0]).toHaveProperty("email");
    expect(res.body.users[0]).toHaveProperty("createdAt");
  });

  it("should list users by externalOrgId", async () => {
    const org = await insertTestOrg({ externalId: "ext-org-abc" });
    await insertTestUser({ externalId: "user-1", email: "a@test.com", orgId: org.id });

    const res = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .query({ externalOrgId: "ext-org-abc" });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].email).toBe("a@test.com");
  });

  it("should return empty list for non-existent externalOrgId", async () => {
    const res = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .query({ externalOrgId: "does-not-exist" });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("should filter by email", async () => {
    const org = await insertTestOrg({ externalId: "org-1" });
    await insertTestUser({ externalId: "user-1", email: "target@test.com", orgId: org.id });
    await insertTestUser({ externalId: "user-2", email: "other@test.com", orgId: org.id });

    const res = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .query({ orgId: org.id, email: "target@test.com" });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].email).toBe("target@test.com");
    expect(res.body.total).toBe(1);
  });

  it("should paginate results", async () => {
    const org = await insertTestOrg({ externalId: "org-1" });
    for (let i = 0; i < 5; i++) {
      await insertTestUser({ externalId: `user-${i}`, orgId: org.id });
    }

    const res = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .query({ orgId: org.id, limit: 2, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(0);

    const res2 = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .query({ orgId: org.id, limit: 2, offset: 2 });

    expect(res2.status).toBe(200);
    expect(res2.body.users).toHaveLength(2);
    expect(res2.body.total).toBe(5);
    expect(res2.body.offset).toBe(2);
  });

  it("should return empty list for org with no users", async () => {
    const org = await insertTestOrg({ externalId: "empty-org" });

    const res = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .query({ orgId: org.id });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("should return 401 without API key", async () => {
    const res = await request(app)
      .get("/users")
      .query({});

    expect(res.status).toBe(401);
  });

  it("should return 400 without x-run-id header", async () => {
    const res = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .query({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing x-run-id header");
  });

  it("should return all user fields", async () => {
    const org = await insertTestOrg({ externalId: "org-1" });
    await insertTestUser({
      externalId: "user-full",
      email: "full@test.com",
      firstName: "Kevin",
      lastName: "Doe",
      orgId: org.id,
    });

    const res = await request(app)
      .get("/users")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .query({ orgId: org.id });

    expect(res.status).toBe(200);
    const user = res.body.users[0];
    expect(user.id).toBeDefined();
    expect(user.externalId).toBe("user-full");
    expect(user.email).toBe("full@test.com");
    expect(user.firstName).toBe("Kevin");
    expect(user.lastName).toBe("Doe");
    expect(user.imageUrl).toBeNull();
    expect(user.phone).toBeNull();
    expect(user.createdAt).toBeDefined();
  });
});

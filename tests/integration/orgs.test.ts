import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";

const API_KEY = "test_api_key";

describe("GET /internal/orgs/:orgId/members/:userId", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should return 200 when user is a member of the org", async () => {
    const org = await insertTestOrg({ externalId: "org-member-check" });
    const user = await insertTestUser({
      externalId: "user-member",
      email: "member@test.com",
      orgId: org.id,
    });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/members/${user.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("should return 404 when user exists but belongs to a different org", async () => {
    const org1 = await insertTestOrg({ externalId: "org-1-member" });
    const org2 = await insertTestOrg({ externalId: "org-2-member" });
    const user = await insertTestUser({
      externalId: "user-other-org",
      email: "other@test.com",
      orgId: org1.id,
    });

    const res = await request(app)
      .get(`/internal/orgs/${org2.id}/members/${user.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User is not a member of this org");
  });

  it("should return 404 when user does not exist", async () => {
    const org = await insertTestOrg({ externalId: "org-no-user" });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/members/${randomId()}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User is not a member of this org");
  });

  it("should return 404 when org does not exist", async () => {
    const org = await insertTestOrg({ externalId: "org-exists" });
    const user = await insertTestUser({
      externalId: "user-exists",
      orgId: org.id,
    });

    const res = await request(app)
      .get(`/internal/orgs/${randomId()}/members/${user.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User is not a member of this org");
  });

  it("should return 400 for invalid orgId UUID", async () => {
    const res = await request(app)
      .get(`/internal/orgs/not-a-uuid/members/${randomId()}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid parameters");
  });

  it("should return 400 for invalid userId UUID", async () => {
    const res = await request(app)
      .get(`/internal/orgs/${randomId()}/members/not-a-uuid`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid parameters");
  });

  it("should return 401 without API key", async () => {
    const res = await request(app)
      .get(`/internal/orgs/${randomId()}/members/${randomId()}`);

    expect(res.status).toBe(401);
  });

  it("should not require x-run-id header", async () => {
    const org = await insertTestOrg({ externalId: "org-no-run" });
    const user = await insertTestUser({
      externalId: "user-no-run",
      email: "norun@test.com",
      orgId: org.id,
    });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/members/${user.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
  });

  it("should return 404 for user with no org assignment", async () => {
    const org = await insertTestOrg({ externalId: "org-check-null" });
    const user = await insertTestUser({
      externalId: "user-no-org",
      email: "noorg@test.com",
    });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/members/${user.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User is not a member of this org");
  });
});

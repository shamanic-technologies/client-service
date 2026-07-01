import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs } from "../../src/db/schema.js";

const API_KEY = "test_api_key";

describe("GET /internal/orgs/:orgId", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should return 200 with { id, externalId, name } for a known internal UUID", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_abc", name: "Acme Inc" });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: org.id,
      externalId: "org_clerk_abc",
      name: "Acme Inc",
    });
  });

  it("should return null for externalId and name when null in the row", async () => {
    const [org] = await db
      .insert(orgs)
      .values({ externalId: null, name: null })
      .returning();

    const res = await request(app)
      .get(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: org.id, externalId: null, name: null });
  });

  it("should return 404 for an unknown UUID", async () => {
    const res = await request(app)
      .get(`/internal/orgs/${randomId()}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Org not found");
  });

  it("should return 400 for an invalid orgId UUID", async () => {
    const res = await request(app)
      .get(`/internal/orgs/not-a-uuid`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid parameters");
  });

  it("should return 401 without API key", async () => {
    const res = await request(app).get(`/internal/orgs/${randomId()}`);

    expect(res.status).toBe(401);
  });

  it("should not shadow the members-check route", async () => {
    const org = await insertTestOrg({ externalId: "org_no_shadow" });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/members/${randomId()}`)
      .set("x-api-key", API_KEY);

    // members route still resolves (404 = its own "not a member" answer, not this route's)
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User is not a member of this org");
  });
});

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs, users } from "../../src/db/schema.js";
import { sql } from "drizzle-orm";

const API_KEY = "test_api_key";

describe("GET /public/stats", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should return zeros when no data exists", async () => {
    const res = await request(app)
      .get("/public/stats")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalOrgs: 0,
      totalUsers: 0,
      monthlyGrowth: [],
    });
  });

  it("should return correct totals", async () => {
    const org1 = await insertTestOrg({ externalId: "org-1" });
    const org2 = await insertTestOrg({ externalId: "org-2" });
    await insertTestUser({ externalId: "user-1", orgId: org1.id });
    await insertTestUser({ externalId: "user-2", orgId: org1.id });
    await insertTestUser({ externalId: "user-3", orgId: org2.id });

    const res = await request(app)
      .get("/public/stats")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.totalOrgs).toBe(2);
    expect(res.body.totalUsers).toBe(3);
  });

  it("should return monthly growth breakdown", async () => {
    const org = await insertTestOrg({ externalId: "org-monthly" });
    await insertTestUser({ externalId: "user-monthly", orgId: org.id });

    const res = await request(app)
      .get("/public/stats")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.monthlyGrowth).toHaveLength(1);
    expect(res.body.monthlyGrowth[0]).toEqual({
      month: expect.stringMatching(/^\d{4}-\d{2}$/),
      newOrgs: 1,
      newUsers: 1,
    });
  });

  it("should group records by month correctly", async () => {
    // Insert orgs/users with backdated created_at
    const [org1] = await db
      .insert(orgs)
      .values({ externalId: "org-jan", createdAt: new Date("2026-01-15T00:00:00Z") })
      .returning();
    await db
      .insert(orgs)
      .values({ externalId: "org-feb", createdAt: new Date("2026-02-10T00:00:00Z") });
    await db
      .insert(users)
      .values({ externalId: "user-jan-1", orgId: org1.id, createdAt: new Date("2026-01-20T00:00:00Z") });
    await db
      .insert(users)
      .values({ externalId: "user-jan-2", orgId: org1.id, createdAt: new Date("2026-01-25T00:00:00Z") });
    await db
      .insert(users)
      .values({ externalId: "user-feb-1", orgId: org1.id, createdAt: new Date("2026-02-05T00:00:00Z") });

    const res = await request(app)
      .get("/public/stats")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.totalOrgs).toBe(2);
    expect(res.body.totalUsers).toBe(3);

    const jan = res.body.monthlyGrowth.find((m: { month: string }) => m.month === "2026-01");
    const feb = res.body.monthlyGrowth.find((m: { month: string }) => m.month === "2026-02");

    expect(jan).toEqual({ month: "2026-01", newOrgs: 1, newUsers: 2 });
    expect(feb).toEqual({ month: "2026-02", newOrgs: 1, newUsers: 1 });
  });

  it("should return months sorted chronologically", async () => {
    // Insert in reverse order
    await db
      .insert(orgs)
      .values({ externalId: "org-mar", createdAt: new Date("2026-03-01T00:00:00Z") });
    await db
      .insert(orgs)
      .values({ externalId: "org-jan", createdAt: new Date("2026-01-01T00:00:00Z") });

    const res = await request(app)
      .get("/public/stats")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    const months = res.body.monthlyGrowth.map((m: { month: string }) => m.month);
    expect(months).toEqual([...months].sort());
  });

  it("should return 401 without API key", async () => {
    const res = await request(app).get("/public/stats");
    expect(res.status).toBe(401);
  });
});

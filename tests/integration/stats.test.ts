import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs, users } from "../../src/db/schema.js";
import { sql } from "drizzle-orm";

const API_KEY = "test_api_key";

describe("GET /public/stats/users", () => {
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
      .get("/public/stats/users")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalOrgs: 0,
      totalUsers: 0,
      monthlyGrowth: [],
    });
  });

  it("should return correct totals", async () => {
    const org1 = await insertTestOrg({ externalId: "org_2abc1" });
    const org2 = await insertTestOrg({ externalId: "org_2abc2" });
    await insertTestUser({ externalId: "user_2abc1", orgId: org1.id });
    await insertTestUser({ externalId: "user_2abc2", orgId: org1.id });
    await insertTestUser({ externalId: "user_2abc3", orgId: org2.id });

    const res = await request(app)
      .get("/public/stats/users")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.totalOrgs).toBe(2);
    expect(res.body.totalUsers).toBe(3);
  });

  it("should return monthly growth breakdown", async () => {
    const org = await insertTestOrg({ externalId: "org_2monthly" });
    await insertTestUser({ externalId: "user_2monthly", orgId: org.id });

    const res = await request(app)
      .get("/public/stats/users")
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
      .values({ externalId: "org_2jan", createdAt: new Date("2026-01-15T00:00:00Z") })
      .returning();
    await db
      .insert(orgs)
      .values({ externalId: "org_2feb", createdAt: new Date("2026-02-10T00:00:00Z") });
    await db
      .insert(users)
      .values({ externalId: "user_2jan1", orgId: org1.id, createdAt: new Date("2026-01-20T00:00:00Z") });
    await db
      .insert(users)
      .values({ externalId: "user_2jan2", orgId: org1.id, createdAt: new Date("2026-01-25T00:00:00Z") });
    await db
      .insert(users)
      .values({ externalId: "user_2feb1", orgId: org1.id, createdAt: new Date("2026-02-05T00:00:00Z") });

    const res = await request(app)
      .get("/public/stats/users")
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
      .values({ externalId: "org_2mar", createdAt: new Date("2026-03-01T00:00:00Z") });
    await db
      .insert(orgs)
      .values({ externalId: "org_2jan2", createdAt: new Date("2026-01-01T00:00:00Z") });

    const res = await request(app)
      .get("/public/stats/users")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    const months = res.body.monthlyGrowth.map((m: { month: string }) => m.month);
    expect(months).toEqual([...months].sort());
  });

  it("should only count Clerk-format IDs", async () => {
    // Real Clerk org (org_xxx format)
    const realOrg = await insertTestOrg({ externalId: "org_2realclerkorg" });
    // Non-Clerk orgs that should be excluded
    await db.insert(orgs).values({ externalId: null });
    await db.insert(orgs).values({ externalId: "growthagency" });
    await db.insert(orgs).values({ externalId: "polaritycourse" });
    await db.insert(orgs).values({ externalId: "org_2test" });

    // Real Clerk user (user_xxx format)
    await insertTestUser({ externalId: "user_2realclerkuser", orgId: realOrg.id });
    // Non-Clerk users that should be excluded
    await db.insert(users).values({ externalId: "550e8400-e29b-41d4-a716-446655440000", orgId: realOrg.id });
    await db.insert(users).values({ externalId: "system-migration", orgId: realOrg.id });
    await db.insert(users).values({ externalId: null, orgId: realOrg.id });

    const res = await request(app)
      .get("/public/stats/users")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.totalOrgs).toBe(1);
    expect(res.body.totalUsers).toBe(1);
  });

  it("should return 401 without API key", async () => {
    const res = await request(app).get("/public/stats/users");
    expect(res.status).toBe(401);
  });
});

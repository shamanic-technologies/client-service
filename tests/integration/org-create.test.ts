import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

const clerk = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  deleteOrganization: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    organizations: { createOrganization: clerk.createOrganization, deleteOrganization: clerk.deleteOrganization },
  }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestUser } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgCreations, orgs, users } from "../../src/db/schema.js";

const API_KEY = "test_api_key";

describe("POST /internal/orgs", () => {
  const app = createTestApp();
  let staffUserId: string;
  let staffOrgId: string;
  let n = 0;

  const create = (body: Record<string, unknown>) =>
    request(app).post("/internal/orgs").set("x-api-key", API_KEY).send(body);

  beforeEach(async () => {
    await cleanTestData();
    Object.values(clerk).forEach((m) => m.mockReset());
    clerk.createOrganization.mockImplementation(async () => {
      n += 1;
      return { id: `org_client_${n}`, slug: `acme-${n}` };
    });
    clerk.deleteOrganization.mockResolvedValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) })),
    );
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    const staffOrg = await insertTestOrg({ externalId: "org_staff" });
    staffOrgId = staffOrg.id;
    staffUserId = (await insertTestUser({ externalId: "user_staff", orgId: staffOrg.id })).id;
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("creates a Clerk org the acting user administers, onboarding complete, served by GET /internal/orgs/:orgId", async () => {
    const res = await create({ name: "Acme Inc", createdByUserId: staffUserId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Acme Inc", clerkOrgId: expect.stringMatching(/^org_client_/), onboardingComplete: true, created: true, createdByUserId: staffUserId });
    expect(clerk.createOrganization).toHaveBeenCalledWith({
      name: "Acme Inc",
      createdBy: "user_staff",
      publicMetadata: { onboardingComplete: true },
    });

    const got = await request(app).get(`/internal/orgs/${res.body.orgId}`).set("x-api-key", API_KEY);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: res.body.orgId, externalId: res.body.clerkOrgId, name: "Acme Inc" });

    // The acting user's current org is untouched.
    const [staff] = await db.select().from(users).where(eq(users.id, staffUserId));
    expect(staff.orgId).toBe(staffOrgId);
  });

  it("is idempotent per (user, idempotencyKey) and creates anew without a key", async () => {
    const first = await create({ name: "Acme", createdByUserId: staffUserId, idempotencyKey: "k1" });
    const again = await create({ name: "Acme", createdByUserId: staffUserId, idempotencyKey: "k1" });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ orgId: first.body.orgId, created: false });
    expect(clerk.createOrganization).toHaveBeenCalledTimes(1);

    const other = await create({ name: "Acme", createdByUserId: staffUserId, idempotencyKey: "k2" });
    const noKey = await create({ name: "Acme", createdByUserId: staffUserId });
    expect(new Set([first.body.orgId, other.body.orgId, noKey.body.orgId]).size).toBe(3);
  });

  it("concurrent calls with one key return one org and leave no orphan Clerk org", async () => {
    const [a, b] = await Promise.all([
      create({ name: "Race", createdByUserId: staffUserId, idempotencyKey: "race" }),
      create({ name: "Race", createdByUserId: staffUserId, idempotencyKey: "race" }),
    ]);
    expect(a.body.orgId).toBe(b.body.orgId);
    const created = clerk.createOrganization.mock.calls.length;
    expect(clerk.deleteOrganization).toHaveBeenCalledTimes(created - 1);
    const rows = await db.select().from(orgCreations).where(eq(orgCreations.idempotencyKey, "race"));
    expect(rows).toHaveLength(1);
  });

  it("404s an unknown acting user without calling Clerk", async () => {
    const res = await create({ name: "Acme", createdByUserId: crypto.randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("user_not_found");
    expect(clerk.createOrganization).not.toHaveBeenCalled();
  });

  it("502s a Clerk failure and keeps nothing", async () => {
    clerk.createOrganization.mockRejectedValueOnce({ status: 500, errors: [{ message: "boom" }] });
    const res = await create({ name: "Acme", createdByUserId: staffUserId });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("identity_provider_failed");
    expect(await db.select().from(orgCreations)).toHaveLength(0);
    expect((await db.select().from(orgs)).map((o) => o.externalId)).toEqual(["org_staff"]);
  });

  it("400s a missing name", async () => {
    const res = await create({ name: " ", createdByUserId: staffUserId });
    expect(res.status).toBe(400);
  });

  it("the creation row goes with the org on teardown", async () => {
    const res = await create({ name: "Acme", createdByUserId: staffUserId, idempotencyKey: "td" });
    await db.delete(orgs).where(eq(orgs.id, res.body.orgId));
    expect(await db.select().from(orgCreations)).toHaveLength(0);
  });
});

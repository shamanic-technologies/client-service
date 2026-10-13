import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";

// The identity provider is mocked at the SDK boundary; key-service is stubbed on fetch.
const { orgMembershipListMock } = vi.hoisted(() => ({ orgMembershipListMock: vi.fn() }));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    organizations: { getOrganizationMembershipList: orgMembershipListMock },
  }),
}));
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";
import { clearMembershipCache } from "../../src/lib/user-memberships.js";

/** Clerk's answer for an organization: its members' Clerk user ids. */
function clerkOrgMembers(byOrg: Record<string, string[]>) {
  orgMembershipListMock.mockImplementation(async ({ organizationId }: { organizationId: string }) => {
    const ids = byOrg[organizationId];
    if (!ids) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { data: ids.map((userId) => ({ publicUserData: { userId } })), totalCount: ids.length };
  });
}

const API_KEY = "test_api_key";

describe("GET /internal/users/:userId", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  it("should return a user by internal UUID", async () => {
    const org = await insertTestOrg({ externalId: "org-1" });
    const user = await insertTestUser({
      externalId: "user-1",
      email: "test@example.com",
      firstName: "Jane",
      lastName: "Doe",
      orgId: org.id,
    });

    const res = await request(app)
      .get(`/internal/users/${user.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: user.id,
      email: "test@example.com",
      firstName: "Jane",
      lastName: "Doe",
    });
  });

  it("should return 404 for non-existent userId", async () => {
    const res = await request(app)
      .get(`/internal/users/${randomId()}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
  });

  it("should return 400 for invalid UUID", async () => {
    const res = await request(app)
      .get("/internal/users/not-a-uuid")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid userId parameter");
  });

  it("should return 401 without API key", async () => {
    const res = await request(app).get(`/internal/users/${randomId()}`);
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
      .get(`/internal/users/${user.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });
});

describe("GET /internal/users", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    clearMembershipCache();
    orgMembershipListMock.mockReset();
    clerkOrgMembers({});
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test" }) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists a member of SEVERAL orgs in each of them (Clerk membership, not the last active org)", async () => {
    const docDinners = await insertTestOrg({ externalId: "org_doc" });
    const distribute = await insertTestOrg({ externalId: "org_dist" });
    const kevin = await insertTestUser({ externalId: "user_kevin", email: "kevin@test.com", firstName: "Kevin", orgId: docDinners.id });
    const probe = await insertTestUser({ externalId: "system-probe", orgId: distribute.id });
    clerkOrgMembers({ org_doc: ["user_kevin"], org_dist: ["user_kevin"] });

    const dist = await request(app).get("/internal/users").set("x-api-key", API_KEY).query({ orgId: distribute.id });
    expect(dist.status).toBe(200);
    expect(dist.body.users.map((u: { id: string }) => u.id).sort()).toEqual([kevin.id, probe.id].sort());
    expect(dist.body.total).toBe(2);
    expect(dist.body.users.find((u: { id: string }) => u.id === kevin.id)).toMatchObject({ email: "kevin@test.com", firstName: "Kevin" });

    const doc = await request(app).get("/internal/users").set("x-api-key", API_KEY).query({ externalOrgId: "org_doc" });
    expect(doc.status).toBe(200);
    expect(doc.body.users.map((u: { id: string }) => u.id)).toEqual([kevin.id]);
  });

  it("an org Clerk does not know lists its users.org_id rows", async () => {
    const org = await insertTestOrg({ externalId: "org_gone" });
    const u = await insertTestUser({ externalId: "user-a", email: "a@test.com", orgId: org.id });

    const res = await request(app).get("/internal/users").set("x-api-key", API_KEY).query({ orgId: org.id });
    expect(res.status).toBe(200);
    expect(res.body.users.map((x: { id: string }) => x.id)).toEqual([u.id]);
  });

  it("never asks Clerk about an anonymous org awaiting a claim", async () => {
    const org = await insertTestOrg({ externalId: "anon-minted", anonymousAt: new Date() });
    await insertTestUser({ externalId: "user-anon", orgId: org.id });

    const res = await request(app).get("/internal/users").set("x-api-key", API_KEY).query({ orgId: org.id });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(orgMembershipListMock).not.toHaveBeenCalled();
  });

  it("502s when Clerk could not be asked, never a shorter list", async () => {
    const org = await insertTestOrg({ externalId: "org_x" });
    await insertTestUser({ externalId: "user-x", orgId: org.id });
    orgMembershipListMock.mockRejectedValue(Object.assign(new Error("boom"), { status: 503 }));

    const res = await request(app).get("/internal/users").set("x-api-key", API_KEY).query({ orgId: org.id });
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("identity_provider_unavailable");
  });

  it("does not ask Clerk for an email-only lookup", async () => {
    const org = await insertTestOrg({ externalId: "org_e" });
    await insertTestUser({ externalId: "user-e", email: "e@test.com", orgId: org.id });

    const res = await request(app).get("/internal/users").set("x-api-key", API_KEY).query({ email: "e@test.com" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(orgMembershipListMock).not.toHaveBeenCalled();
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
      .get("/internal/users")
      .set("x-api-key", API_KEY)
      .query({ orgId: org.id });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBeUndefined();
    expect(res.body.offset).toBeUndefined();
    expect(res.body.users[0]).toHaveProperty("id");
    expect(res.body.users[0]).toHaveProperty("email");
    expect(res.body.users[0]).toHaveProperty("createdAt");
  });

  it("should list users by externalOrgId", async () => {
    const org = await insertTestOrg({ externalId: "ext-org-abc" });
    await insertTestUser({ externalId: "user-1", email: "a@test.com", orgId: org.id });

    const res = await request(app)
      .get("/internal/users")
      .set("x-api-key", API_KEY)
      .query({ externalOrgId: "ext-org-abc" });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].email).toBe("a@test.com");
  });

  it("should return empty list for non-existent externalOrgId", async () => {
    const res = await request(app)
      .get("/internal/users")
      .set("x-api-key", API_KEY)
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
      .get("/internal/users")
      .set("x-api-key", API_KEY)
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
      .get("/internal/users")
      .set("x-api-key", API_KEY)
      .query({ orgId: org.id, limit: 2, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(0);

    const res2 = await request(app)
      .get("/internal/users")
      .set("x-api-key", API_KEY)
      .query({ orgId: org.id, limit: 2, offset: 2 });

    expect(res2.status).toBe(200);
    expect(res2.body.users).toHaveLength(2);
    expect(res2.body.total).toBe(5);
    expect(res2.body.offset).toBe(2);
  });

  it("should return empty list for org with no users", async () => {
    const org = await insertTestOrg({ externalId: "empty-org" });

    const res = await request(app)
      .get("/internal/users")
      .set("x-api-key", API_KEY)
      .query({ orgId: org.id });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("should return 401 without API key", async () => {
    const res = await request(app)
      .get("/internal/users")
      .query({});

    expect(res.status).toBe(401);
  });

  it("should return ALL users when limit is omitted (no silent truncation)", async () => {
    const org = await insertTestOrg({ externalId: "org-no-limit" });
    for (let i = 0; i < 60; i++) {
      await insertTestUser({ externalId: `user-nolim-${i}`, orgId: org.id });
    }

    const res = await request(app)
      .get("/internal/users")
      .set("x-api-key", API_KEY)
      .query({ orgId: org.id });

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(60);
    expect(res.body.total).toBe(60);
    expect(res.body.limit).toBeUndefined();
    expect(res.body.offset).toBeUndefined();
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
      .get("/internal/users")
      .set("x-api-key", API_KEY)
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

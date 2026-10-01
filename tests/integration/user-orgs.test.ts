import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";

// The identity provider is mocked at the SDK boundary; key-service is stubbed on fetch.
const { membershipListMock, orgListMock } = vi.hoisted(() => ({
  membershipListMock: vi.fn(),
  orgListMock: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: { getOrganizationMembershipList: membershipListMock },
    organizations: { getOrganizationList: orgListMock },
  }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";
import { clearMembershipCache, MEMBERSHIP_CACHE_TTL_MS } from "../../src/lib/user-memberships.js";
import { db } from "../../src/db/index.js";
import { orgs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

const API_KEY = "test_api_key";

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

function membership(clerkOrgId: string, name: string, role = "org:admin") {
  return { organization: { id: clerkOrgId, name }, role };
}

function clerkAnswers(...items: ReturnType<typeof membership>[]) {
  membershipListMock.mockResolvedValue({ data: items, totalCount: items.length });
}

describe("GET /internal/users/:userId/orgs", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    clearMembershipCache();
    membershipListMock.mockReset();
    orgListMock.mockReset();
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test" }) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lists EVERY org the user is a member of, not just the last active one", async () => {
    const livingVital = await insertTestOrg({ externalId: "org_lv", name: "www.livingvital.ch" });
    const own = await insertTestOrg({ externalId: "org_own" }); // name never recorded
    const user = await insertTestUser({ externalId: "user_kevin", orgId: livingVital.id });
    clerkAnswers(membership("org_lv", "Living Vital"), membership("org_own", "distribute.you"));

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(membershipListMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_kevin" }));
    expect(res.body.userId).toBe(user.id);
    expect(res.body.organizations).toEqual([
      { orgId: livingVital.id, externalOrgId: "org_lv", name: "Living Vital", role: "org:admin" },
      { orgId: own.id, externalOrgId: "org_own", name: "distribute.you", role: "org:admin" },
    ]);
    expect(res.body.unresolved).toEqual([]);
    expect(res.body.maxStalenessSeconds).toBe(60);
    expect(typeof res.body.membershipsCheckedAt).toBe("string");

    // A NULL stored name is backfilled from the identity provider; a held one is not overwritten.
    const [ownRow] = await db.select().from(orgs).where(eq(orgs.id, own.id));
    expect(ownRow.name).toBe("distribute.you");
    const [lvRow] = await db.select().from(orgs).where(eq(orgs.id, livingVital.id));
    expect(lvRow.name).toBe("www.livingvital.ch");
  });

  it("a user with one organization gets exactly that one", async () => {
    const org = await insertTestOrg({ externalId: "org_solo", name: "Solo" });
    const user = await insertTestUser({ externalId: "user_solo", orgId: org.id });
    clerkAnswers(membership("org_solo", "Solo", "org:member"));

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.organizations).toEqual([
      { orgId: org.id, externalOrgId: "org_solo", name: "Solo", role: "org:member" },
    ]);
  });

  it("a member of no organization is an empty list with 200", async () => {
    const user = await insertTestUser({ externalId: "user_lonely" });
    clerkAnswers();

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.organizations).toEqual([]);
    expect(res.body.unresolved).toEqual([]);
  });

  it("an org with no row here is reported as unresolved, never dropped and never created", async () => {
    const known = await insertTestOrg({ externalId: "org_known", name: "Known" });
    const user = await insertTestUser({ externalId: "user_mixed", orgId: known.id });
    clerkAnswers(membership("org_known", "Known"), membership("org_unseen", "Brand New", "org:member"));

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.organizations.map((o: { orgId: string }) => o.orgId)).toEqual([known.id]);
    expect(res.body.unresolved).toEqual([
      { externalOrgId: "org_unseen", name: "Brand New", role: "org:member", reason: "not_yet_known_to_client_service" },
    ]);
    const created = await db.select().from(orgs).where(eq(orgs.externalId, "org_unseen"));
    expect(created).toEqual([]);
  });

  it("identity-provider failure is a 502 with a legible message, never an empty list", async () => {
    const user = await insertTestUser({ externalId: "user_down" });
    membershipListMock.mockRejectedValue({ status: 503, errors: [{ message: "Service Unavailable" }] });

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("identity_provider_unavailable");
    expect(res.body.error).toContain("503");
    expect(res.body.error).toContain("Service Unavailable");
    expect(res.body.organizations).toBeUndefined();
  });

  it("a failure is not cached: the next request asks again", async () => {
    const org = await insertTestOrg({ externalId: "org_retry", name: "Retry" });
    const user = await insertTestUser({ externalId: "user_retry", orgId: org.id });
    membershipListMock.mockRejectedValueOnce({ status: 500, message: "boom" });
    membershipListMock.mockResolvedValueOnce({ data: [membership("org_retry", "Retry")], totalCount: 1 });

    const first = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);
    const second = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(first.status).toBe(502);
    expect(second.status).toBe(200);
    expect(second.body.organizations).toHaveLength(1);
  });

  it("reuses the identity provider's answer within the bound, and reflects a removal after it", async () => {
    const a = await insertTestOrg({ externalId: "org_a", name: "A" });
    const b = await insertTestOrg({ externalId: "org_b", name: "B" });
    const user = await insertTestUser({ externalId: "user_cache", orgId: a.id });
    clerkAnswers(membership("org_a", "A"), membership("org_b", "B"));

    const t0 = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    const first = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);
    expect(first.body.organizations).toHaveLength(2);

    // Removed from org_b at the identity provider.
    clerkAnswers(membership("org_a", "A"));
    nowSpy.mockReturnValue(t0 + MEMBERSHIP_CACHE_TTL_MS - 1);
    const cached = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);
    expect(cached.body.organizations).toHaveLength(2);
    expect(membershipListMock).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(t0 + MEMBERSHIP_CACHE_TTL_MS + 1);
    const fresh = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);
    expect(fresh.body.organizations.map((o: { orgId: string }) => o.orgId)).toEqual([a.id]);
    expect(membershipListMock).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
    void b;
  });

  it("an unknown user id is a legible 404", async () => {
    const res = await request(app).get(`/internal/users/${randomId()}/orgs`).set("x-api-key", API_KEY);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "User not found", reason: "user_not_found" });
    expect(membershipListMock).not.toHaveBeenCalled();
  });

  it("a user the identity provider does not know is a 404 identity_not_found", async () => {
    const user = await insertTestUser({ externalId: "user_gone" });
    membershipListMock.mockRejectedValue({ status: 404, errors: [{ message: "not found" }] });

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("identity_not_found");
  });

  it("rejects a non-uuid and requires the api key", async () => {
    expect((await request(app).get(`/internal/users/nope/orgs`).set("x-api-key", API_KEY)).status).toBe(400);
    expect((await request(app).get(`/internal/users/${randomId()}/orgs`)).status).toBe(401);
  });
});

describe("POST /internal/orgs/names", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    clearMembershipCache();
    orgListMock.mockReset();
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

  it("3 known org ids in, 3 names out, in one call and without asking the identity provider", async () => {
    const a = await insertTestOrg({ externalId: "org_n1", name: "Alpha" });
    const b = await insertTestOrg({ externalId: "org_n2", name: "Beta" });
    const c = await insertTestOrg({ externalId: "org_n3", name: "Gamma" });

    const res = await request(app)
      .post("/internal/orgs/names")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [a.id, b.id, c.id] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgs: [
        { orgId: a.id, name: "Alpha" },
        { orgId: b.id, name: "Beta" },
        { orgId: c.id, name: "Gamma" },
      ],
      notFound: [],
    });
    expect(orgListMock).not.toHaveBeenCalled();
  });

  it("names an unnamed org from the identity provider, writes it back, and leaves anonymous ones alone", async () => {
    const unnamed = await insertTestOrg({ externalId: "org_unnamed" });
    const anon = await insertTestOrg({ externalId: "anon_walk", anonymousAt: new Date() });
    const missing = randomId();
    orgListMock.mockResolvedValue({ data: [{ id: "org_unnamed", name: "Named At Clerk" }], totalCount: 1 });

    const res = await request(app)
      .post("/internal/orgs/names")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [unnamed.id, anon.id, missing, unnamed.id] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgs: [
        { orgId: unnamed.id, name: "Named At Clerk" },
        { orgId: anon.id, name: null },
      ],
      notFound: [missing],
    });
    expect(orgListMock).toHaveBeenCalledTimes(1);
    expect(orgListMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ["org_unnamed"] }));
    const [row] = await db.select().from(orgs).where(eq(orgs.id, unnamed.id));
    expect(row.name).toBe("Named At Clerk");
  });

  it("is a 502 when the identity provider had to be asked and could not be", async () => {
    const unnamed = await insertTestOrg({ externalId: "org_unnamed_down" });
    orgListMock.mockRejectedValue({ status: 500, message: "boom" });

    const res = await request(app)
      .post("/internal/orgs/names")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [unnamed.id] });

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("identity_provider_unavailable");
  });

  it("rejects an invalid body and requires the api key", async () => {
    expect(
      (await request(app).post("/internal/orgs/names").set("x-api-key", API_KEY).send({ orgIds: ["x"] })).status,
    ).toBe(400);
    expect((await request(app).post("/internal/orgs/names").send({ orgIds: [randomId()] })).status).toBe(401);
  });
});

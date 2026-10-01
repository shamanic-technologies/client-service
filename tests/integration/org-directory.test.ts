import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";
import {
  listClerkUserMemberships,
  getClerkOrganizationNames,
  ClerkServiceError,
} from "../../src/lib/clerk-client.js";
import { clearIdentityCaches } from "../../src/lib/org-directory.js";

vi.mock("../../src/lib/clerk-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/clerk-client.js")>();
  return { ...actual, listClerkUserMemberships: vi.fn(), getClerkOrganizationNames: vi.fn() };
});

const API_KEY = "test_api_key";

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("GET /internal/users/:userId/orgs", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    clearIdentityCaches();
    vi.mocked(listClerkUserMemberships).mockReset();
  });

  it("lists EVERY org the user belongs to, not only the last active one", async () => {
    const living = await insertTestOrg({ externalId: "org_living" });
    const distribute = await insertTestOrg({ externalId: "org_distribute" });
    const user = await insertTestUser({ externalId: "user_kevin", orgId: living.id });
    vi.mocked(listClerkUserMemberships).mockResolvedValueOnce([
      { clerkOrgId: "org_living", name: "Living Vital", role: "org:admin" },
      { clerkOrgId: "org_distribute", name: "distribute.you", role: "org:admin" },
    ]);

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: user.id,
      orgs: [
        { id: living.id, name: "Living Vital", role: "org:admin" },
        { id: distribute.id, name: "distribute.you", role: "org:admin" },
      ],
      unresolved: [],
      maxStalenessSeconds: 60,
    });
    expect(listClerkUserMemberships).toHaveBeenCalledWith("user_kevin");
  });

  it("a user with one organization gets exactly that one", async () => {
    const org = await insertTestOrg({ externalId: "org_only" });
    const user = await insertTestUser({ externalId: "user_one", orgId: org.id });
    vi.mocked(listClerkUserMemberships).mockResolvedValueOnce([
      { clerkOrgId: "org_only", name: "Only", role: "org:member" },
    ]);

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.orgs).toEqual([{ id: org.id, name: "Only", role: "org:member" }]);
    expect(res.body.unresolved).toEqual([]);
  });

  it("a Clerk org we have never seen is reported under unresolved, never dropped or created", async () => {
    const org = await insertTestOrg({ externalId: "org_known" });
    const user = await insertTestUser({ externalId: "user_u", orgId: org.id });
    vi.mocked(listClerkUserMemberships).mockResolvedValueOnce([
      { clerkOrgId: "org_known", name: "Known", role: "org:admin" },
      { clerkOrgId: "org_new", name: "New", role: "org:member" },
    ]);

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.orgs).toEqual([{ id: org.id, name: "Known", role: "org:admin" }]);
    expect(res.body.unresolved).toEqual([{ externalOrgId: "org_new", name: "New", role: "org:member" }]);
    const created = await db.select().from(orgs).where(eq(orgs.externalId, "org_new"));
    expect(created).toEqual([]);
  });

  it("a member of no organization gets empty lists (a 200, the provider's answer)", async () => {
    const user = await insertTestUser({ externalId: "user_lonely" });
    vi.mocked(listClerkUserMemberships).mockResolvedValueOnce([]);

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.orgs).toEqual([]);
    expect(res.body.unresolved).toEqual([]);
  });

  it("identity-provider failure is a legible 502, never an empty list", async () => {
    const user = await insertTestUser({ externalId: "user_x" });
    vi.mocked(listClerkUserMemberships).mockRejectedValueOnce(new ClerkServiceError(503, "clerk down"));

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      error: "identity_provider_unavailable",
      provider: "clerk",
      upstreamStatus: 503,
      upstreamBody: "clerk down",
    });
  });

  it("a failure is not cached: the next call asks Clerk again", async () => {
    const org = await insertTestOrg({ externalId: "org_r" });
    const user = await insertTestUser({ externalId: "user_r", orgId: org.id });
    vi.mocked(listClerkUserMemberships)
      .mockRejectedValueOnce(new ClerkServiceError(503, "down"))
      .mockResolvedValueOnce([{ clerkOrgId: "org_r", name: "R", role: "org:admin" }]);

    const first = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);
    const second = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(first.status).toBe(502);
    expect(second.status).toBe(200);
    expect(second.body.orgs).toEqual([{ id: org.id, name: "R", role: "org:admin" }]);
  });

  it("a success is cached within the staleness bound (one Clerk call for repeated reads)", async () => {
    const org = await insertTestOrg({ externalId: "org_c" });
    const user = await insertTestUser({ externalId: "user_c", orgId: org.id });
    vi.mocked(listClerkUserMemberships).mockResolvedValue([{ clerkOrgId: "org_c", name: "C", role: "org:admin" }]);

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);
      expect(res.status).toBe(200);
    }
    expect(listClerkUserMemberships).toHaveBeenCalledTimes(1);
  });

  it("a removal shows once the cache entry expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const org = await insertTestOrg({ externalId: "org_rm" });
      const user = await insertTestUser({ externalId: "user_rm", orgId: org.id });
      vi.mocked(listClerkUserMemberships)
        .mockResolvedValueOnce([{ clerkOrgId: "org_rm", name: "RM", role: "org:admin" }])
        .mockResolvedValueOnce([]);

      const before = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);
      vi.setSystemTime(Date.now() + 61_000);
      const after = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

      expect(before.body.orgs.length).toBe(1);
      expect(after.body.orgs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("404 user_not_found for an unknown user id", async () => {
    const res = await request(app).get(`/internal/users/${randomId()}/orgs`).set("x-api-key", API_KEY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("user_not_found");
    expect(listClerkUserMemberships).not.toHaveBeenCalled();
  });

  it("404 identity_not_found when Clerk does not know the user", async () => {
    const user = await insertTestUser({ externalId: "user_deleted_in_clerk" });
    vi.mocked(listClerkUserMemberships).mockResolvedValueOnce("not_found");

    const res = await request(app).get(`/internal/users/${user.id}/orgs`).set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("identity_not_found");
  });

  it("400 on a non-uuid userId", async () => {
    const res = await request(app).get("/internal/users/nope/orgs").set("x-api-key", API_KEY);
    expect(res.status).toBe(400);
  });

  it("401 without the api key", async () => {
    const res = await request(app).get(`/internal/users/${randomId()}/orgs`);
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/orgs/names", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    clearIdentityCaches();
    vi.mocked(getClerkOrganizationNames).mockReset();
  });

  it("3 known org ids in, 3 names out, in one Clerk batch", async () => {
    const a = await insertTestOrg({ externalId: "org_na" });
    const b = await insertTestOrg({ externalId: "org_nb" });
    const c = await insertTestOrg({ externalId: "org_nc" });
    vi.mocked(getClerkOrganizationNames).mockResolvedValueOnce(
      new Map([["org_na", "A"], ["org_nb", "B"], ["org_nc", "C"]]),
    );

    const res = await request(app)
      .post("/internal/orgs/names")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [a.id, b.id, c.id] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgs: [
        { id: a.id, name: "A" },
        { id: b.id, name: "B" },
        { id: c.id, name: "C" },
      ],
      missing: [],
      maxStalenessSeconds: 60,
    });
    expect(getClerkOrganizationNames).toHaveBeenCalledTimes(1);
  });

  it("an org Clerk does not know falls back to the stored name; an unknown id is missing", async () => {
    const anon = await insertTestOrg({ externalId: "anon_x", name: "Stored", anonymousAt: new Date() });
    const unknown = randomId();
    vi.mocked(getClerkOrganizationNames).mockResolvedValueOnce(new Map());

    const res = await request(app)
      .post("/internal/orgs/names")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [anon.id, unknown] });

    expect(res.status).toBe(200);
    expect(res.body.orgs).toEqual([{ id: anon.id, name: "Stored" }]);
    expect(res.body.missing).toEqual([unknown]);
  });

  it("names are cached: a second call for the same orgs makes no Clerk call", async () => {
    const a = await insertTestOrg({ externalId: "org_cache_a" });
    vi.mocked(getClerkOrganizationNames).mockResolvedValueOnce(new Map([["org_cache_a", "A"]]));

    await request(app).post("/internal/orgs/names").set("x-api-key", API_KEY).send({ orgIds: [a.id] });
    const res = await request(app).post("/internal/orgs/names").set("x-api-key", API_KEY).send({ orgIds: [a.id] });

    expect(res.body.orgs).toEqual([{ id: a.id, name: "A" }]);
    expect(getClerkOrganizationNames).toHaveBeenCalledTimes(1);
  });

  it("identity-provider failure is a 502, never null names", async () => {
    const a = await insertTestOrg({ externalId: "org_fail" });
    vi.mocked(getClerkOrganizationNames).mockRejectedValueOnce(new ClerkServiceError(500, "boom"));

    const res = await request(app).post("/internal/orgs/names").set("x-api-key", API_KEY).send({ orgIds: [a.id] });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("identity_provider_unavailable");
  });

  it("empty list in, empty list out, no Clerk call", async () => {
    const res = await request(app).post("/internal/orgs/names").set("x-api-key", API_KEY).send({ orgIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.orgs).toEqual([]);
    expect(getClerkOrganizationNames).not.toHaveBeenCalled();
  });

  it("400 on more than 500 ids or non-uuids", async () => {
    const tooMany = Array.from({ length: 501 }, () => randomId());
    const r1 = await request(app).post("/internal/orgs/names").set("x-api-key", API_KEY).send({ orgIds: tooMany });
    const r2 = await request(app).post("/internal/orgs/names").set("x-api-key", API_KEY).send({ orgIds: ["x"] });
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });
});

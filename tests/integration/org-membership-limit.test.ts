import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";

const clerkOrgs = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ organizations: clerkOrgs, users: {} }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg } from "../helpers/test-db.js";

const API_KEY = "test_api_key";

describe("/internal/orgs/:orgId/membership-limit", () => {
  const app = createTestApp();
  let orgId: string;
  let clerkMax: number;

  const read = (o = orgId) => request(app).get(`/internal/orgs/${o}/membership-limit`).set("x-api-key", API_KEY);
  const set = (body: Record<string, unknown>, o = orgId) =>
    request(app).put(`/internal/orgs/${o}/membership-limit`).set("x-api-key", API_KEY).send(body);

  beforeEach(async () => {
    await cleanTestData();
    Object.values(clerkOrgs).forEach((m) => m.mockReset());
    clerkMax = 20;
    clerkOrgs.getOrganization.mockImplementation(async () => ({ id: "org_Client1", maxAllowedMemberships: clerkMax, membersCount: 6 }));
    clerkOrgs.updateOrganization.mockImplementation(async (_id: string, p: { maxAllowedMemberships: number }) => {
      clerkMax = p.maxAllowedMemberships;
      return {};
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) })),
    );
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    orgId = (await insertTestOrg({ externalId: "org_Client1" })).id;
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("reads the org's limit and member count from Clerk", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maxAllowedMemberships: 20, membersCount: 6 });
    expect(clerkOrgs.getOrganization).toHaveBeenCalledWith({ organizationId: "org_Client1", includeMembersCount: true });
  });

  it("sets a number, and null as no limit (Clerk's 0), served back as null", async () => {
    expect((await set({ maxAllowedMemberships: 12 })).body).toEqual({ maxAllowedMemberships: 12, membersCount: 6 });
    expect(clerkOrgs.updateOrganization).toHaveBeenLastCalledWith("org_Client1", { maxAllowedMemberships: 12 });
    expect((await set({ maxAllowedMemberships: null })).body).toEqual({ maxAllowedMemberships: null, membersCount: 6 });
    expect(clerkOrgs.updateOrganization).toHaveBeenLastCalledWith("org_Client1", { maxAllowedMemberships: 0 });
  });

  it("a value the Clerk plan refuses is a 422 in Clerk's words, never clamped", async () => {
    clerkOrgs.updateOrganization.mockRejectedValue({
      status: 402,
      errors: [{ message: "Unsupported plan features", longMessage: "Some features are not supported in your current plan." }],
    });
    const res = await set({ maxAllowedMemberships: 100 });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "limit_refused", message: "Clerk: Some features are not supported in your current plan." });
    expect(clerkOrgs.updateOrganization).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad body, an unknown org and an org with no identity, touching nothing", async () => {
    expect((await set({ maxAllowedMemberships: 0 })).status).toBe(400);
    expect((await set({})).status).toBe(400);
    expect((await set({ maxAllowedMemberships: 2.5 })).status).toBe(400);
    expect((await read("00000000-0000-4000-8000-000000000001")).body.error).toBe("org_not_found");
    const anon = await insertTestOrg({ externalId: "anon_x", anonymousAt: new Date() });
    expect((await set({ maxAllowedMemberships: 10 }, anon.id)).body.error).toBe("org_has_no_identity");
    expect(clerkOrgs.updateOrganization).not.toHaveBeenCalled();
  });

  it("a Clerk failure on read is a 502, never a made-up limit", async () => {
    clerkOrgs.getOrganization.mockRejectedValue({ status: 500, errors: [{ message: "down" }] });
    const res = await read();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("identity_provider_failed");
  });
});

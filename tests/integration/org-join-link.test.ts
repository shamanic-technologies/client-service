import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";

const clerkOrgs = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  updateOrganizationMetadata: vi.fn(),
  createOrganizationInvitation: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ organizations: clerkOrgs, users: {} }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestUser } from "../helpers/test-db.js";

const API_KEY = "test_api_key";

describe("/internal/orgs/:orgId/join-link", () => {
  const app = createTestApp();
  let orgId: string;
  let staffId: string;
  let privateMetadata: Record<string, unknown>;

  const mint = (o = orgId, body: Record<string, unknown> = { createdByUserId: staffId }) =>
    request(app).post(`/internal/orgs/${o}/join-link`).set("x-api-key", API_KEY).send(body);
  const read = (o = orgId) => request(app).get(`/internal/orgs/${o}/join-link`).set("x-api-key", API_KEY);
  const revoke = (o = orgId) => request(app).delete(`/internal/orgs/${o}/join-link`).set("x-api-key", API_KEY);

  beforeEach(async () => {
    await cleanTestData();
    Object.values(clerkOrgs).forEach((m) => m.mockReset());
    privateMetadata = { other: "kept" };
    clerkOrgs.getOrganization.mockImplementation(async () => ({ id: "org_Client1", name: "Acme Co", privateMetadata }));
    clerkOrgs.updateOrganizationMetadata.mockImplementation(
      async (_id: string, patch: { privateMetadata: Record<string, unknown> }) => {
        // Clerk merges the patch; a null value removes the key.
        for (const [k, v] of Object.entries(patch.privateMetadata)) {
          if (v === null) delete privateMetadata[k];
          else privateMetadata[k] = v;
        }
        return {};
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) })),
    );
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    orgId = (await insertTestOrg({ externalId: "org_Client1" })).id;
    staffId = (await insertTestUser({ externalId: "user_staff" })).id;
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("mints the dashboard's link on the Clerk org, sending nothing, and returns it", async () => {
    const res = await mint();
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const stored = privateMetadata.inviteLink as { code: string; createdAt: string; createdBy: string };
    expect(stored.code).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(stored.createdBy).toBe("user_staff");
    expect(privateMetadata.other).toBe("kept");
    expect(res.body.link).toEqual({
      url: `https://dashboard.distribute.you/join/${encodeURIComponent(`org_Client1.${stored.code}`)}?bn=Acme+Co`,
      createdAt: stored.createdAt,
    });
    expect(clerkOrgs.createOrganizationInvitation).not.toHaveBeenCalled();
  });

  it("is one link per org: a second mint returns the same link, and GET reads it", async () => {
    const first = await mint();
    const second = await mint();
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ link: first.body.link, created: false });
    expect(clerkOrgs.updateOrganizationMetadata).toHaveBeenCalledTimes(1);
    expect((await read()).body).toEqual({ link: first.body.link });
  });

  it("revoke removes it; minting again gives a new link; revoking nothing is a no-op", async () => {
    const first = await mint();
    expect((await revoke()).body).toEqual({ revoked: true });
    expect(privateMetadata.inviteLink).toBeUndefined();
    expect((await read()).body).toEqual({ link: null });
    expect((await revoke()).body).toEqual({ revoked: false });
    const again = await mint();
    expect(again.status).toBe(201);
    expect(again.body.link.url).not.toBe(first.body.link.url);
  });

  it("refuses an org with no identity, an unknown org, an unknown creator and a bad body", async () => {
    const anon = await insertTestOrg({ externalId: "anon_x", anonymousAt: new Date() });
    expect((await mint(anon.id)).body.error).toBe("org_has_no_identity");
    expect((await mint("00000000-0000-4000-8000-000000000001")).body.error).toBe("org_not_found");
    expect((await mint(orgId, { createdByUserId: "00000000-0000-4000-8000-000000000002" })).body.error).toBe("user_not_found");
    expect((await mint(orgId, {})).status).toBe(400);
    expect(clerkOrgs.updateOrganizationMetadata).not.toHaveBeenCalled();
  });

  it("a Clerk failure is a 502, never a null link", async () => {
    clerkOrgs.getOrganization.mockRejectedValue({ status: 500, errors: [{ message: "down" }] });
    const res = await read();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("identity_provider_failed");
  });
});

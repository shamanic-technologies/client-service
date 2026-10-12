import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";

const clerk = vi.hoisted(() => ({
  getOrganizationInvitationList: vi.fn(),
  createOrganizationInvitation: vi.fn(),
  revokeOrganizationInvitation: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ organizations: clerk }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestUser } from "../helpers/test-db.js";

const API_KEY = "test_api_key";
const T = Date.parse("2026-10-12T10:00:00Z");

type Inv = { id: string; emailAddress: string; role: string; status: string; url: string | null; createdAt: number; expiresAt: number };

describe("org member invitations", () => {
  const app = createTestApp();
  let orgId: string;
  let userId: string;
  let pending: Inv[];

  const path = (o = orgId) => `/internal/orgs/${o}/member-invitations`;
  const invite = (body: Record<string, unknown>, o = orgId) =>
    request(app).post(path(o)).set("x-api-key", API_KEY).send(body);

  beforeEach(async () => {
    await cleanTestData();
    Object.values(clerk).forEach((m) => m.mockReset());
    pending = [];
    clerk.getOrganizationInvitationList.mockImplementation(async () => ({ data: pending, totalCount: pending.length }));
    clerk.createOrganizationInvitation.mockImplementation(async (p: { emailAddress: string; role: string }) => {
      const inv: Inv = {
        id: `orginv_${pending.length + 1}`,
        emailAddress: p.emailAddress,
        role: p.role,
        status: "pending",
        url: `https://clerk.test/v1/tickets/accept?ticket=t${pending.length + 1}`,
        createdAt: T,
        expiresAt: T + 30 * 86400_000,
      };
      pending.push(inv);
      return inv;
    });
    clerk.revokeOrganizationInvitation.mockImplementation(async ({ invitationId }: { invitationId: string }) => {
      const i = pending.findIndex((p) => p.id === invitationId);
      if (i < 0) throw { status: 404, errors: [{ message: "not found" }] };
      const [inv] = pending.splice(i, 1);
      return { ...inv, status: "revoked" };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) })),
    );
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    const org = await insertTestOrg({ externalId: "org_client" });
    orgId = org.id;
    userId = (await insertTestUser({ externalId: "user_admin", orgId })).id;
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("invites as admin with a dashboard /invite redirect, returns the link, lists it, revokes it", async () => {
    const res = await invite({ email: " Jane@Acme.com ", invitedByUserId: userId });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.invitation).toMatchObject({
      id: "orginv_1",
      email: "jane@acme.com",
      role: "org:admin",
      status: "pending",
      inviteUrl: expect.stringContaining("ticket="),
      expiresAt: "2026-11-11T10:00:00.000Z",
    });
    expect(clerk.createOrganizationInvitation).toHaveBeenCalledWith({
      organizationId: "org_client",
      emailAddress: "jane@acme.com",
      role: "org:admin",
      inviterUserId: "user_admin",
      redirectUrl: "https://dashboard.distribute.you/invite?org=org_client",
    });

    const list = await request(app).get(path()).set("x-api-key", API_KEY);
    expect(list.status).toBe(200);
    expect(list.body.invitations.map((i: { id: string }) => i.id)).toEqual(["orginv_1"]);

    const del = await request(app).delete(`${path()}/orginv_1`).set("x-api-key", API_KEY);
    expect(del.status).toBe(200);
    expect(del.body.invitation.status).toBe("revoked");
    const after = await request(app).get(path()).set("x-api-key", API_KEY);
    expect(after.body.invitations).toEqual([]);
  });

  it("re-inviting a pending email returns the pending invitation, never a second one", async () => {
    await invite({ email: "jane@acme.com", invitedByUserId: userId });
    const again = await invite({ email: "JANE@acme.com", invitedByUserId: userId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, invitation: { id: "orginv_1" } });
    expect(clerk.createOrganizationInvitation).toHaveBeenCalledTimes(1);
  });

  it("surfaces a Clerk refusal in Clerk's words as 422", async () => {
    clerk.createOrganizationInvitation.mockRejectedValueOnce({
      status: 400,
      errors: [{ message: "already a member", longMessage: "jane@acme.com is already a member of this organization." }],
    });
    const res = await invite({ email: "jane@acme.com", invitedByUserId: userId });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invitation_refused", message: "jane@acme.com is already a member of this organization." });
  });

  it("502s when Clerk returns no link, and when Clerk cannot be read", async () => {
    clerk.createOrganizationInvitation.mockResolvedValueOnce({
      id: "orginv_x", emailAddress: "a@b.co", role: "org:admin", status: "pending", url: null, createdAt: T, expiresAt: T,
    });
    expect((await invite({ email: "a@b.co", invitedByUserId: userId })).body.error).toBe("invite_link_unavailable");

    clerk.getOrganizationInvitationList.mockRejectedValueOnce({ status: 503, errors: [{ message: "down" }] });
    const list = await request(app).get(path()).set("x-api-key", API_KEY);
    expect(list.status).toBe(502);
    expect(list.body.error).toBe("identity_provider_failed");
  });

  it("404s unknown org, unknown inviter, unknown invitation", async () => {
    expect((await invite({ email: "a@b.co", invitedByUserId: userId }, crypto.randomUUID())).body.error).toBe("org_not_found");
    expect((await invite({ email: "a@b.co", invitedByUserId: crypto.randomUUID() })).body.error).toBe("user_not_found");
    const del = await request(app).delete(`${path()}/orginv_nope`).set("x-api-key", API_KEY);
    expect(del.status).toBe(404);
    expect(del.body.error).toBe("invitation_not_found");
  });

  it("409s an org with no identity provider account (signed-out onboarding, unclaimed)", async () => {
    const anon = await insertTestOrg({ externalId: "anon_123", anonymousAt: new Date() });
    const res = await invite({ email: "a@b.co", invitedByUserId: userId }, anon.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("org_has_no_identity");
    expect(clerk.getOrganizationInvitationList).not.toHaveBeenCalled();
  });

  it("400s a bad email", async () => {
    expect((await invite({ email: "nope", invitedByUserId: userId })).status).toBe(400);
  });
});

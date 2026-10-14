import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

const clerkUsers = vi.hoisted(() => ({
  getUserList: vi.fn(),
  createUser: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
}));
const clerkOrgs = vi.hoisted(() => ({
  createOrganizationMembership: vi.fn(),
  deleteOrganizationMembership: vi.fn(),
  createOrganizationInvitation: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ organizations: clerkOrgs, users: clerkUsers }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestUser } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";

const API_KEY = "test_api_key";

describe("POST /internal/orgs/:orgId/members", () => {
  const app = createTestApp();
  let orgId: string;
  let clerkMembers: Map<string, string[]>; // clerkUserId -> clerkOrgIds
  let clerkEmails: Map<string, string>; // email -> clerkUserId

  const add = (body: Record<string, unknown>, o = orgId) =>
    request(app).post(`/internal/orgs/${o}/members`).set("x-api-key", API_KEY).send(body);

  beforeEach(async () => {
    await cleanTestData();
    [...Object.values(clerkUsers), ...Object.values(clerkOrgs)].forEach((m) => m.mockReset());
    clerkMembers = new Map();
    clerkEmails = new Map();
    clerkUsers.getUserList.mockImplementation(async ({ emailAddress }: { emailAddress: string[] }) => {
      const id = clerkEmails.get(emailAddress[0]);
      return { data: id ? [{ id, privateMetadata: {} }] : [], totalCount: id ? 1 : 0 };
    });
    clerkUsers.createUser.mockImplementation(async ({ emailAddress }: { emailAddress: string[] }) => {
      const id = `user_${clerkEmails.size + 1}`;
      clerkEmails.set(emailAddress[0], id);
      return { id };
    });
    clerkUsers.getOrganizationMembershipList.mockImplementation(async ({ userId }: { userId: string }) => {
      const data = (clerkMembers.get(userId) ?? []).map((o) => ({ organization: { id: o, name: o }, role: "org:admin" }));
      return { data, totalCount: data.length };
    });
    clerkOrgs.createOrganizationMembership.mockImplementation(
      async ({ organizationId, userId }: { organizationId: string; userId: string }) => {
        clerkMembers.set(userId, [...(clerkMembers.get(userId) ?? []), organizationId]);
        return {};
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) })),
    );
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    orgId = (await insertTestOrg({ externalId: "org_client" })).id;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates the person admin-side and adds them as a member, sending no invitation", async () => {
    const res = await add({ email: " Prospect@Acme.com " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      member: { clerkUserId: "user_1", email: "prospect@acme.com", orgId, role: "org:admin" },
      userCreated: true,
      membershipCreated: true,
    });
    expect(clerkUsers.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ emailAddress: ["prospect@acme.com"], skipPasswordRequirement: true }),
    );
    expect(clerkOrgs.createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: "org_client",
      userId: "user_1",
      role: "org:admin",
    });
    expect(clerkOrgs.createOrganizationInvitation).not.toHaveBeenCalled();
    const [row] = await db.select().from(users).where(eq(users.id, res.body.member.userId));
    expect(row).toMatchObject({ externalId: "user_1", email: "prospect@acme.com", orgId });
  });

  it("is idempotent: a second call is a 200 replay with the same user", async () => {
    const first = await add({ email: "p@acme.com" });
    const second = await add({ email: "p@acme.com" });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ userCreated: false, membershipCreated: false });
    expect(second.body.member.userId).toBe(first.body.member.userId);
    expect(clerkUsers.createUser).toHaveBeenCalledTimes(1);
    expect(clerkOrgs.createOrganizationMembership).toHaveBeenCalledTimes(1);
  });

  it("an existing person keeps their user row and last-active org, and gains the membership", async () => {
    const other = await insertTestOrg({ externalId: "org_other" });
    clerkEmails.set("known@acme.com", "user_known");
    clerkMembers.set("user_known", ["org_other"]);
    const existing = await insertTestUser({ externalId: "user_known", orgId: other.id });

    const res = await add({ email: "known@acme.com" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ member: { userId: existing.id }, userCreated: false, membershipCreated: true });
    expect(clerkUsers.createUser).not.toHaveBeenCalled();
    const [row] = await db.select().from(users).where(eq(users.id, existing.id));
    expect(row.orgId).toBe(other.id);
  });

  it("refuses an org with no identity, an unknown org, and a bad email", async () => {
    const anon = await insertTestOrg({ externalId: "anon_x", anonymousAt: new Date() });
    expect((await add({ email: "p@acme.com" }, anon.id)).status).toBe(409);
    expect((await add({ email: "p@acme.com" }, "00000000-0000-4000-8000-000000000001")).body.error).toBe("org_not_found");
    expect((await add({ email: "nope" })).status).toBe(400);
    expect(clerkOrgs.createOrganizationMembership).not.toHaveBeenCalled();
  });

  it("a Clerk refusal is a 422 in Clerk's words, a Clerk outage a 502", async () => {
    clerkOrgs.createOrganizationMembership.mockRejectedValueOnce({ status: 422, errors: [{ message: "Nope", longMessage: "Not allowed" }] });
    const refused = await add({ email: "p@acme.com" });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("member_refused");
    clerkUsers.getUserList.mockRejectedValueOnce({ status: 503, errors: [{ message: "down" }] });
    expect((await add({ email: "q@acme.com" })).status).toBe(502);
  });

  it("requires the service key", async () => {
    expect((await request(app).post(`/internal/orgs/${orgId}/members`).send({ email: "p@acme.com" })).status).toBe(401);
  });
});

describe("DELETE /internal/orgs/:orgId/members/:userId", () => {
  const app = createTestApp();
  let orgId: string;
  let clerkMembers: Map<string, string[]>;

  const remove = (userId: string, o = orgId) =>
    request(app).delete(`/internal/orgs/${o}/members/${userId}`).set("x-api-key", API_KEY);

  beforeEach(async () => {
    await cleanTestData();
    [...Object.values(clerkUsers), ...Object.values(clerkOrgs)].forEach((m) => m.mockReset());
    clerkMembers = new Map();
    clerkOrgs.deleteOrganizationMembership.mockImplementation(
      async ({ organizationId, userId }: { organizationId: string; userId: string }) => {
        const orgsOf = clerkMembers.get(userId) ?? [];
        if (!orgsOf.includes(organizationId)) throw Object.assign(new Error("Not Found"), { status: 404 });
        clerkMembers.set(userId, orgsOf.filter((o) => o !== organizationId));
        return {};
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) })),
    );
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    orgId = (await insertTestOrg({ externalId: "org_client" })).id;
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("ends the membership and leaves the person's own org alone", async () => {
    const own = await insertTestOrg({ externalId: "org_own" });
    const u = await insertTestUser({ externalId: "user_adam", orgId: own.id });
    clerkMembers.set("user_adam", ["org_own", "org_client"]);

    const res = await remove(u.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: u.id, orgId, membershipRemoved: true, lastActiveOrgCleared: false });
    expect(clerkOrgs.deleteOrganizationMembership).toHaveBeenCalledWith({ organizationId: "org_client", userId: "user_adam" });
    expect(clerkMembers.get("user_adam")).toEqual(["org_own"]);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.orgId).toBe(own.id);
  });

  it("clears the last-active org when it was this one, so the org's user list stops naming them", async () => {
    const u = await insertTestUser({ externalId: "user_x", orgId });
    clerkMembers.set("user_x", ["org_client"]);

    const res = await remove(u.id);
    expect(res.body).toMatchObject({ membershipRemoved: true, lastActiveOrgCleared: true });
    const list = await request(app).get("/internal/users").set("x-api-key", API_KEY).query({ orgId });
    expect(list.body.total).toBe(0);
  });

  it("is idempotent: a non-member is a 200 with membershipRemoved false", async () => {
    const u = await insertTestUser({ externalId: "user_y" });
    const res = await remove(u.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ membershipRemoved: false, lastActiveOrgCleared: false });
  });

  it("refuses an unknown user, an unknown org, an org with no identity, a bad id", async () => {
    const u = await insertTestUser({ externalId: "user_z" });
    expect((await remove("00000000-0000-4000-8000-000000000001")).body.error).toBe("user_not_found");
    expect((await remove(u.id, "00000000-0000-4000-8000-000000000001")).body.error).toBe("org_not_found");
    const anon = await insertTestOrg({ externalId: "anon_y", anonymousAt: new Date() });
    expect((await remove(u.id, anon.id)).status).toBe(409);
    expect((await remove("nope")).status).toBe(400);
    expect(clerkOrgs.deleteOrganizationMembership).not.toHaveBeenCalled();
  });

  it("a Clerk refusal is a 422 in Clerk's words, a Clerk outage a 502", async () => {
    const u = await insertTestUser({ externalId: "user_w" });
    clerkOrgs.deleteOrganizationMembership.mockRejectedValueOnce({ status: 403, errors: [{ message: "Nope", longMessage: "Last admin" }] });
    const refused = await remove(u.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("member_removal_refused");
    clerkOrgs.deleteOrganizationMembership.mockRejectedValueOnce({ status: 503, errors: [{ message: "down" }] });
    expect((await remove(u.id)).status).toBe(502);
  });

  it("requires the service key", async () => {
    expect((await request(app).delete(`/internal/orgs/${orgId}/members/00000000-0000-4000-8000-000000000001`)).status).toBe(401);
  });
});

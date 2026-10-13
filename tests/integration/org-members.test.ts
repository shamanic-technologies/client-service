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
  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

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

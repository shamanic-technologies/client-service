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
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ organizations: clerkOrgs, users: clerkUsers }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestUser } from "../helpers/test-db.js";
import { resetOnboardingPhoneSyncState } from "../../src/lib/onboarding-phone.js";
import { db } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";

const API_KEY = "test_api_key";
const PHONE = "+15557650000";

describe("POST /internal/orgs/:orgId/phone-members", () => {
  const app = createTestApp();
  let orgId: string;
  let clerkMembers: Map<string, string[]>; // clerkUserId -> clerkOrgIds
  let clerkEmails: Map<string, string>; // email -> clerkUserId
  let onboardingPhones: Array<{ id: string; phone: string }>;

  const add = (body: Record<string, unknown>, o = orgId) =>
    request(app).post(`/internal/orgs/${o}/phone-members`).set("x-api-key", API_KEY).send(body);
  const resolve = (phone = PHONE) =>
    request(app).get("/internal/phone-accounts").set("x-api-key", API_KEY).query({ phone });

  beforeEach(async () => {
    await cleanTestData();
    resetOnboardingPhoneSyncState();
    [...Object.values(clerkUsers), ...Object.values(clerkOrgs)].forEach((m) => m.mockReset());
    clerkMembers = new Map();
    clerkEmails = new Map();
    onboardingPhones = [];
    clerkUsers.getUserList.mockImplementation(async (q: { emailAddress?: string[] } = {}) => {
      if (q.emailAddress) {
        const id = clerkEmails.get(q.emailAddress[0]);
        return { data: id ? [{ id, privateMetadata: {} }] : [], totalCount: id ? 1 : 0 };
      }
      // The onboarding-phone sweep (no filter): every Clerk user with publicMetadata.phone.
      const data = onboardingPhones.map((u) => ({ id: u.id, publicMetadata: { phone: u.phone } }));
      return { data, totalCount: data.length };
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

  it("a phone declared member of org X resolves to org X", async () => {
    expect((await resolve()).status).toBe(404);

    const res = await add({ phone: PHONE });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      member: { clerkUserId: "user_1", phone: PHONE, orgId, role: "org:admin" },
      userCreated: true,
      membershipCreated: true,
    });
    // Keyed on the placeholder email a phone-born account uses; nothing is sent.
    expect(clerkUsers.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: ["wa-15557650000@phone.distribute.you"],
        skipPasswordRequirement: true,
        privateMetadata: { signupSource: "phone_member_added" },
      }),
    );
    expect(clerkOrgs.createOrganizationMembership).toHaveBeenCalledWith({
      organizationId: "org_client",
      userId: "user_1",
      role: "org:admin",
    });

    const resolved = await resolve();
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ orgId, userId: res.body.member.userId, clerkOrgId: "org_client" });
  });

  it("the channel's provisioning never gives the declared number a second org", async () => {
    await add({ phone: PHONE });
    const provision = await request(app).post("/internal/phone-accounts").set("x-api-key", API_KEY).send({ phone: PHONE });
    expect(provision.status).toBe(200);
    expect(provision.body).toMatchObject({ orgId, created: false });
  });

  it("is idempotent: a second call is a 200 replay with the same user", async () => {
    const first = await add({ phone: PHONE });
    const second = await add({ phone: PHONE });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ userCreated: false, membershipCreated: false });
    expect(second.body.member.userId).toBe(first.body.member.userId);
    expect(clerkUsers.createUser).toHaveBeenCalledTimes(1);
    expect(clerkOrgs.createOrganizationMembership).toHaveBeenCalledTimes(1);
  });

  it("keeps the membership when the person later has a real email on the same user", async () => {
    const added = await add({ phone: PHONE });
    await db.update(users).set({ email: "sam@acme.com" }).where(eq(users.id, added.body.member.userId));
    const resolved = await resolve();
    expect(resolved.body).toMatchObject({ orgId, userId: added.body.member.userId });
    expect(clerkMembers.get("user_1")).toEqual(["org_client"]);
  });

  it("refuses a number that already answers for another account, and moves nothing", async () => {
    const other = await insertTestOrg({ externalId: "org_other" });
    const holder = await insertTestUser({ externalId: "user_holder", orgId: other.id });
    await db.update(users).set({ phone: PHONE }).where(eq(users.id, holder.id));

    const res = await add({ phone: PHONE });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("phone_belongs_to_another_account");
    expect(clerkOrgs.createOrganizationMembership).not.toHaveBeenCalled();
    expect((await resolve()).body.orgId).toBe(other.id);
  });

  it("refuses a number another account's user typed on onboarding", async () => {
    const other = await insertTestOrg({ externalId: "org_other" });
    await insertTestUser({ externalId: "user_typed", orgId: other.id });
    onboardingPhones = [{ id: "user_typed", phone: PHONE }];

    const res = await add({ phone: PHONE });
    expect(res.status).toBe(409);
    expect(clerkUsers.createUser).not.toHaveBeenCalled();
  });

  it("re-adds a phone-only person who was removed from every org", async () => {
    const added = await add({ phone: PHONE });
    await db.update(users).set({ orgId: null }).where(eq(users.id, added.body.member.userId));
    clerkMembers.set("user_1", []);

    const res = await add({ phone: PHONE });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ member: { userId: added.body.member.userId }, userCreated: false, membershipCreated: true });
    expect((await resolve()).body.orgId).toBe(orgId);
  });

  it("refuses an org with no identity, an unknown org, and a number that is not E.164", async () => {
    const anon = await insertTestOrg({ externalId: "anon_x", anonymousAt: new Date() });
    expect((await add({ phone: PHONE }, anon.id)).body.error).toBe("org_has_no_identity");
    expect((await add({ phone: PHONE }, "00000000-0000-4000-8000-000000000001")).body.error).toBe("org_not_found");
    expect((await add({ phone: "0612345678" })).status).toBe(400);
    expect(clerkOrgs.createOrganizationMembership).not.toHaveBeenCalled();
  });

  it("a Clerk outage is a 502", async () => {
    clerkUsers.getUserList.mockRejectedValue({ status: 503, errors: [{ message: "down" }] });
    expect((await add({ phone: PHONE })).status).toBe(502);
  });

  it("requires the service key", async () => {
    expect((await request(app).post(`/internal/orgs/${orgId}/phone-members`).send({ phone: PHONE })).status).toBe(401);
  });
});

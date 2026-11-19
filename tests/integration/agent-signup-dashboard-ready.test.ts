import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";

// Clerk SDK mocked: no network, no secret. Clerk "state" is the per-test mocks.
const clerk = vi.hoisted(() => ({
  getUserList: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
  createOrganization: vi.fn(),
  deleteOrganization: vi.fn(),
  updateOrganizationMetadata: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: {
      getUserList: clerk.getUserList,
      createUser: clerk.createUser,
      deleteUser: clerk.deleteUser,
      getOrganizationMembershipList: clerk.getOrganizationMembershipList,
    },
    organizations: {
      createOrganization: clerk.createOrganization,
      deleteOrganization: clerk.deleteOrganization,
      updateOrganizationMetadata: clerk.updateOrganizationMetadata,
    },
  }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestUser, randomId } from "../helpers/test-db.js";

const API_KEY = "test_api_key";
const EMAIL = "founder@acme.io";
const MARK = { publicMetadata: { onboardingComplete: true } };

/**
 * An account that comes through the agent-signup completion is set up in a
 * conversation, never by the dashboard's walk, so nothing else ever writes the
 * dashboard's first-run flag (Clerk org `publicMetadata.onboardingComplete`).
 * Without it the dashboard sends the person back to the org page on every page
 * and offers their running brand as "Finish setup". The completion writes it,
 * on the org it answers with, every time.
 */
describe("POST /internal/agent-signups/complete marks the org set up for the dashboard", () => {
  const app = createTestApp();
  const fetchMock = vi.fn();

  const callsTo = (fragment: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));
  const lastCode = (): string => JSON.parse(callsTo("/platform-orgless-send").at(-1)![1].body).metadata.code;
  const start = () => request(app).post("/internal/agent-signups/start").set("x-api-key", API_KEY).send({ email: EMAIL });
  const complete = (body: Record<string, unknown>) =>
    request(app).post("/internal/agent-signups/complete").set("x-api-key", API_KEY).send({ email: EMAIL, ...body });

  const clerkKnows = (id: string, signupSource?: string, memberOf: Array<Record<string, unknown>> = []) => {
    clerk.getUserList.mockResolvedValue({
      data: [{ id, privateMetadata: signupSource ? { signupSource } : {} }],
      totalCount: 1,
    });
    clerk.getOrganizationMembershipList.mockResolvedValue({
      data: memberOf.map((organization) => ({ organization, role: "org:admin" })),
      totalCount: memberOf.length,
    });
  };

  beforeEach(async () => {
    await cleanTestData();
    Object.values(clerk).forEach((m) => m.mockReset());
    clerk.getUserList.mockResolvedValue({ data: [], totalCount: 0 });
    clerk.getOrganizationMembershipList.mockResolvedValue({ data: [], totalCount: 0 });
    clerk.createUser.mockResolvedValue({ id: "user_new" });
    clerk.createOrganization.mockResolvedValue({ id: "org_new", slug: "acme-io" });
    clerk.updateOrganizationMetadata.mockResolvedValue({});
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("key.test")) {
        return { ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) };
      }
      if (u.includes("/internal/brands/all")) return { ok: true, status: 200, json: async () => ({ brands: [] }) };
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    process.env.BILLING_SERVICE_URL = "https://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing_key";
    process.env.BRAND_SERVICE_URL = "https://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "brand_key";
    process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "https://tes.test";
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "tes_key";
    process.env.TELEGRAM_BOT_TOKEN = "bot";
    process.env.TELEGRAM_OWNER_CHAT_ID = "chat";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("a new account: its organization is marked set up", async () => {
    await start();
    const res = await complete({ code: lastCode() });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ clerkOrgId: "org_new", created: true });
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledTimes(1);
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledWith("org_new", MARK);
  });

  it("an existing account returned: the organization it answers with is marked, whoever created it", async () => {
    const org = await insertTestOrg({ externalId: "org_human", name: "Human Co" });
    await insertTestUser({ externalId: "user_human", email: EMAIL, orgId: org.id });
    clerkKnows("user_human");

    await start();
    const res = await complete({ code: lastCode() });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orgId: org.id, clerkOrgId: "org_human", created: false });
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledWith("org_human", MARK);
    expect(clerk.createOrganization).not.toHaveBeenCalled();
  });

  it("a claimed unclaimed org, for a new person and on the replay", async () => {
    const org = await insertTestOrg({ externalId: `anon_${randomId()}`, anonymousAt: new Date(), name: "Anonymous visitor" });
    await start();
    const code = lastCode();
    const body = { code, claimOrgId: org.id, claimOrgExternalId: org.externalId };

    const first = await complete(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ orgId: org.id, clerkOrgId: "org_new", orgClaim: "claimed" });
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledWith("org_new", MARK);

    clerkKnows("user_new", "agent_signup_claim", [{ id: "org_new", name: "acme.io" }]);
    const replay = await complete(body);
    expect(replay.body).toMatchObject({ orgId: org.id, orgClaim: "already_claimed" });
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledTimes(2);
    expect(clerk.updateOrganizationMetadata).toHaveBeenLastCalledWith("org_new", MARK);
  });

  it("a claimed unclaimed org taken by a returning person: the NEW organization is marked, the previous one is not touched", async () => {
    const previous = await insertTestOrg({ externalId: "org_previous", name: "Previous Co" });
    await insertTestUser({ externalId: "user_human", email: EMAIL, orgId: previous.id });
    clerkKnows("user_human", undefined, [{ id: "org_previous", name: "Previous Co" }]);
    const org = await insertTestOrg({ externalId: `anon_${randomId()}`, anonymousAt: new Date() });

    await start();
    const res = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });

    expect(res.status).toBe(200);
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledTimes(1);
    expect(clerk.updateOrganizationMetadata).toHaveBeenCalledWith("org_new", MARK);
  });

  it("a mark Clerk could not write is a 502 identity_provider_failed, and the same code then converges", async () => {
    clerk.updateOrganizationMetadata.mockRejectedValueOnce({ status: 500, errors: [{ code: "internal_clerk_error" }] });
    await start();
    const code = lastCode();

    const failed = await complete({ code });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("identity_provider_failed");

    clerkKnows("user_new", "agent_api", [{ id: "org_new", name: "acme.io" }]);
    const retried = await complete({ code });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ clerkOrgId: "org_new", created: false });
    expect(clerk.updateOrganizationMetadata).toHaveBeenLastCalledWith("org_new", MARK);
  });

  it("an org row naming an organization Clerk no longer knows still answers: nobody can sign in to it, there is nothing to mark", async () => {
    const org = await insertTestOrg({ externalId: "org_gone", name: "Gone" });
    await insertTestUser({ externalId: "user_human", email: EMAIL, orgId: org.id });
    clerkKnows("user_human");
    clerk.updateOrganizationMetadata.mockRejectedValue({ status: 404, errors: [{ code: "resource_not_found" }] });

    await start();
    const res = await complete({ code: lastCode() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ orgId: org.id, clerkOrgId: "org_gone" });
  });

  it("a refused completion marks nothing", async () => {
    await start();
    const right = lastCode();
    const wrong = await complete({ code: right === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);

    const noOrg = await complete({ code: right, claimOrgId: randomId(), claimOrgExternalId: "anon_unknown" });
    expect(noOrg.status).toBe(404);
    expect(clerk.updateOrganizationMetadata).not.toHaveBeenCalled();
  });
});

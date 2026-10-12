import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// Clerk SDK mocked: no network, no secret. Clerk "state" is the per-test mocks.
const clerk = vi.hoisted(() => ({
  getUserList: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  getOrganizationMembershipList: vi.fn(),
  createOrganization: vi.fn(),
  deleteOrganization: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: {
      getUserList: clerk.getUserList,
      createUser: clerk.createUser,
      deleteUser: clerk.deleteUser,
      getOrganizationMembershipList: clerk.getOrganizationMembershipList,
    },
    organizations: { createOrganization: clerk.createOrganization, deleteOrganization: clerk.deleteOrganization },
  }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestOrg, insertTestUser } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { agentSignupCodes, orgAcquisitions, orgs, users } from "../../src/db/schema.js";
import { recordFirstTouch } from "../../src/lib/acquisition.js";

const API_KEY = "test_api_key";
const EMAIL = "agent@example.com";
const PHONE = "+33612345678";

describe("agent-signups routes", () => {
  const app = createTestApp();
  const fetchMock = vi.fn();
  let emailFails = false;
  let billingFails = false;

  const callsTo = (fragment: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));
  const codeSends = () => callsTo("/platform-orgless-send");
  const lastCode = (): string => JSON.parse(codeSends().at(-1)![1].body).metadata.code;
  const billingMarks = () => callsTo("/agent-api-signup");
  const telegramTexts = () => callsTo("api.telegram.org").map(([, opts]) => JSON.parse(opts.body).text as string);

  const start = (email = EMAIL, phone = PHONE) =>
    request(app).post("/internal/agent-signups/start").set("x-api-key", API_KEY).send({ email, phone });
  const complete = (code: string, email = EMAIL) =>
    request(app).post("/internal/agent-signups/complete").set("x-api-key", API_KEY).send({ email, code });

  /** Fire-and-forget notifications settle on the next ticks. */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(async () => {
    await cleanTestData();
    Object.values(clerk).forEach((m) => m.mockReset());
    clerk.getUserList.mockResolvedValue({ data: [], totalCount: 0 });
    clerk.createUser.mockResolvedValue({ id: "user_agent" });
    clerk.createOrganization.mockResolvedValue({ id: "org_agent", slug: "example-com" });
    emailFails = false;
    billingFails = false;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("key.test")) {
        return { ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) };
      }
      if (u.includes("/platform-orgless-send") && emailFails) {
        return { ok: false, status: 502, text: async () => '{"code":"delivery_failed"}' };
      }
      if (u.includes("/agent-api-signup") && billingFails) {
        return { ok: false, status: 503, text: async () => "billing down" };
      }
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    process.env.BILLING_SERVICE_URL = "https://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing_key";
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

  describe("POST /internal/agent-signups/start", () => {
    it("emails a 6-digit code org-less, stores only its hash, and pings the owner", async () => {
      const res = await start("Agent@Example.com");

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(EMAIL);
      expect(res.body.codeTtlMinutes).toBe(15);
      expect(res.body.maxAttempts).toBe(5);
      expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());

      expect(codeSends()).toHaveLength(1);
      const [url, opts] = codeSends()[0];
      expect(url).toBe("https://tes.test/platform-orgless-send");
      expect(opts.headers["x-api-key"]).toBe("tes_key");
      expect(opts.headers).not.toHaveProperty("x-org-id");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        eventType: "agent_signup_code",
        recipientEmail: EMAIL,
        metadata: { code: expect.stringMatching(/^\d{6}$/), expiresInMinutes: 15 },
      });

      const [row] = await db.select().from(agentSignupCodes);
      expect(row.email).toBe(EMAIL);
      expect(row.phone).toBe(PHONE);
      expect(row.codeHash).not.toContain(body.metadata.code);

      // Nothing exists in the identity provider at this step.
      expect(clerk.createUser).not.toHaveBeenCalled();
      await settle();
      expect(telegramTexts()).toEqual([expect.stringContaining(`${EMAIL} · asked for an API signup code`)]);
    });

    it("re-requesting sends a NEW code and the earlier one stops working", async () => {
      await start();
      const first = lastCode();
      await start();
      const second = lastCode();
      expect(codeSends()).toHaveLength(2);

      if (first !== second) {
        const stale = await complete(first);
        expect(stale.status).toBe(400);
        expect(stale.body.error).toBe("code_invalid");
      }
      const ok = await complete(second);
      expect(ok.status).toBe(200);
    });

    it("a code email that fails is a 502 and the earlier code keeps working", async () => {
      await start();
      const first = lastCode();
      emailFails = true;

      const res = await start();
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("code_email_failed");
      expect(await db.select().from(agentSignupCodes)).toHaveLength(1);

      emailFails = false;
      expect((await complete(first)).status).toBe(200);
    });

    it("refuses a bad email or a non-E.164 phone with invalid_request", async () => {
      expect((await start("not-an-email")).body.error).toBe("invalid_request");
      const res = await start(EMAIL, "0612345678");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(codeSends()).toHaveLength(0);
    });

    it("never pings the owner about a staff address", async () => {
      await start("kevin+agenttest@distribute.you");
      await settle();
      expect(telegramTexts()).toHaveLength(0);
    });
  });

  describe("POST /internal/agent-signups/complete", () => {
    it("creates a full account with the REAL email, the phone, the agent_api first touch, and NO free money", async () => {
      await start();
      const res = await complete(lastCode());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        email: EMAIL,
        contactPhone: PHONE,
        clerkOrgId: "org_agent",
        clerkUserId: "user_agent",
        created: true,
      });

      // Clerk user carries the real email, no password, and the agent marker.
      expect(clerk.createUser).toHaveBeenCalledWith({
        emailAddress: [EMAIL],
        skipPasswordRequirement: true,
        privateMetadata: { signupSource: "agent_api" },
      });
      expect(clerk.createOrganization).toHaveBeenCalledWith({ name: "example.com", createdBy: "user_agent" });

      const [user] = await db.select().from(users).where(eq(users.id, res.body.userId));
      expect(user.email).toBe(EMAIL);
      expect(user.contactPhone).toBe(PHONE);
      expect(user.phone).toBeNull(); // never the WhatsApp mapping key
      expect(user.orgId).toBe(res.body.orgId);
      const [org] = await db.select().from(orgs).where(eq(orgs.id, res.body.orgId));
      expect(org.externalId).toBe("org_agent");
      expect(org.slug).toBe("example-com");
      expect(org.anonymousAt).toBeNull();

      const [touch] = await db.select().from(orgAcquisitions).where(eq(orgAcquisitions.orgId, res.body.orgId));
      expect(touch.channel).toBe("agent_api");
      expect(touch.recordedVia).toBe("agent_signup");

      // Billing: the agent marker only, never the welcome path.
      expect(billingMarks()).toHaveLength(1);
      const [markUrl, markOpts] = billingMarks()[0];
      expect(markUrl).toBe(`https://billing.test/internal/accounts/by-org/${res.body.orgId}/agent-api-signup`);
      expect(markOpts.method).toBe("PUT");
      expect(callsTo("/v1/accounts")).toHaveLength(0);

      // Staff told: the signup email and the owner's Telegram line.
      await settle();
      const staff = callsTo("/platform-send");
      expect(staff).toHaveLength(1);
      expect(staff[0][1].headers["x-org-id"]).toBe(res.body.orgId);
      expect(JSON.parse(staff[0][1].body)).toMatchObject({
        eventType: "signup_notification",
        metadata: { email: EMAIL, source: "agent_api" },
      });
      expect(telegramTexts().some((t) => t.includes(`${EMAIL} · signed up through the API`))).toBe(true);
    });

    it("is idempotent per email: the same code again, and a later new code, return the same account", async () => {
      await start();
      const code = lastCode();
      const first = await complete(code);
      expect(first.body.created).toBe(true);

      // From now on Clerk knows the email.
      clerk.getUserList.mockResolvedValue({
        data: [{ id: "user_agent", privateMetadata: { signupSource: "agent_api" } }],
        totalCount: 1,
      });

      const again = await complete(code);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ orgId: first.body.orgId, userId: first.body.userId, created: false });

      await start(EMAIL, "+15551234567");
      const later = await complete(lastCode());
      expect(later.body).toMatchObject({
        orgId: first.body.orgId,
        userId: first.body.userId,
        contactPhone: "+15551234567",
        created: false,
      });

      expect(clerk.createUser).toHaveBeenCalledTimes(1);
      expect(await db.select().from(orgs)).toHaveLength(1);
      // An agent org is re-marked on return (idempotent at billing) and never welcomed.
      expect(billingMarks()).toHaveLength(3);
      expect(callsTo("/v1/accounts")).toHaveLength(0);
      // Staff are told once, at creation.
      await settle();
      expect(callsTo("/platform-send")).toHaveLength(1);
    });

    it("returns an ordinary customer's existing account untouched at billing", async () => {
      const org = await insertTestOrg({ externalId: "org_human" });
      const human = await insertTestUser({ externalId: "user_human", email: EMAIL, orgId: org.id });
      await recordFirstTouch(db, org.id, { channel: "google_ads" }, "resolve");
      clerk.getUserList.mockResolvedValue({ data: [{ id: "user_human", privateMetadata: {} }], totalCount: 1 });

      await start();
      const res = await complete(lastCode());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ orgId: org.id, userId: human.id, clerkOrgId: "org_human", created: false });
      expect(billingMarks()).toHaveLength(0);
      expect(clerk.createUser).not.toHaveBeenCalled();
      const [touch] = await db.select().from(orgAcquisitions).where(eq(orgAcquisitions.orgId, org.id));
      expect(touch.channel).toBe("google_ads");
    });

    it("recovers an agent-born Clerk user whose provision stopped before our rows: agent touch + billing marker", async () => {
      clerk.getUserList.mockResolvedValue({
        data: [{ id: "user_half", privateMetadata: { signupSource: "agent_api" } }],
        totalCount: 1,
      });
      clerk.getOrganizationMembershipList.mockResolvedValue({
        data: [{ organization: { id: "org_half", name: "example.com" }, role: "org:admin" }],
        totalCount: 1,
      });

      await start();
      const res = await complete(lastCode());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ clerkOrgId: "org_half", clerkUserId: "user_half", created: false });
      const [touch] = await db.select().from(orgAcquisitions).where(eq(orgAcquisitions.orgId, res.body.orgId));
      expect(touch).toMatchObject({ channel: "agent_api", recordedVia: "agent_signup" });
      expect(billingMarks()).toHaveLength(1);
    });

    it("a billing marker failure is a 502 billing_unavailable and the retry converges", async () => {
      await start();
      const code = lastCode();
      billingFails = true;

      const failed = await complete(code);
      expect(failed.status).toBe(502);
      expect(failed.body.error).toBe("billing_unavailable");

      billingFails = false;
      clerk.getUserList.mockResolvedValue({
        data: [{ id: "user_agent", privateMetadata: { signupSource: "agent_api" } }],
        totalCount: 1,
      });
      const retried = await complete(code);
      expect(retried.status).toBe(200);
      expect(retried.body.created).toBe(false);
      expect(billingMarks()).toHaveLength(2);
    });

    it("a Clerk failure is a 502 identity_provider_failed and leaves nothing behind", async () => {
      clerk.createOrganization.mockRejectedValueOnce({ status: 422, errors: [{ code: "form_param_invalid" }] });
      await start();
      const res = await complete(lastCode());

      expect(res.status).toBe(502);
      expect(res.body.error).toBe("identity_provider_failed");
      expect(clerk.deleteUser).toHaveBeenCalledWith("user_agent");
      expect(await db.select().from(orgs)).toHaveLength(0);
    });

    it("a wrong code is code_invalid with attemptsLeft, then too_many_attempts", async () => {
      await start();
      const right = lastCode();
      const wrong = right === "000000" ? "111111" : "000000";

      for (let left = 4; left >= 0; left--) {
        const res = await complete(wrong);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: "code_invalid", attemptsLeft: left });
      }
      const locked = await complete(right);
      expect(locked.status).toBe(429);
      expect(locked.body.error).toBe("too_many_attempts");
      expect(clerk.createUser).not.toHaveBeenCalled();
    });

    it("an expired code is code_expired", async () => {
      await start();
      await db.update(agentSignupCodes).set({ expiresAt: new Date(Date.now() - 1000) });
      const res = await complete(lastCode());
      expect(res.status).toBe(410);
      expect(res.body.error).toBe("code_expired");
    });

    it("an email with no code is no_pending_code; a malformed code is invalid_request", async () => {
      const none = await complete("123456");
      expect(none.status).toBe(404);
      expect(none.body.error).toBe("no_pending_code");

      const bad = await complete("12ab");
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_request");
    });

    it("requires the service key", async () => {
      const res = await request(app).post("/internal/agent-signups/complete").send({ email: EMAIL, code: "123456" });
      expect(res.status).toBe(401);
    });
  });
});

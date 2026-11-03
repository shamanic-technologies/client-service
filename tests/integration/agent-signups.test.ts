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
        metadata: {
          code: expect.stringMatching(/^\d{6}$/),
          expiresInMinutes: 15,
          approveUrl: expect.stringMatching(/^https:\/\/api\.distribute\.you\/v1\/agent-signups\/approve\?token=[A-Za-z0-9_-]{43}$/),
          approvalTtlHours: 24,
        },
      });
      expect(res.body.pollToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.body.pollIntervalSeconds).toBe(5);
      expect(Date.parse(res.body.approvalExpiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);

      const [row] = await db.select().from(agentSignupCodes);
      expect(row.email).toBe(EMAIL);
      expect(row.phone).toBe(PHONE);
      expect(row.codeHash).not.toContain(body.metadata.code);
      // Both secrets are stored hashed only.
      expect(row.pollTokenHash).not.toBe(res.body.pollToken);
      expect(row.approvalTokenHash).not.toContain(new URL(body.metadata.approveUrl).searchParams.get("token"));

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
    it("names a free-mail account's org after the person, never the mail provider", async () => {
      const email = "jane.doe@gmail.com";
      await start(email);
      const res = await complete(lastCode(), email);
      expect(res.status).toBe(200);
      expect(clerk.createOrganization).toHaveBeenCalledWith({ name: "Jane Doe", createdBy: "user_agent" });
      const [org] = await db.select().from(orgs).where(eq(orgs.id, res.body.orgId));
      expect(org.name).toBe("Jane Doe");
    });

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

  describe("POST /internal/agent-signups/complete with whatsappPhone", () => {
    const WA = "+33770657585";
    const completeWa = (code: string, whatsappPhone: unknown, email = EMAIL) =>
      request(app)
        .post("/internal/agent-signups/complete")
        .set("x-api-key", API_KEY)
        .send({ email, code, whatsappPhone });
    const resolvePhone = (phone: string) =>
      request(app).get("/internal/phone-accounts").query({ phone }).set("x-api-key", API_KEY);

    it("binds the verified number: GET /internal/phone-accounts returns the proven account", async () => {
      await start();
      const res = await completeWa(lastCode(), WA);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ whatsappPhone: WA, whatsappPhoneMovedFromUserId: null, contactPhone: PHONE });

      const resolved = await resolvePhone(WA);
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ userId: res.body.userId, orgId: res.body.orgId, phone: WA });
      // The unverified start phone never becomes a mapping key.
      expect((await resolvePhone(PHONE)).status).toBe(404);
    });

    it("moves the number off its previous holder (a phone-origin shell), which stops resolving for it", async () => {
      const shellOrg = await insertTestOrg({ externalId: "org_shell", name: "WhatsApp user" });
      const [shell] = await db
        .insert(users)
        .values({ externalId: "user_shell", phone: WA, orgId: shellOrg.id })
        .returning();
      expect((await resolvePhone(WA)).body.userId).toBe(shell.id);

      await start();
      const res = await completeWa(lastCode(), WA);
      expect(res.status).toBe(200);
      expect(res.body.whatsappPhoneMovedFromUserId).toBe(shell.id);

      const resolved = await resolvePhone(WA);
      expect(resolved.body.userId).toBe(res.body.userId);
      expect(resolved.body.orgId).toBe(res.body.orgId);
      const [shellAfter] = await db.select().from(users).where(eq(users.id, shell.id));
      expect(shellAfter.phone).toBeNull();
      expect(shellAfter.orgId).toBe(shellOrg.id); // the old account itself is untouched
      expect(await db.select().from(users).where(eq(users.phone, WA))).toHaveLength(1);
    });

    it("binds an EXISTING email account (real customer) and moves the number off another user", async () => {
      const org = await insertTestOrg({ externalId: "org_existing", name: "Existing" });
      const user = await insertTestUser({ externalId: "user_existing", email: EMAIL, orgId: org.id });
      const otherOrg = await insertTestOrg({ externalId: "org_other", name: "Other" });
      const other = await insertTestUser({ externalId: "user_other", email: "other@example.com", orgId: otherOrg.id });
      await db.update(users).set({ phone: WA }).where(eq(users.id, other.id));
      clerk.getUserList.mockResolvedValue({ data: [{ id: "user_existing", privateMetadata: {} }], totalCount: 1 });

      await start();
      const res = await completeWa(lastCode(), WA);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ userId: user.id, orgId: org.id, created: false, whatsappPhoneMovedFromUserId: other.id });

      const resolved = await resolvePhone(WA);
      expect(resolved.body).toMatchObject({ userId: user.id, orgId: org.id });
    });

    it("repeating the call is a no-op success", async () => {
      await start();
      const code = lastCode();
      const first = await completeWa(code, WA);
      clerk.getUserList.mockResolvedValue({
        data: [{ id: "user_agent", privateMetadata: { signupSource: "agent_api" } }],
        totalCount: 1,
      });
      const second = await completeWa(code, WA);

      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ userId: first.body.userId, whatsappPhone: WA, whatsappPhoneMovedFromUserId: null });
      expect((await resolvePhone(WA)).body.userId).toBe(first.body.userId);
    });

    it("without whatsappPhone the completion is unchanged: no mapping key written, no new fields", async () => {
      await start();
      const res = await complete(lastCode());
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("whatsappPhone");
      expect(res.body).not.toHaveProperty("whatsappPhoneMovedFromUserId");
      const [user] = await db.select().from(users).where(eq(users.id, res.body.userId));
      expect(user.phone).toBeNull();
    });

    it("refuses a non-E.164 whatsappPhone with invalid_request, before any account work", async () => {
      await start();
      const res = await completeWa(lastCode(), "0770657585");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(clerk.createUser).not.toHaveBeenCalled();
    });
  });

  describe("an agent with no inbox access (approval link + poll token)", () => {
    const poll = (pollToken: string, email = EMAIL) =>
      request(app).post("/internal/agent-signups/complete").set("x-api-key", API_KEY).send({ email, pollToken });
    const approvalToken = () => new URL(JSON.parse(codeSends().at(-1)![1].body).metadata.approveUrl).searchParams.get("token")!;
    const openLink = (token: string) =>
      request(app).get("/internal/agent-signups/approve").query({ token }).set("x-api-key", API_KEY);
    const confirm = (token: string) =>
      request(app)
        .post(`/internal/agent-signups/approve?token=${encodeURIComponent(token)}`)
        .set("x-api-key", API_KEY)
        .type("form")
        .send({ token });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("finishes when the human confirms 2 hours later, long after the 15-minute code died", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const started = await start();
      const pollToken = started.body.pollToken as string;
      const code = lastCode();
      const token = approvalToken();

      const pending = await poll(pollToken);
      expect(pending.status).toBe(400);
      expect(pending.body.error).toBe("authorization_pending");

      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      expect((await complete(code)).body.error).toBe("code_expired");

      // Opening the link (a mail scanner's prefetch included) approves nothing.
      const page = await openLink(token);
      expect(page.status).toBe(200);
      expect(page.type).toBe("text/html");
      expect(page.text).toContain(EMAIL);
      expect(page.text).toContain('<form method="post">');
      expect((await poll(pollToken)).body.error).toBe("authorization_pending");

      const confirmed = await confirm(token);
      expect(confirmed.status).toBe(200);
      expect(confirmed.text).toContain("your agent can finish");

      const done = await poll(pollToken);
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ email: EMAIL, created: true, contactPhone: PHONE });
      expect(billingMarks()).toHaveLength(1);

      // Replayable until the approval window ends: same account.
      clerk.getUserList.mockResolvedValue({
        data: [{ id: "user_agent", privateMetadata: { signupSource: "agent_api" } }],
        totalCount: 1,
      });
      const again = await poll(pollToken);
      expect(again.body.orgId).toBe(done.body.orgId);
      expect(clerk.createUser).toHaveBeenCalledTimes(1);

      // Confirming again is idempotent.
      expect((await confirm(token)).status).toBe(200);
    });

    it("answers JSON to a JSON caller", async () => {
      await start();
      const token = approvalToken();
      const read = await openLink(token).set("accept", "application/json");
      expect(read.body).toMatchObject({ state: "ready", email: EMAIL });
      const done = await request(app).post("/internal/agent-signups/approve").set("x-api-key", API_KEY).send({ token });
      expect(done.body.state).toBe("approved");
    });

    it("a link not clicked within 24 hours is approval_expired, on both sides", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const started = await start();
      const token = approvalToken();
      vi.setSystemTime(Date.now() + 25 * 3_600_000);
      const page = await confirm(token);
      expect(page.text).toContain("expired");
      const res = await poll(started.body.pollToken);
      expect(res.status).toBe(410);
      expect(res.body.error).toBe("approval_expired");
      expect(clerk.createUser).not.toHaveBeenCalled();
    });

    it("a newer request kills the older link; a poll token never works for another email", async () => {
      const first = await start();
      const oldToken = approvalToken();
      await start();
      expect((await confirm(oldToken)).text).toContain("A newer email replaced this one");
      expect((await poll(first.body.pollToken)).body.error).toBe("no_pending_code");

      const latest = approvalToken();
      await confirm(latest);
      const other = await poll(first.body.pollToken, "someone@else.com");
      expect(other.status).toBe(404);
      expect(other.body.error).toBe("poll_token_unknown");
    });

    it("an unknown link shows a not-valid page; code and pollToken together are invalid_request", async () => {
      expect((await openLink("x".repeat(43))).text).toContain("This link is not valid");
      const started = await start();
      const both = await request(app)
        .post("/internal/agent-signups/complete")
        .set("x-api-key", API_KEY)
        .send({ email: EMAIL, code: lastCode(), pollToken: started.body.pollToken });
      expect(both.status).toBe(400);
      expect(both.body.error).toBe("invalid_request");
    });

    it("requires the service key", async () => {
      expect((await request(app).get("/internal/agent-signups/approve").query({ token: "x".repeat(43) })).status).toBe(401);
    });
  });

  describe("phone is optional and never a verified contact", () => {
    const startNoPhone = (email = EMAIL) =>
      request(app).post("/internal/agent-signups/start").set("x-api-key", API_KEY).send({ email });

    it("a signup with no phone succeeds with contactPhone null", async () => {
      const started = await startNoPhone();
      expect(started.status).toBe(200);
      const res = await complete(lastCode());
      expect(res.status).toBe(200);
      expect(res.body.contactPhone).toBeNull();
      const [user] = await db.select().from(users).where(eq(users.id, res.body.userId));
      expect(user.contactPhone).toBeNull();
      expect(user.phone).toBeNull();
      await settle();
      expect(telegramTexts().some((t) => t.includes("no phone"))).toBe(true);
    });

    it("a typed phone is stored as an unverified contact only, never as the channel identity", async () => {
      await start();
      const res = await complete(lastCode());
      const [user] = await db.select().from(users).where(eq(users.id, res.body.userId));
      expect(user.contactPhone).toBe(PHONE);
      expect(user.phone).toBeNull();
      const resolved = await request(app).get("/internal/phone-accounts").query({ phone: PHONE }).set("x-api-key", API_KEY);
      expect(resolved.status).toBe(404);
    });

    it("a later signup without a phone keeps the contact already on the account", async () => {
      await start();
      await complete(lastCode());
      clerk.getUserList.mockResolvedValue({
        data: [{ id: "user_agent", privateMetadata: { signupSource: "agent_api" } }],
        totalCount: 1,
      });
      await startNoPhone();
      const res = await complete(lastCode());
      expect(res.body.created).toBe(false);
      expect(res.body.contactPhone).toBe(PHONE);
    });
  });
});

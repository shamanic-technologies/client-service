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
import { cleanTestData, closeDb, insertTestOrg, insertTestUser, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { agentSignupCodes, orgAcquisitions, orgs, users } from "../../src/db/schema.js";
import { recordFirstTouch } from "../../src/lib/acquisition.js";

const API_KEY = "test_api_key";
const EMAIL = "founder@acme.io";
const PHONE = "+33612345678";

/**
 * DISTRY-ONE-AI-1118. The person built their plan IN the conversation, on an
 * unclaimed org (the one the signup page opens). Proving their email hands them
 * THAT org: same internal uuid, same brand, same first touch, the signup page's
 * billing offer. Never a second, empty org on the agent offer.
 */
describe("POST /internal/agent-signups/complete with claimOrgId", () => {
  const app = createTestApp();
  const fetchMock = vi.fn();
  let brands: Array<{ id: string; orgId: string; domain: string | null; name: string }> = [];
  let brandServiceDown = false;
  let settleFails = false;

  const callsTo = (fragment: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));
  const lastCode = (): string => JSON.parse(callsTo("/platform-orgless-send").at(-1)![1].body).metadata.code;
  const agentMarks = () => callsTo("/agent-api-signup");
  const settles = () => callsTo("/signup").filter(([url]) => !String(url).includes("agent-api-signup"));

  const start = (email = EMAIL, phone = PHONE) =>
    request(app).post("/internal/agent-signups/start").set("x-api-key", API_KEY).send({ email, phone });
  const startNoPhone = () =>
    request(app).post("/internal/agent-signups/start").set("x-api-key", API_KEY).send({ email: EMAIL });
  const telegramTexts = () => callsTo("api.telegram.org").map(([, opts]) => JSON.parse(opts.body).text as string);
  /** Fire-and-forget notifications settle on the next ticks. */
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const complete = (body: Record<string, unknown>) =>
    request(app).post("/internal/agent-signups/complete").set("x-api-key", API_KEY).send({ email: EMAIL, ...body });

  const anonymousOrg = (name = "Anonymous visitor") =>
    insertTestOrg({ externalId: `anon-${randomId()}`, anonymousAt: new Date(), name });

  /** From now on Clerk knows the email (what a real Clerk answers after a creation). */
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
    clerk.createOrganization.mockResolvedValue({ id: "org_claimed", slug: "acme" });
    brands = [];
    brandServiceDown = false;
    settleFails = false;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("key.test")) {
        return { ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) };
      }
      if (u.includes("/internal/brands/all")) {
        if (brandServiceDown) return { ok: false, status: 503, text: async () => "brand-service down" };
        return { ok: true, status: 200, json: async () => ({ brands }) };
      }
      if (u.includes("/internal/payment_summary/by-org/")) {
        return { ok: true, status: 200, json: async () => ({ totals: [] }) };
      }
      if (u.endsWith("/signup") && settleFails) {
        return { ok: false, status: 503, text: async () => "billing down" };
      }
      return { ok: true, status: 200, text: async () => "{}", json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    process.env.BILLING_SERVICE_URL = "https://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing_key";
    process.env.BRAND_SERVICE_URL = "https://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "brand_key";
    process.env.STRIPE_SERVICE_URL = "https://stripe.test";
    process.env.STRIPE_SERVICE_API_KEY = "stripe_key";
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

  describe("a new email", () => {
    it("hands over the NAMED org: same uuid, brand's name, first touch kept, the signup page's billing, never the agent marker", async () => {
      const org = await anonymousOrg();
      await recordFirstTouch(db, org.id, { channel: "google_ads", utmSource: "google" }, "resolve");
      brands = [{ id: randomId(), orgId: org.id, domain: "acme.io", name: "Acme" }];

      await start();
      const res = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        orgId: org.id,
        email: EMAIL,
        contactPhone: PHONE,
        clerkOrgId: "org_claimed",
        clerkUserId: "user_new",
        created: true,
        claimedOrgId: org.id,
        orgClaim: "claimed",
        billingSettled: true,
      });

      // One org: the unclaimed one, now carrying the identity. Nothing else was opened.
      const allOrgs = await db.select().from(orgs);
      expect(allOrgs).toHaveLength(1);
      expect(allOrgs[0]).toMatchObject({ id: org.id, externalId: "org_claimed", name: "Acme", slug: "acme" });
      expect(allOrgs[0].anonymousAt).not.toBeNull();
      expect(allOrgs[0].claimedAt).not.toBeNull();

      // A real identity-provider user carrying the email (dashboard sign-in by
      // email code), NOT marked agent-born: that marker is what a later
      // completion keys the agent billing offer on.
      expect(clerk.createUser).toHaveBeenCalledWith({
        emailAddress: [EMAIL],
        skipPasswordRequirement: true,
        privateMetadata: { signupSource: "agent_signup_claim" },
      });
      // Named after the brand they built, administered by them, and marked with
      // the org it was made for (what lets a retry reuse it).
      expect(clerk.createOrganization).toHaveBeenCalledWith({
        name: "Acme",
        createdBy: "user_new",
        privateMetadata: { claimOfOrgId: org.id },
      });

      const [user] = await db.select().from(users).where(eq(users.id, res.body.userId));
      expect(user).toMatchObject({ externalId: "user_new", email: EMAIL, contactPhone: PHONE, orgId: org.id });
      expect(user.phone).toBeNull(); // the unverified start phone is never the channel key

      // The first touch recorded while it was unclaimed stands.
      const touches = await db.select().from(orgAcquisitions);
      expect(touches).toHaveLength(1);
      expect(touches[0]).toMatchObject({ orgId: org.id, channel: "google_ads", recordedVia: "resolve" });

      // Billing: the signup page's settle, told WHO signed up. Never the agent marker.
      expect(agentMarks()).toHaveLength(0);
      expect(settles()).toHaveLength(1);
      const [settleUrl, settleOpts] = settles()[0];
      expect(settleUrl).toBe(`https://billing.test/internal/accounts/by-org/${org.id}/signup`);
      expect(settleOpts.method).toBe("POST");
      expect(settleOpts.headers["x-api-key"]).toBe("billing_key");
      expect(settleOpts.headers["x-user-id"]).toBe(res.body.userId);
      expect(callsTo("/v1/accounts")).toHaveLength(0);

      // Staff told once, as for any signup: the email and the owner's Telegram line.
      await settle();
      const staff = callsTo("/platform-send");
      expect(staff).toHaveLength(1);
      expect(staff[0][1].headers["x-org-id"]).toBe(org.id);
      expect(JSON.parse(staff[0][1].body)).toMatchObject({
        eventType: "signup_notification",
        metadata: { email: EMAIL, source: "agent_signup_claim" },
      });
      expect(telegramTexts().some((t) => t.includes(EMAIL) && t.includes("Acme"))).toBe(true);
    });

    it("an org with no brand is named from the email, and never gets an agent first touch", async () => {
      const org = await anonymousOrg();
      await start();
      const res = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });

      expect(res.status).toBe(200);
      expect(clerk.createOrganization).toHaveBeenCalledWith({
        name: "acme.io",
        createdBy: "user_new",
        privateMetadata: { claimOfOrgId: org.id },
      });
      const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
      expect(row.name).toBe("acme.io");
      // No touch was recorded before: none is invented (an `agent_api` touch
      // would put the org on the agent billing offer at the next completion).
      expect(await db.select().from(orgAcquisitions)).toHaveLength(0);
    });

    it("naming is never worth a signup: brand-service down still hands the org over, named from the email", async () => {
      const org = await anonymousOrg();
      brandServiceDown = true;
      await start();
      const res = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });

      expect(res.status).toBe(200);
      expect(res.body.orgId).toBe(org.id);
      const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
      expect(row.name).toBe("acme.io");
    });

    it("proves the email by poll token just the same", async () => {
      const org = await anonymousOrg();
      const started = await start();
      const token = new URL(
        JSON.parse(callsTo("/platform-orgless-send").at(-1)![1].body).metadata.approveUrl,
      ).searchParams.get("token")!;
      await request(app).post("/internal/agent-signups/approve").set("x-api-key", API_KEY).send({ token });

      const res = await complete({ pollToken: started.body.pollToken, claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ orgId: org.id, created: true, orgClaim: "claimed" });
    });

    it("binds a channel-verified WhatsApp number to the claimed org as today", async () => {
      const org = await anonymousOrg();
      const WA = "+33770657585";
      await start();
      const res = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId, whatsappPhone: WA });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ orgId: org.id, whatsappPhone: WA, whatsappPhoneMovedFromUserId: null });
      const resolved = await request(app).get("/internal/phone-accounts").query({ phone: WA }).set("x-api-key", API_KEY);
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ userId: res.body.userId, orgId: org.id });
    });
  });

  describe("an email that already has an account (returning)", () => {
    it("the unclaimed org becomes a NEW organization of that user; the org they already use is untouched", async () => {
      const previous = await insertTestOrg({ externalId: "org_previous", name: "Previous Co", slug: "previous-co" });
      const human = await insertTestUser({ externalId: "user_human", email: EMAIL, orgId: previous.id });
      await recordFirstTouch(db, previous.id, { channel: "linkedin" }, "resolve");
      clerkKnows("user_human", undefined, [{ id: "org_previous", name: "Previous Co" }]);
      const org = await anonymousOrg();
      brands = [{ id: randomId(), orgId: org.id, domain: "acme.io", name: "Acme" }];

      await start();
      const res = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        orgId: org.id,
        userId: human.id,
        clerkOrgId: "org_claimed",
        clerkUserId: "user_human",
        created: false,
        claimedOrgId: org.id,
        orgClaim: "claimed",
      });

      // A new identity-provider organization of the SAME user, never a new user.
      expect(clerk.createUser).not.toHaveBeenCalled();
      expect(clerk.createOrganization).toHaveBeenCalledTimes(1);
      expect(clerk.createOrganization).toHaveBeenCalledWith({
        name: "Acme",
        createdBy: "user_human",
        privateMetadata: { claimOfOrgId: org.id },
      });

      // Never merged: the org they already use keeps its identity, name and touch.
      const [before] = await db.select().from(orgs).where(eq(orgs.id, previous.id));
      expect(before).toMatchObject({ externalId: "org_previous", name: "Previous Co", slug: "previous-co" });
      expect(before.absorbedAt).toBeNull();
      expect(await db.select().from(orgs)).toHaveLength(2);
      const [touch] = await db.select().from(orgAcquisitions).where(eq(orgAcquisitions.orgId, previous.id));
      expect(touch.channel).toBe("linkedin");

      const [claimed] = await db.select().from(orgs).where(eq(orgs.id, org.id));
      expect(claimed.externalId).toBe("org_claimed");
      expect(claimed.claimedAt).not.toBeNull();

      expect(agentMarks()).toHaveLength(0);
      expect(settles()).toHaveLength(1);
      expect(settles()[0][0]).toBe(`https://billing.test/internal/accounts/by-org/${org.id}/signup`);
    });

    it("an AGENT-born user's claimed org never goes through the agent marker, now or on a later plain completion", async () => {
      const agentOrg = await insertTestOrg({ externalId: "org_agentborn", name: "acme.io" });
      const agent = await insertTestUser({ externalId: "user_agentborn", email: EMAIL, orgId: agentOrg.id });
      await recordFirstTouch(db, agentOrg.id, { channel: "agent_api" }, "agent_signup");
      clerkKnows("user_agentborn", "agent_api", [{ id: "org_agentborn", name: "acme.io" }]);
      const org = await anonymousOrg();

      await start();
      const claimed = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(claimed.status).toBe(200);
      expect(claimed.body).toMatchObject({ orgId: org.id, userId: agent.id, created: false });
      expect(agentMarks()).toHaveLength(0);

      // Later, the same person signs in by code with NO org named (the gateway,
      // the MCP, WhatsApp sign-in): the account answers with the org they now
      // use, and that org, born on the signup page's path, is never re-labelled.
      await start();
      const plain = await complete({ code: lastCode() });
      expect(plain.status).toBe(200);
      expect(plain.body).toMatchObject({ orgId: org.id, userId: agent.id, created: false });
      expect(plain.body).not.toHaveProperty("claimedOrgId");
      expect(agentMarks()).toHaveLength(0);
      expect(await db.select().from(orgAcquisitions).where(eq(orgAcquisitions.orgId, org.id))).toHaveLength(0);
    });
  });

  describe("idempotent", () => {
    it("the same proof redeemed twice answers the same account and org, with nothing made twice", async () => {
      const org = await anonymousOrg();
      await start();
      const code = lastCode();
      const first = await complete({ code, claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(first.body).toMatchObject({ created: true, orgClaim: "claimed" });

      clerkKnows("user_new", "agent_signup_claim", [{ id: "org_claimed", name: "acme.io", privateMetadata: { claimOfOrgId: org.id } }]);

      const again = await complete({ code, claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({
        orgId: org.id,
        userId: first.body.userId,
        clerkOrgId: "org_claimed",
        clerkUserId: "user_new",
        contactPhone: PHONE,
        created: false,
        claimedOrgId: org.id,
        orgClaim: "already_claimed",
      });

      // A later, new code for the same person and org: still the same answer.
      await startNoPhone();
      const later = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(later.body).toMatchObject({ orgId: org.id, userId: first.body.userId, orgClaim: "already_claimed", contactPhone: PHONE });

      expect(clerk.createUser).toHaveBeenCalledTimes(1);
      expect(clerk.createOrganization).toHaveBeenCalledTimes(1);
      expect(await db.select().from(orgs)).toHaveLength(1);
      expect(await db.select().from(users)).toHaveLength(1);
      expect(agentMarks()).toHaveLength(0);
    });

    it("a retry after a provision that stopped between Clerk and our rows reuses the Clerk org made for this claim", async () => {
      const org = await anonymousOrg();
      // Clerk already holds the user and the org a first attempt created; our org is still unclaimed.
      clerkKnows("user_new", "agent_signup_claim", [
        { id: "org_other", name: "Other", privateMetadata: {} },
        { id: "org_half", name: "acme.io", slug: "acme-half", privateMetadata: { claimOfOrgId: org.id } },
      ]);

      await start();
      const res = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ orgId: org.id, clerkOrgId: "org_half", clerkUserId: "user_new", created: false, orgClaim: "claimed" });
      expect(clerk.createUser).not.toHaveBeenCalled();
      expect(clerk.createOrganization).not.toHaveBeenCalled();
      const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
      expect(row).toMatchObject({ externalId: "org_half", slug: "acme-half" });
    });
  });

  describe("refusals are named, and leave nothing behind", () => {
    const nothingMade = () => {
      expect(clerk.createUser).not.toHaveBeenCalled();
      expect(clerk.createOrganization).not.toHaveBeenCalled();
      expect(agentMarks()).toHaveLength(0);
      expect(settles()).toHaveLength(0);
    };

    it("404 org_not_found: no such org, and no fresh org is opened instead", async () => {
      await start();
      const res = await complete({ code: lastCode(), claimOrgId: randomId(), claimOrgExternalId: "anon_unknown" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("org_not_found");
      expect(typeof res.body.message).toBe("string");
      nothingMade();
      expect(await db.select().from(orgs)).toHaveLength(0);
    });

    it("409 org_not_anonymous: an ordinary org can never be taken this way", async () => {
      const ordinary = await insertTestOrg({ externalId: "org_somebody", name: "Somebody Inc" });
      await start();
      const res = await complete({ code: lastCode(), claimOrgId: ordinary.id, claimOrgExternalId: "org_somebody" });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("org_not_anonymous");
      nothingMade();
      const [row] = await db.select().from(orgs).where(eq(orgs.id, ordinary.id));
      expect(row.externalId).toBe("org_somebody");
    });

    it("409 org_already_claimed: it belongs to someone else, for a new email and for a returning one", async () => {
      const taken = await insertTestOrg({
        externalId: "org_someone_else",
        anonymousAt: new Date(),
        claimedAt: new Date(),
        name: "Theirs",
      });

      await start();
      const fresh = await complete({ code: lastCode(), claimOrgId: taken.id, claimOrgExternalId: "anon_was" });
      expect(fresh.status).toBe(409);
      expect(fresh.body.error).toBe("org_already_claimed");

      const own = await insertTestOrg({ externalId: "org_mine", name: "Mine" });
      await insertTestUser({ externalId: "user_human", email: EMAIL, orgId: own.id });
      clerkKnows("user_human", undefined, [{ id: "org_mine", name: "Mine" }]);
      await start();
      const returning = await complete({ code: lastCode(), claimOrgId: taken.id, claimOrgExternalId: "anon_was" });
      expect(returning.status).toBe(409);
      expect(returning.body.error).toBe("org_already_claimed");

      nothingMade();
      const [row] = await db.select().from(orgs).where(eq(orgs.id, taken.id));
      expect(row.externalId).toBe("org_someone_else");
    });

    it("403 org_external_id_mismatch: knowing an unclaimed org's uuid is not enough, only its opener can hand it over", async () => {
      const org = await anonymousOrg();
      await start();
      const code = lastCode();

      const guessed = await complete({ code, claimOrgId: org.id, claimOrgExternalId: "anon_guess" });
      expect(guessed.status).toBe(403);
      expect(guessed.body.error).toBe("org_external_id_mismatch");
      nothingMade();
      const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
      expect(row.claimedAt).toBeNull();
      expect(row.externalId).toBe(org.externalId);

      // The two fields travel together: either one alone is a malformed request.
      const uuidOnly = await complete({ code, claimOrgId: org.id });
      expect(uuidOnly.status).toBe(400);
      expect(uuidOnly.body.error).toBe("invalid_request");
      const externalOnly = await complete({ code, claimOrgExternalId: org.externalId });
      expect(externalOnly.status).toBe(400);
      expect(externalOnly.body.error).toBe("invalid_request");
      nothingMade();
    });

    it("400 invalid_request: claimOrgId is not a uuid, before any account work", async () => {
      await start();
      const res = await complete({ code: lastCode(), claimOrgId: "org_2abc", claimOrgExternalId: "anon_x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      nothingMade();
    });

    it("a refusal does not burn the proof: the same code then claims a valid org", async () => {
      const org = await anonymousOrg();
      await start();
      const code = lastCode();
      expect((await complete({ code, claimOrgId: randomId(), claimOrgExternalId: "anon_unknown" })).status).toBe(404);
      const ok = await complete({ code, claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(ok.status).toBe(200);
      expect(ok.body.orgId).toBe(org.id);
      const [row] = await db.select().from(agentSignupCodes);
      expect(row.consumedAt).not.toBeNull();
    });

    it("409 org_slug_taken: the identity made for the claim is removed, the org stays unclaimed", async () => {
      await insertTestOrg({ externalId: "org_holder", name: "Acme", slug: "acme" });
      const org = await anonymousOrg();
      await start();
      const res = await complete({ code: lastCode(), claimOrgId: org.id, claimOrgExternalId: org.externalId });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("org_slug_taken");
      expect(clerk.deleteOrganization).toHaveBeenCalledWith("org_claimed");
      expect(clerk.deleteUser).toHaveBeenCalledWith("user_new");
      const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
      expect(row.claimedAt).toBeNull();
      expect(await db.select().from(users)).toHaveLength(0);
      expect(settles()).toHaveLength(0);
    });

    it("502 identity_provider_failed: Clerk refuses the org, the user made for it is removed, and a retry succeeds", async () => {
      const org = await anonymousOrg();
      clerk.createOrganization.mockRejectedValueOnce({ status: 422, errors: [{ code: "form_param_invalid" }] });
      await start();
      const code = lastCode();

      const failed = await complete({ code, claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(failed.status).toBe(502);
      expect(failed.body.error).toBe("identity_provider_failed");
      expect(clerk.deleteUser).toHaveBeenCalledWith("user_new");
      const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
      expect(row.claimedAt).toBeNull();

      const retried = await complete({ code, claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ orgId: org.id, created: true });
    });
  });

  describe("billing settle (the signup page's own call)", () => {
    it("a failed settle never costs the handover: 200 with billingSettled false, and the replay settles", async () => {
      const org = await anonymousOrg();
      settleFails = true;
      await start();
      const code = lastCode();

      const first = await complete({ code, claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ orgId: org.id, orgClaim: "claimed", billingSettled: false });

      settleFails = false;
      clerkKnows("user_new", "agent_signup_claim", [{ id: "org_claimed", name: "acme.io" }]);
      const replay = await complete({ code, claimOrgId: org.id, claimOrgExternalId: org.externalId });
      expect(replay.body).toMatchObject({ orgId: org.id, orgClaim: "already_claimed", billingSettled: true });
      expect(settles()).toHaveLength(2);
      expect(agentMarks()).toHaveLength(0);
    });
  });

  describe("no claimOrgId", () => {
    it("is today's completion: its own org, the agent marker, no settle, none of the claim fields", async () => {
      const untouched = await anonymousOrg();
      clerk.createOrganization.mockResolvedValue({ id: "org_agent", slug: "acme-io" });
      await start();
      const res = await complete({ code: lastCode() });

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(
        ["clerkOrgId", "clerkUserId", "contactPhone", "created", "email", "orgId", "userId"].sort(),
      );
      expect(res.body.orgId).not.toBe(untouched.id);
      expect(clerk.createUser).toHaveBeenCalledWith({
        emailAddress: [EMAIL],
        skipPasswordRequirement: true,
        privateMetadata: { signupSource: "agent_api" },
      });
      expect(clerk.createOrganization).toHaveBeenCalledWith({ name: "acme.io", createdBy: "user_new" });
      expect(agentMarks()).toHaveLength(1);
      expect(settles()).toHaveLength(0);
      const [row] = await db.select().from(orgs).where(eq(orgs.id, untouched.id));
      expect(row.claimedAt).toBeNull();
    });
  });
});

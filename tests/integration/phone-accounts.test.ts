import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// Mock the Clerk SDK — no real network/secret. Each provision creates a fresh
// user+org id pair so idempotency can be asserted by call counts.
const { createUserMock, createOrgMock, deleteUserMock, deleteOrgMock } = vi.hoisted(() => ({
  createUserMock: vi.fn(),
  createOrgMock: vi.fn(),
  deleteUserMock: vi.fn(),
  deleteOrgMock: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    users: { createUser: createUserMock, deleteUser: deleteUserMock },
    organizations: { createOrganization: createOrgMock, deleteOrganization: deleteOrgMock },
  }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { users, orgs } from "../../src/db/schema.js";

const API_KEY = "test_api_key";
const PHONE = "+15551230000";

describe("phone-accounts routes", () => {
  const app = createTestApp();
  const fetchMock = vi.fn();

  /** The Clerk secret now comes from key-service, so a provision makes two outbound
   *  calls (key-service, then billing). Assert on the billing ones specifically. */
  const billingCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes("billing.test"));

  /** Route the stub by URL: key-service serves the platform key, billing succeeds. */
  const upstreamsOk = (billing: { ok: boolean; status?: number; body?: string } = { ok: true }) =>
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("key.test")) {
        return { ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test_clerk" }) };
      }
      return {
        ok: billing.ok,
        status: billing.status ?? 200,
        text: async () => billing.body ?? "{}",
      };
    });

  beforeEach(async () => {
    await cleanTestData();
    createUserMock.mockReset();
    createOrgMock.mockReset();
    deleteUserMock.mockReset();
    deleteOrgMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    process.env.BILLING_SERVICE_URL = "https://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing_key";
    upstreamsOk();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  describe("POST /internal/phone-accounts", () => {
    it("provisions a full account for a brand-new phone (Clerk + billing welcome)", async () => {
      createUserMock.mockResolvedValueOnce({ id: "user_new" });
      createOrgMock.mockResolvedValueOnce({ id: "org_new" });

      const res = await request(app)
        .post("/internal/phone-accounts")
        .set("x-api-key", API_KEY)
        .send({ phone: PHONE });

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(true);
      expect(res.body.phone).toBe(PHONE);
      expect(res.body.clerkOrgId).toBe("org_new");
      expect(res.body.clerkUserId).toBe("user_new");
      expect(res.body.orgId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.userId).toMatch(/^[0-9a-f-]{36}$/);

      // Clerk identity created once, keyed on a synthetic email (NOT the phone).
      expect(createUserMock).toHaveBeenCalledWith({
        emailAddress: ["wa-15551230000@phone.distribute.you"],
        skipPasswordRequirement: true,
      });
      expect(createUserMock.mock.calls[0][0]).not.toHaveProperty("phoneNumber");
      expect(createOrgMock).toHaveBeenCalledTimes(1);

      // Billing welcome triggered with the internal org+user UUIDs.
      expect(billingCalls()).toHaveLength(1);
      const [url, opts] = billingCalls()[0];
      expect(url).toBe("https://billing.test/v1/accounts");
      expect(opts.headers["x-org-id"]).toBe(res.body.orgId);
      expect(opts.headers["x-user-id"]).toBe(res.body.userId);

      // Rows persisted with the phone + Clerk mapping.
      const [row] = await db.select().from(users).where(eq(users.phone, PHONE));
      expect(row.externalId).toBe("user_new");
      expect(row.orgId).toBe(res.body.orgId);
    });

    it("provisions a +33 France phone end-to-end (phone identifier is Clerk-unsupported)", async () => {
      const FR_PHONE = "+33612345678";
      createUserMock.mockResolvedValueOnce({ id: "user_fr" });
      createOrgMock.mockResolvedValueOnce({ id: "org_fr" });

      const res = await request(app)
        .post("/internal/phone-accounts")
        .set("x-api-key", API_KEY)
        .send({ phone: FR_PHONE });

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(true);
      expect(res.body.phone).toBe(FR_PHONE);
      expect(res.body.clerkUserId).toBe("user_fr");
      expect(res.body.clerkOrgId).toBe("org_fr");

      // Keyed on a synthetic email, never the France phone.
      expect(createUserMock).toHaveBeenCalledWith({
        emailAddress: ["wa-33612345678@phone.distribute.you"],
        skipPasswordRequirement: true,
      });
      // Billing welcome granted, resolvable afterward via the stored phone.
      expect(billingCalls()).toHaveLength(1);
      const [row] = await db.select().from(users).where(eq(users.phone, FR_PHONE));
      expect(row.externalId).toBe("user_fr");
    });

    it("is idempotent per phone — repeat returns existing, no new Clerk/billing calls", async () => {
      createUserMock.mockResolvedValueOnce({ id: "user_i" });
      createOrgMock.mockResolvedValueOnce({ id: "org_i" });

      const first = await request(app)
        .post("/internal/phone-accounts")
        .set("x-api-key", API_KEY)
        .send({ phone: PHONE });
      expect(first.body.created).toBe(true);

      const second = await request(app)
        .post("/internal/phone-accounts")
        .set("x-api-key", API_KEY)
        .send({ phone: PHONE });

      expect(second.status).toBe(200);
      expect(second.body.created).toBe(false);
      expect(second.body.orgId).toBe(first.body.orgId);
      expect(second.body.userId).toBe(first.body.userId);
      expect(second.body.clerkOrgId).toBe("org_i");
      expect(second.body.clerkUserId).toBe("user_i");

      // No duplicate account: Clerk create + billing each fired exactly once.
      expect(createUserMock).toHaveBeenCalledTimes(1);
      expect(createOrgMock).toHaveBeenCalledTimes(1);
      expect(billingCalls()).toHaveLength(1);

      const rows = await db.select().from(users).where(eq(users.phone, PHONE));
      expect(rows).toHaveLength(1);
    });

    it("rejects a non-E.164 phone with 400 (no Clerk calls)", async () => {
      const res = await request(app)
        .post("/internal/phone-accounts")
        .set("x-api-key", API_KEY)
        .send({ phone: "555-1234" });

      expect(res.status).toBe(400);
      expect(createUserMock).not.toHaveBeenCalled();
    });

    it("fails loud (502) and creates no local rows when billing welcome fails", async () => {
      createUserMock.mockResolvedValueOnce({ id: "user_bf" });
      createOrgMock.mockResolvedValueOnce({ id: "org_bf" });
      upstreamsOk({ ok: false, status: 500, body: "billing down" });

      const res = await request(app)
        .post("/internal/phone-accounts")
        .set("x-api-key", API_KEY)
        .send({ phone: "+15559990000" });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("billing-service welcome failed");
    });

    it("requires the service api-key", async () => {
      const res = await request(app).post("/internal/phone-accounts").send({ phone: PHONE });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /internal/phone-accounts", () => {
    it("resolves a known phone to its identity", async () => {
      createUserMock.mockResolvedValueOnce({ id: "user_r" });
      createOrgMock.mockResolvedValueOnce({ id: "org_r" });
      const provisioned = await request(app)
        .post("/internal/phone-accounts")
        .set("x-api-key", API_KEY)
        .send({ phone: PHONE });

      const res = await request(app)
        .get("/internal/phone-accounts")
        .query({ phone: PHONE })
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(false);
      expect(res.body.orgId).toBe(provisioned.body.orgId);
      expect(res.body.userId).toBe(provisioned.body.userId);
      expect(res.body.clerkOrgId).toBe("org_r");
    });

    it("404s for an unknown phone and never creates", async () => {
      const res = await request(app)
        .get("/internal/phone-accounts")
        .query({ phone: "+15550000001" })
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(404);
      expect(createUserMock).not.toHaveBeenCalled();

      const rows = await db.select().from(orgs);
      expect(rows).toHaveLength(0);
    });

    it("400s on a non-E.164 phone", async () => {
      const res = await request(app)
        .get("/internal/phone-accounts")
        .query({ phone: "abc" })
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
    });

    it("requires the service api-key", async () => {
      const res = await request(app).get("/internal/phone-accounts").query({ phone: PHONE });
      expect(res.status).toBe(401);
    });
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { invites } from "../../src/db/schema.js";
import { notifyReferralClaim } from "../../src/lib/billing-service-client.js";

vi.mock("../../src/lib/billing-service-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/billing-service-client.js")>();
  return { ...actual, notifyReferralClaim: vi.fn() };
});

const API_KEY = "test_api_key";

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /public/invites/validate", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  it("should return valid:false for unknown slug", async () => {
    const res = await request(app)
      .post("/public/invites/validate")
      .set("x-api-key", API_KEY)
      .send({ code: "ghost-org" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it("should return valid:true with inviterOrgName for a known slug with no signups yet", async () => {
    await insertTestOrg({ externalId: "org-stripe", name: "Stripe", slug: "stripe" });

    const res = await request(app)
      .post("/public/invites/validate")
      .set("x-api-key", API_KEY)
      .send({ code: "stripe" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, inviterOrgName: "Stripe" });
  });

  it.each([3, 10, 50])(
    "should stay valid for an inviter that already brought in %i signups (no cap)",
    async (signups) => {
      const slug = `bulk-${signups}`;
      const inviter = await insertTestOrg({ externalId: `org-${slug}`, name: "Bulk", slug });
      const invitees = await Promise.all(
        Array.from({ length: signups }, (_, i) =>
          insertTestOrg({ externalId: `org-${slug}-i${i}` }),
        ),
      );
      await db.insert(invites).values(
        invitees.map((invitee) => ({
          inviterOrgId: inviter.id,
          inviteeOrgId: invitee.id,
          code: slug,
          status: "signed_up" as const,
          signedUpAt: new Date(),
        })),
      );

      const res = await request(app)
        .post("/public/invites/validate")
        .set("x-api-key", API_KEY)
        .send({ code: slug });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true, inviterOrgName: "Bulk" });
    },
  );

  it("should return 400 for missing code", async () => {
    const res = await request(app)
      .post("/public/invites/validate")
      .set("x-api-key", API_KEY)
      .send({});

    expect(res.status).toBe(400);
  });

  it("should return 401 without API key", async () => {
    const res = await request(app)
      .post("/public/invites/validate")
      .send({ code: "stripe" });

    expect(res.status).toBe(401);
  });

  it("should omit inviterOrgName when org name is NULL", async () => {
    await insertTestOrg({ externalId: "org-noname", slug: "noname-slug" });

    const res = await request(app)
      .post("/public/invites/validate")
      .set("x-api-key", API_KEY)
      .send({ code: "noname-slug" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });
});

describe("POST /internal/invites/claim", () => {
  const app = createTestApp();
  const notifyMock = vi.mocked(notifyReferralClaim);

  beforeEach(async () => {
    await cleanTestData();
    notifyMock.mockReset().mockResolvedValue(undefined);
  });

  it("should claim invite (happy path) and notify billing with both org identities", async () => {
    const inviter = await insertTestOrg({ externalId: "org-claim-inv", slug: "claim-test" });
    const invitee = await insertTestOrg({ externalId: "org-claim-i1" });

    const res = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "claim-test", inviteeOrgId: invitee.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inviterOrgId: inviter.id });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      inviterOrgId: inviter.id,
      inviteeOrgId: invitee.id,
    });

    const rows = await db
      .select()
      .from(invites)
      .where(and(eq(invites.inviterOrgId, inviter.id), eq(invites.inviteeOrgId, invitee.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("signed_up");
    expect(rows[0].signedUpAt).not.toBeNull();
    expect(rows[0].code).toBe("claim-test");
    expect(rows[0].billingNotifiedAt).not.toBeNull();
  });

  it("should return 404 for unknown code", async () => {
    const invitee = await insertTestOrg({ externalId: "org-claim-unknown-i" });

    const res = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "does-not-exist", inviteeOrgId: invitee.id });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unknown invite code");
  });

  it("should return 404 for unknown invitee org", async () => {
    await insertTestOrg({ externalId: "org-claim-i-unknown", slug: "i-unknown" });

    const res = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "i-unknown", inviteeOrgId: randomId() });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unknown invitee org");
  });

  it("should be idempotent on (inviter, invitee) re-claim", async () => {
    const inviter = await insertTestOrg({ externalId: "org-idem", slug: "idem" });
    const invitee = await insertTestOrg({ externalId: "org-idem-i" });

    const first = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "idem", inviteeOrgId: invitee.id });
    expect(first.status).toBe(200);

    const firstSignedUpAt = (
      await db.select({ signedUpAt: invites.signedUpAt }).from(invites).where(eq(invites.inviteeOrgId, invitee.id))
    )[0].signedUpAt;

    const second = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "idem", inviteeOrgId: invitee.id });
    expect(second.status).toBe(200);

    const rows = await db.select().from(invites).where(eq(invites.inviteeOrgId, invitee.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("signed_up");
    expect(rows[0].signedUpAt?.getTime()).toBe(firstSignedUpAt?.getTime());
  });

  it("should NOT notify billing a second time when the same pair is re-claimed", async () => {
    await insertTestOrg({ externalId: "org-notify-once", slug: "notify-once" });
    const invitee = await insertTestOrg({ externalId: "org-notify-once-i" });

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/internal/invites/claim")
        .set("x-api-key", API_KEY)
        .send({ code: "notify-once", inviteeOrgId: invitee.id });
      expect(res.status).toBe(200);
    }

    expect(notifyMock).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(invites).where(eq(invites.inviteeOrgId, invitee.id));
    const notifiedAt = row.billingNotifiedAt;
    expect(notifiedAt).not.toBeNull();

    // The marker is written once and never refreshed.
    const [again] = await db.select().from(invites).where(eq(invites.inviteeOrgId, invitee.id));
    expect(again.billingNotifiedAt?.getTime()).toBe(notifiedAt?.getTime());
  });

  it("should 502 (never a quiet 200) when billing-service cannot be notified", async () => {
    await insertTestOrg({ externalId: "org-billfail", slug: "billfail" });
    const invitee = await insertTestOrg({ externalId: "org-billfail-i" });
    notifyMock.mockRejectedValueOnce(new Error("billing-service call failed (503): down"));

    const res = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "billfail", inviteeOrgId: invitee.id });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Invite recorded but billing-service could not be notified");

    const [row] = await db.select().from(invites).where(eq(invites.inviteeOrgId, invitee.id));
    expect(row.status).toBe("signed_up");
    expect(row.billingNotifiedAt).toBeNull();
  });

  it("should retry the billing notification on the next claim after a failure", async () => {
    await insertTestOrg({ externalId: "org-billretry", slug: "billretry" });
    const invitee = await insertTestOrg({ externalId: "org-billretry-i" });
    notifyMock.mockRejectedValueOnce(new Error("billing down"));

    const failed = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "billretry", inviteeOrgId: invitee.id });
    expect(failed.status).toBe(502);

    const retried = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "billretry", inviteeOrgId: invitee.id });
    expect(retried.status).toBe(200);

    expect(notifyMock).toHaveBeenCalledTimes(2);

    const rows = await db.select().from(invites).where(eq(invites.inviteeOrgId, invitee.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].billingNotifiedAt).not.toBeNull();
  });

  // Each claim is a real round-trip, so this walks the count rather than jumping
  // to 50 — the 50-signup case is covered by validate + status, which is where
  // the cap used to be read from. What matters here is that nothing rejects past
  // the old ceiling of 3.
  it.each([3, 10])(
    "should accept signup number %i for the same inviter (no cap)",
    { timeout: 60_000 },
    async (signups) => {
      const slug = `claim-bulk-${signups}`;
      const inviter = await insertTestOrg({ externalId: `org-${slug}`, slug });
      const invitees = await Promise.all(
        Array.from({ length: signups }, (_, i) =>
          insertTestOrg({ externalId: `org-${slug}-i${i}` }),
        ),
      );

      for (const invitee of invitees) {
        const res = await request(app)
          .post("/internal/invites/claim")
          .set("x-api-key", API_KEY)
          .send({ code: slug, inviteeOrgId: invitee.id });
        expect(res.status).toBe(200);
      }

      const rows = await db.select().from(invites).where(eq(invites.inviterOrgId, inviter.id));
      expect(rows).toHaveLength(signups);
      expect(notifyMock).toHaveBeenCalledTimes(signups);
    },
  );

  it("should return 400 for missing inviteeOrgId", async () => {
    const res = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "stripe" });

    expect(res.status).toBe(400);
  });

  it("should return 401 without API key", async () => {
    const res = await request(app)
      .post("/internal/invites/claim")
      .send({ code: "stripe", inviteeOrgId: randomId() });

    expect(res.status).toBe(401);
  });
});

describe("GET /internal/orgs/:orgId/invites/status", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  it("should report zero signups for an org that has not referred anyone", async () => {
    const org = await insertTestOrg({ externalId: "org-status-fresh", slug: "fresh" });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/invites/status`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signups: 0, code: "fresh" });
  });

  it.each([3, 10, 50])(
    "should report %i signups and nothing expired or capped",
    async (signups) => {
      const slug = `status-bulk-${signups}`;
      const org = await insertTestOrg({ externalId: `org-${slug}`, slug });
      const invitees = await Promise.all(
        Array.from({ length: signups }, (_, i) => insertTestOrg({ externalId: `org-${slug}-i${i}` })),
      );
      await db.insert(invites).values(
        invitees.map((i) => ({
          inviterOrgId: org.id,
          inviteeOrgId: i.id,
          code: slug,
          status: "signed_up" as const,
          signedUpAt: new Date(),
        })),
      );

      const res = await request(app)
        .get(`/internal/orgs/${org.id}/invites/status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ signups, code: slug });
      expect(res.body).not.toHaveProperty("expired");
      expect(res.body).not.toHaveProperty("total");
    },
  );

  it("should return code:null for org without slug", async () => {
    const org = await insertTestOrg({ externalId: "org-status-noslug" });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/invites/status`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.code).toBeNull();
    expect(res.body.signups).toBe(0);
  });

  it("should return 404 for unknown orgId", async () => {
    const res = await request(app)
      .get(`/internal/orgs/${randomId()}/invites/status`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Org not found");
  });

  it("should return 400 for invalid orgId", async () => {
    const res = await request(app)
      .get(`/internal/orgs/not-a-uuid/invites/status`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
  });

  it("should return 401 without API key", async () => {
    const org = await insertTestOrg({ externalId: "org-status-401", slug: "s401" });

    const res = await request(app).get(`/internal/orgs/${org.id}/invites/status`);

    expect(res.status).toBe(401);
  });
});

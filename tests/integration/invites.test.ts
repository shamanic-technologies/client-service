import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { invites } from "../../src/db/schema.js";

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

  it("should return valid:true with inviterOrgName for known slug with 0/3 used", async () => {
    await insertTestOrg({ externalId: "org-stripe", name: "Stripe", slug: "stripe" });

    const res = await request(app)
      .post("/public/invites/validate")
      .set("x-api-key", API_KEY)
      .send({ code: "stripe" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, inviterOrgName: "Stripe" });
  });

  it("should return valid:true with 2/3 used", async () => {
    const inviter = await insertTestOrg({ externalId: "org-2used", name: "Two Used", slug: "two-used" });
    const invitee1 = await insertTestOrg({ externalId: "org-2used-i1" });
    const invitee2 = await insertTestOrg({ externalId: "org-2used-i2" });
    await db.insert(invites).values([
      { inviterOrgId: inviter.id, inviteeOrgId: invitee1.id, code: "two-used", status: "signed_up", signedUpAt: new Date() },
      { inviterOrgId: inviter.id, inviteeOrgId: invitee2.id, code: "two-used", status: "signed_up", signedUpAt: new Date() },
    ]);

    const res = await request(app)
      .post("/public/invites/validate")
      .set("x-api-key", API_KEY)
      .send({ code: "two-used" });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it("should return valid:false when capped (3/3 used)", async () => {
    const inviter = await insertTestOrg({ externalId: "org-capped", name: "Capped", slug: "capped" });
    const i1 = await insertTestOrg({ externalId: "org-c-i1" });
    const i2 = await insertTestOrg({ externalId: "org-c-i2" });
    const i3 = await insertTestOrg({ externalId: "org-c-i3" });
    await db.insert(invites).values([
      { inviterOrgId: inviter.id, inviteeOrgId: i1.id, code: "capped", status: "signed_up", signedUpAt: new Date() },
      { inviterOrgId: inviter.id, inviteeOrgId: i2.id, code: "capped", status: "signed_up", signedUpAt: new Date() },
      { inviterOrgId: inviter.id, inviteeOrgId: i3.id, code: "capped", status: "signed_up", signedUpAt: new Date() },
    ]);

    const res = await request(app)
      .post("/public/invites/validate")
      .set("x-api-key", API_KEY)
      .send({ code: "capped" });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

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

  beforeEach(async () => {
    await cleanTestData();
  });

  it("should claim invite (happy path)", async () => {
    const inviter = await insertTestOrg({ externalId: "org-claim-inv", slug: "claim-test" });
    const invitee = await insertTestOrg({ externalId: "org-claim-i1" });

    const res = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "claim-test", inviteeOrgId: invitee.id });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, inviterOrgId: inviter.id });

    const rows = await db
      .select()
      .from(invites)
      .where(and(eq(invites.inviterOrgId, inviter.id), eq(invites.inviteeOrgId, invitee.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("signed_up");
    expect(rows[0].signedUpAt).not.toBeNull();
    expect(rows[0].code).toBe("claim-test");
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

  it("should reject 4th claim with HTTP 409", async () => {
    const inviter = await insertTestOrg({ externalId: "org-4th", slug: "fourth" });
    const i1 = await insertTestOrg({ externalId: "org-4th-i1" });
    const i2 = await insertTestOrg({ externalId: "org-4th-i2" });
    const i3 = await insertTestOrg({ externalId: "org-4th-i3" });
    const i4 = await insertTestOrg({ externalId: "org-4th-i4" });

    for (const invitee of [i1, i2, i3]) {
      const r = await request(app)
        .post("/internal/invites/claim")
        .set("x-api-key", API_KEY)
        .send({ code: "fourth", inviteeOrgId: invitee.id });
      expect(r.status).toBe(200);
    }

    const res = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "fourth", inviteeOrgId: i4.id });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Invite cap reached", used: 3, total: 3 });

    const count = (await db.select().from(invites).where(eq(invites.inviterOrgId, inviter.id))).length;
    expect(count).toBe(3);
  });

  it("should allow idempotent re-claim of an existing invitee even when capped at 3/3", async () => {
    const inviter = await insertTestOrg({ externalId: "org-capreclaim", slug: "capreclaim" });
    const invitees = await Promise.all([
      insertTestOrg({ externalId: "org-cr-i1" }),
      insertTestOrg({ externalId: "org-cr-i2" }),
      insertTestOrg({ externalId: "org-cr-i3" }),
    ]);

    for (const invitee of invitees) {
      await request(app)
        .post("/internal/invites/claim")
        .set("x-api-key", API_KEY)
        .send({ code: "capreclaim", inviteeOrgId: invitee.id });
    }

    const res = await request(app)
      .post("/internal/invites/claim")
      .set("x-api-key", API_KEY)
      .send({ code: "capreclaim", inviteeOrgId: invitees[0].id });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

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

  it("should return 0/3 with expired=false for unused org", async () => {
    const org = await insertTestOrg({ externalId: "org-status-fresh", slug: "fresh" });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/invites/status`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ used: 0, total: 3, code: "fresh", expired: false });
  });

  it("should return 3/3 with expired=true at cap", async () => {
    const org = await insertTestOrg({ externalId: "org-status-capped", slug: "status-capped" });
    const invitees = await Promise.all([
      insertTestOrg({ externalId: "org-sc-i1" }),
      insertTestOrg({ externalId: "org-sc-i2" }),
      insertTestOrg({ externalId: "org-sc-i3" }),
    ]);
    await db.insert(invites).values(
      invitees.map((i) => ({
        inviterOrgId: org.id,
        inviteeOrgId: i.id,
        code: "status-capped",
        status: "signed_up" as const,
        signedUpAt: new Date(),
      })),
    );

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/invites/status`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ used: 3, total: 3, code: "status-capped", expired: true });
  });

  it("should return code:null for org without slug", async () => {
    const org = await insertTestOrg({ externalId: "org-status-noslug" });

    const res = await request(app)
      .get(`/internal/orgs/${org.id}/invites/status`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.code).toBeNull();
    expect(res.body.used).toBe(0);
    expect(res.body.expired).toBe(false);
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

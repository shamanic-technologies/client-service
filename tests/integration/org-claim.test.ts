import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs, users } from "../../src/db/schema.js";

const API_KEY = "test_api_key";

/**
 * Claiming is the one transition anonymous -> identified. What it must never do
 * is move anything: the internal uuid stays, so every reference taken while the
 * visitor was signed out keeps resolving.
 */
describe("POST /internal/orgs/:orgId/claim", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  // The db connection is shared across this file; only the last describe closes it.
  afterAll(async () => {
    await cleanTestData();
  });

  async function anonymousOrg(externalId = `anon-${randomId()}`) {
    return insertTestOrg({ externalId, anonymousAt: new Date(), name: "Anonymous visitor" });
  }

  it("attaches the identity, keeps the internal uuid, and makes the signer-up a member", async () => {
    const org = await anonymousOrg();

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org_clerk_new",
        externalUserId: "user_clerk_new",
        email: "founder@example.com",
        orgName: "Acme Inc",
      });

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.externalOrgId).toBe("org_clerk_new");
    expect(res.body.alreadyClaimed).toBe(false);
    expect(res.body.claimedAt).toBeTruthy();

    // Same org row, now resolving by the identity-provider id.
    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.externalId).toBe("org_clerk_new");
    expect(row.name).toBe("Acme Inc");
    expect(row.anonymousAt).not.toBeNull();
    expect(row.claimedAt).not.toBeNull();

    const [byExternal] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.externalId, "org_clerk_new"));
    expect(byExternal.id).toBe(org.id);

    // The person signing up is a member the way any member is.
    const [user] = await db.select().from(users).where(eq(users.externalId, "user_clerk_new"));
    expect(user.orgId).toBe(org.id);
    expect(user.id).toBe(res.body.userId);
  });

  it("leaves every reference taken before the call pointing at the same org", async () => {
    const org = await anonymousOrg();
    // Stand-in for the work done while signed out: a row written against the
    // internal uuid by another service (here, a user of the anonymous org).
    const visitor = await insertTestUser({ externalId: `anon-user-${randomId()}`, orgId: org.id });

    await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_keeps", externalUserId: "user_clerk_keeps" });

    const [stillThere] = await db.select().from(users).where(eq(users.id, visitor.id));
    expect(stillThere.orgId).toBe(org.id);

    const res = await request(app)
      .get(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.externalId).toBe("org_clerk_keeps");
  });

  it("is harmless called twice with the same inputs", async () => {
    const org = await anonymousOrg();
    const body = { externalOrgId: "org_clerk_twice", externalUserId: "user_clerk_twice" };

    const first = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send(body);
    const second = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.alreadyClaimed).toBe(true);
    expect(second.body.orgId).toBe(first.body.orgId);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.claimedAt).toBe(first.body.claimedAt);

    const allOrgs = await db.select().from(orgs);
    expect(allOrgs).toHaveLength(1);
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
  });

  it("refuses an org that already carries a different identity, distinguishably", async () => {
    const org = await anonymousOrg();
    await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_first", externalUserId: "user_clerk_first" });

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_second", externalUserId: "user_clerk_second" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("org_already_claimed");

    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.externalId).toBe("org_clerk_first");
  });

  it("refuses an identity another org already uses, distinguishably", async () => {
    const org = await anonymousOrg();
    await insertTestOrg({ externalId: "org_clerk_taken" });

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_taken", externalUserId: "user_clerk_x" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("external_id_taken");

    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.claimedAt).toBeNull();
  });

  it("refuses an org that was never a throwaway one, distinguishably", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_real" });

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_other", externalUserId: "user_clerk_y" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("org_not_anonymous");

    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.externalId).toBe("org_clerk_real");
  });

  it("404s an unknown org, distinguishably", async () => {
    const res = await request(app)
      .post(`/internal/orgs/${randomId()}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_z", externalUserId: "user_clerk_z" });

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("org_not_found");
  });

  it("400s an invalid orgId and an incomplete body", async () => {
    const badId = await request(app)
      .post("/internal/orgs/not-a-uuid/claim")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_a", externalUserId: "user_a" });
    expect(badId.status).toBe(400);
    expect(badId.body.reason).toBe("invalid_request");

    const org = await anonymousOrg();
    const badBody = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_a" });
    expect(badBody.status).toBe(400);
    expect(badBody.body.reason).toBe("invalid_request");
  });

  it("401s without the API key", async () => {
    const org = await anonymousOrg();
    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .send({ externalOrgId: "org_a", externalUserId: "user_a" });
    expect(res.status).toBe(401);
  });

  it("moves a user who already exists onto the claimed org rather than duplicating them", async () => {
    const org = await anonymousOrg();
    const existing = await insertTestUser({ externalId: "user_clerk_existing" });

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_m", externalUserId: "user_clerk_existing" });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(existing.id);

    const rows = await db.select().from(users).where(eq(users.externalId, "user_clerk_existing"));
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(org.id);
  });
});

/**
 * Anonymity is a fact we RECORD at creation, never one we infer by looking at
 * what the external id happens to be.
 */
describe("POST /internal/resolve — the anonymous marker", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("marks the org it creates when the caller declares it anonymous", async () => {
    const res = await request(app)
      .post("/internal/resolve")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "anon_abc", externalUserId: "anon_user_abc", anonymous: true });

    expect(res.status).toBe(200);
    const [org] = await db.select().from(orgs).where(eq(orgs.id, res.body.orgId));
    expect(org.anonymousAt).not.toBeNull();
    expect(org.claimedAt).toBeNull();
  });

  it("leaves the org unmarked when the caller says nothing", async () => {
    const res = await request(app)
      .post("/internal/resolve")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_plain", externalUserId: "user_clerk_plain" });

    const [org] = await db.select().from(orgs).where(eq(orgs.id, res.body.orgId));
    expect(org.anonymousAt).toBeNull();
  });

  it("never re-labels an existing real org as anonymous", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_real2" });

    await request(app)
      .post("/internal/resolve")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_real2", externalUserId: "user_clerk_real2", anonymous: true });

    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.anonymousAt).toBeNull();
  });
});

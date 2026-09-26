import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, closeDb } from "../helpers/test-db.js";

// The claim's shell check asks brand-service and stripe-service; stub both as
// "nothing here" so a shell can be absorbed in this suite.
vi.mock("../../src/lib/brand-service-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/brand-service-client.js")>()),
  listBrandClaimsForOrgs: vi.fn(async () => []),
}));
vi.mock("../../src/lib/stripe-service-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/stripe-service-client.js")>()),
  getOrgPaymentTotals: vi.fn(async () => []),
}));

const API_KEY = "test_api_key";

const touch = (channel: string, extra: Record<string, unknown> = {}) => ({ channel, ...extra });

describe("org first touch (acquisition)", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("records a touch for an internal org uuid, then ignores a second hand-over", async () => {
    const org = await insertTestOrg({ externalId: "anon_a1", anonymousAt: new Date() });

    const first = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ orgId: org.id, acquisition: touch("newsletter", { utmSource: "beehiiv", landingPath: "/" }) });
    expect(first.status).toBe(200);
    expect(first.body.recorded).toBe(true);
    expect(first.body.acquisition).toMatchObject({ channel: "newsletter", utmSource: "beehiiv", recordedVia: "org_id" });

    const second = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ orgId: org.id, acquisition: touch("paid_search", { gclid: "abc" }) });
    expect(second.status).toBe(200);
    expect(second.body.recorded).toBe(false);
    expect(second.body.acquisition.channel).toBe("newsletter");
    expect(second.body.acquisition.gclid).toBeNull();
  });

  it("records a touch by Clerk org + user id, creating the org like resolve does", async () => {
    const res = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_x", externalUserId: "user_clerk_x", acquisition: touch("direct") });
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(true);
    expect(res.body.acquisition.recordedVia).toBe("external_ids");

    const resolved = await request(app)
      .post("/internal/resolve")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_x", externalUserId: "user_clerk_x" });
    expect(resolved.body.orgId).toBe(res.body.orgId);
  });

  it("404s an unknown org uuid", async () => {
    const res = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ orgId: "00000000-0000-4000-8000-000000000000", acquisition: touch("direct") });
    expect(res.status).toBe(404);
  });

  it("rejects an over-long field and a missing channel", async () => {
    const org = await insertTestOrg({ externalId: "org_bounds" });
    const long = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ orgId: org.id, acquisition: touch("social", { referrer: "x".repeat(2049) }) });
    expect(long.status).toBe(400);

    const noChannel = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ orgId: org.id, acquisition: { utmSource: "x" } });
    expect(noChannel.status).toBe(400);
  });

  it("rides /internal/resolve on anonymous creation, and survives the claim + the signup hand-over after it", async () => {
    const created = await request(app)
      .post("/internal/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "anon_walk",
        externalUserId: "anon_user",
        anonymous: true,
        acquisition: touch("cold_email", { utmCampaign: "sept" }),
      });
    expect(created.status).toBe(200);
    const orgId = created.body.orgId;

    const claim = await request(app)
      .post(`/internal/orgs/${orgId}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_real", externalUserId: "user_clerk_real" });
    expect(claim.status).toBe(200);

    const after = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_real", externalUserId: "user_clerk_real", acquisition: touch("direct") });
    expect(after.body.orgId).toBe(orgId);
    expect(after.body.recorded).toBe(false);

    const read = await request(app).get(`/internal/orgs/${orgId}/acquisition`).set("x-api-key", API_KEY);
    expect(read.status).toBe(200);
    expect(read.body.acquisition).toMatchObject({ channel: "cold_email", utmCampaign: "sept", recordedVia: "resolve" });
  });

  it("a shell's touch moves to the claiming org only when that org has none", async () => {
    // Anonymous org with NO touch; a signup hand-over lands on a shell first.
    const anon = await insertTestOrg({ externalId: "anon_no_touch", anonymousAt: new Date() });
    const shell = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_s", externalUserId: "user_clerk_s", acquisition: touch("partner", { referralCode: "p1" }) });
    expect(shell.body.recorded).toBe(true);

    const claim = await request(app)
      .post(`/internal/orgs/${anon.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_s", externalUserId: "user_clerk_s" });
    expect(claim.status).toBe(200);
    expect(claim.body.absorbedOrgId).toBe(shell.body.orgId);

    const moved = await request(app).get(`/internal/orgs/${anon.id}/acquisition`).set("x-api-key", API_KEY);
    expect(moved.body.acquisition).toMatchObject({ channel: "partner", referralCode: "p1", recordedVia: "absorbed_shell" });
    const left = await request(app).get(`/internal/orgs/${shell.body.orgId}/acquisition`).set("x-api-key", API_KEY);
    expect(left.body.acquisition).toBeNull();
  });

  it("a shell never steals the claiming org's own touch", async () => {
    const anon = await insertTestOrg({ externalId: "anon_has_touch", anonymousAt: new Date() });
    await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ orgId: anon.id, acquisition: touch("ai_assistant") });
    const shell = await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_t", externalUserId: "user_clerk_t", acquisition: touch("direct") });

    const claim = await request(app)
      .post(`/internal/orgs/${anon.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_t", externalUserId: "user_clerk_t" });
    expect(claim.status).toBe(200);

    const read = await request(app).get(`/internal/orgs/${anon.id}/acquisition`).set("x-api-key", API_KEY);
    expect(read.body.acquisition.channel).toBe("ai_assistant");
    const shellRead = await request(app).get(`/internal/orgs/${shell.body.orgId}/acquisition`).set("x-api-key", API_KEY);
    expect(shellRead.body.acquisition.channel).toBe("direct");
  });

  it("reads null for an org that never had anything recorded, and 404 for no org", async () => {
    const org = await insertTestOrg({ externalId: "org_old" });
    const read = await request(app).get(`/internal/orgs/${org.id}/acquisition`).set("x-api-key", API_KEY);
    expect(read.body).toEqual({ orgId: org.id, acquisition: null });

    const missing = await request(app)
      .get("/internal/orgs/00000000-0000-4000-8000-000000000000/acquisition")
      .set("x-api-key", API_KEY);
    expect(missing.status).toBe(404);
  });

  it("lists orgs in a window with their touch, flags anonymous-unclaimed as not real, excludes shells", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const real = await insertTestOrg({ externalId: "org_list_real" });
    const ghost = await insertTestOrg({ externalId: "anon_list_ghost", anonymousAt: new Date() });
    await request(app)
      .post("/internal/acquisitions")
      .set("x-api-key", API_KEY)
      .send({ orgId: real.id, acquisition: touch("organic_search") });

    const res = await request(app).get(`/internal/acquisitions?createdAfter=${encodeURIComponent(since)}`).set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.orgs.map((o: { orgId: string }) => [o.orgId, o]));
    expect(byId[real.id]).toMatchObject({ real: true, anonymous: false, acquisition: { channel: "organic_search" } });
    expect(byId[ghost.id]).toMatchObject({ real: false, anonymous: true, acquisition: null });

    const bad = await request(app).get("/internal/acquisitions").set("x-api-key", API_KEY);
    expect(bad.status).toBe(400);
  });

  it("org teardown removes its touch with it", async () => {
    const org = await insertTestOrg({ externalId: "org_teardown_touch" });
    await request(app).post("/internal/acquisitions").set("x-api-key", API_KEY).send({ orgId: org.id, acquisition: touch("social") });
    const { db } = await import("../../src/db/index.js");
    const { orgs } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.delete(orgs).where(eq(orgs.id, org.id));
  });
});

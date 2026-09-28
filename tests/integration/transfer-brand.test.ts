import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import {
  rewardTaskStates,
  rewardOfferObservations,
  rewardTaskCompletions,
} from "../../src/db/schema.js";

const API_KEY = "test_api_key";

async function seedLedger(orgId: string, brandId: string, opts: { delivered?: boolean } = {}) {
  const offerId = randomId();
  const [state] = await db
    .insert(rewardTaskStates)
    .values({
      orgId,
      brandId,
      offerId,
      taskKey: "offer_economics_refresh",
      contentFingerprint: "fp",
      contentChangedAt: new Date("2026-08-01T00:00:00Z"),
      contentChangedProvenance: "observed",
    })
    .returning();
  await db.insert(rewardOfferObservations).values({
    orgId,
    brandId,
    offerId,
    contentFingerprint: "fp",
    payload: { offer: {}, legRates: [] },
  });
  const [completion] = await db
    .insert(rewardTaskCompletions)
    .values({
      rewardTaskStateId: state.id,
      orgId,
      taskKey: "offer_economics_refresh",
      dueAt: new Date("2026-08-31T00:00:00Z"),
      rewardCents: 100,
      billingNotifiedAt: opts.delivered === false ? null : new Date(),
    })
    .returning();
  return { state, offerId, completion };
}

describe("POST /internal/transfer-brand", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("moves the brand's reward ledger to the target org and leaves the source empty", async () => {
    const source = await insertTestOrg({ externalId: "org_agency" });
    const target = await insertTestOrg({ externalId: "org_client" });
    const brandId = randomId();
    const otherBrandId = randomId();
    const { state, completion } = await seedLedger(source.id, brandId);
    const untouched = await seedLedger(source.id, otherBrandId);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: brandId, sourceOrgId: source.id, targetOrgId: target.id });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "reward_task_states", count: 1 },
      { tableName: "reward_offer_observations", count: 1 },
      { tableName: "reward_task_completions", count: 1 },
    ]);

    const [moved] = await db.select().from(rewardTaskStates).where(eq(rewardTaskStates.id, state.id));
    expect(moved.orgId).toBe(target.id);
    expect(moved.brandId).toBe(brandId);
    // The clock and fingerprint travel: the target's first read pays nothing.
    expect(moved.contentFingerprint).toBe("fp");
    expect(moved.contentChangedAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");

    const [movedCompletion] = await db
      .select()
      .from(rewardTaskCompletions)
      .where(eq(rewardTaskCompletions.id, completion.id));
    expect(movedCompletion.orgId).toBe(target.id);
    expect(movedCompletion.billingNotifiedAt).not.toBeNull();

    const sourceObs = await db
      .select()
      .from(rewardOfferObservations)
      .where(eq(rewardOfferObservations.orgId, source.id));
    expect(sourceObs.map((o) => o.brandId)).toEqual([otherBrandId]);

    const [other] = await db.select().from(rewardTaskStates).where(eq(rewardTaskStates.id, untouched.state.id));
    expect(other.orgId).toBe(source.id);
  });

  it("is idempotent: a replay moves nothing and reports zeros", async () => {
    const source = await insertTestOrg({ externalId: "org_agency" });
    const target = await insertTestOrg({ externalId: "org_client" });
    const brandId = randomId();
    await seedLedger(source.id, brandId);
    const body = { sourceBrandId: brandId, sourceOrgId: source.id, targetOrgId: target.id };

    await request(app).post("/internal/transfer-brand").set("x-api-key", API_KEY).send(body);
    const replay = await request(app).post("/internal/transfer-brand").set("x-api-key", API_KEY).send(body);

    expect(replay.status).toBe(200);
    expect(replay.body.updatedTables.every((t: { count: number }) => t.count === 0)).toBe(true);
    const targetStates = await db.select().from(rewardTaskStates).where(eq(rewardTaskStates.orgId, target.id));
    expect(targetStates).toHaveLength(1);
  });

  it("rewrites the brand id when merging into targetBrandId, including another org's rows", async () => {
    const source = await insertTestOrg({ externalId: "org_agency" });
    const target = await insertTestOrg({ externalId: "org_client" });
    const bystander = await insertTestOrg({ externalId: "org_bystander" });
    const brandId = randomId();
    const targetBrandId = randomId();
    const { state } = await seedLedger(source.id, brandId);
    const shared = await seedLedger(bystander.id, brandId);

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: brandId, sourceOrgId: source.id, targetOrgId: target.id, targetBrandId });

    expect(res.status).toBe(200);
    const [moved] = await db.select().from(rewardTaskStates).where(eq(rewardTaskStates.id, state.id));
    expect(moved).toMatchObject({ orgId: target.id, brandId: targetBrandId });
    const [other] = await db.select().from(rewardTaskStates).where(eq(rewardTaskStates.id, shared.state.id));
    expect(other).toMatchObject({ orgId: bystander.id, brandId: targetBrandId });
  });

  it("does not move another org's ledger for the same brand", async () => {
    const source = await insertTestOrg({ externalId: "org_agency" });
    const target = await insertTestOrg({ externalId: "org_client" });
    const coOwner = await insertTestOrg({ externalId: "org_co_owner" });
    const brandId = randomId();
    await seedLedger(source.id, brandId);
    const coOwned = await seedLedger(coOwner.id, brandId);

    await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: brandId, sourceOrgId: source.id, targetOrgId: target.id })
      .expect(200);

    const [row] = await db.select().from(rewardTaskStates).where(eq(rewardTaskStates.id, coOwned.state.id));
    expect(row.orgId).toBe(coOwner.id);
  });

  it("refuses (409) while a completion is still owed to the source org, and moves nothing", async () => {
    const source = await insertTestOrg({ externalId: "org_agency" });
    const target = await insertTestOrg({ externalId: "org_client" });
    const brandId = randomId();
    const { state } = await seedLedger(source.id, brandId, { delivered: false });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: brandId, sourceOrgId: source.id, targetOrgId: target.id });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: "undelivered_reward_completions", count: 1 });
    const [row] = await db.select().from(rewardTaskStates).where(eq(rewardTaskStates.id, state.id));
    expect(row.orgId).toBe(source.id);
  });

  it("refuses (409) when the target already tracks the same offer", async () => {
    const source = await insertTestOrg({ externalId: "org_agency" });
    const target = await insertTestOrg({ externalId: "org_client" });
    const brandId = randomId();
    const { offerId } = await seedLedger(source.id, brandId);
    await db.insert(rewardTaskStates).values({
      orgId: target.id,
      brandId,
      offerId,
      taskKey: "offer_economics_refresh",
      contentFingerprint: "fp",
      contentChangedAt: new Date(),
      contentChangedProvenance: "observed",
    });

    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: brandId, sourceOrgId: source.id, targetOrgId: target.id });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: "target_already_holds_offer_task", offerIds: [offerId] });
  });

  it("404s when the target org does not exist here", async () => {
    const source = await insertTestOrg({ externalId: "org_agency" });
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: randomId(), sourceOrgId: source.id, targetOrgId: randomId() });

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("target_org_not_found");
  });

  it("400s on a non-uuid org or same source and target", async () => {
    const org = await insertTestOrg({ externalId: "org_agency" });
    const bad = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: randomId(), sourceOrgId: "org_clerk", targetOrgId: org.id });
    expect(bad.status).toBe(400);

    const same = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", API_KEY)
      .send({ sourceBrandId: randomId(), sourceOrgId: org.id, targetOrgId: org.id });
    expect(same.status).toBe(400);
  });

  it("401s without the api key", async () => {
    const res = await request(app).post("/internal/transfer-brand").send({});
    expect(res.status).toBe(401);
  });
});

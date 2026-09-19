import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, closeDb, randomId } from "../helpers/test-db.js";

const API_KEY = "test_api_key";

describe("POST /internal/orgs/real", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("an ordinary org that was never anonymous is real", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_real" });

    const res = await request(app)
      .post("/internal/orgs/real")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [org.id] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ realOrgIds: [org.id] });
  });

  it("an anonymous org that has never been claimed is NOT real", async () => {
    const ghost = await insertTestOrg({
      externalId: "anon_abandoned",
      anonymousAt: new Date(),
    });

    const res = await request(app)
      .post("/internal/orgs/real")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [ghost.id] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ realOrgIds: [] });
  });

  it("an anonymous org that has since been claimed IS real", async () => {
    const claimed = await insertTestOrg({
      externalId: "org_clerk_after_claim",
      anonymousAt: new Date(Date.now() - 60_000),
      claimedAt: new Date(),
    });

    const res = await request(app)
      .post("/internal/orgs/real")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [claimed.id] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ realOrgIds: [claimed.id] });
  });

  it("an id naming no org does not break the answer for the others", async () => {
    const real = await insertTestOrg({ externalId: "org_clerk_mixed" });
    const ghost = await insertTestOrg({ externalId: "anon_mixed", anonymousAt: new Date() });
    const unknown = randomId();

    const res = await request(app)
      .post("/internal/orgs/real")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [unknown, ghost.id, real.id] });

    expect(res.status).toBe(200);
    expect(res.body.realOrgIds).toEqual([real.id]);
  });

  it("answers nothing about an org beyond its id", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_bare", name: "Acme Inc" });

    const res = await request(app)
      .post("/internal/orgs/real")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [org.id] });

    expect(Object.keys(res.body)).toEqual(["realOrgIds"]);
    expect(JSON.stringify(res.body)).not.toContain("Acme");
    expect(JSON.stringify(res.body)).not.toContain("org_clerk_bare");
  });

  it("an empty list is an empty answer, not an error", async () => {
    const res = await request(app)
      .post("/internal/orgs/real")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ realOrgIds: [] });
  });

  it("rejects a body that is not { orgIds: uuid[] }", async () => {
    const res = await request(app)
      .post("/internal/orgs/real")
      .set("x-api-key", API_KEY)
      .send({ orgIds: ["not-a-uuid"] });

    expect(res.status).toBe(400);
  });

  it("requires the api key", async () => {
    const res = await request(app).post("/internal/orgs/real").send({ orgIds: [] });
    expect(res.status).toBe(401);
  });
});

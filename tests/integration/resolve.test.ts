import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = "test_api_key";
const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("POST /resolve", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("should create new org and user on first resolve", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .send({
        externalOrgId: "clerk_org_123",
        externalUserId: "clerk_user_456",
      });

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBeDefined();
    expect(res.body.userId).toBeDefined();
    expect(res.body.orgCreated).toBe(true);
    expect(res.body.userCreated).toBe(true);
  });

  it("should return existing org and user on second resolve (idempotent)", async () => {
    const first = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    const second = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(second.status).toBe(200);
    expect(second.body.orgId).toBe(first.body.orgId);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.orgCreated).toBe(false);
    expect(second.body.userCreated).toBe(false);
  });

  it("should pass through profile data on create", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .send({
        externalOrgId: "org-profile",
        externalUserId: "user-profile",
        email: "test@example.com",
        firstName: "John",
        lastName: "Doe",
      });

    expect(res.status).toBe(200);
    expect(res.body.userCreated).toBe(true);
  });

  it("should reject missing externalOrgId", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .send({
        externalUserId: "user-1",
      });

    expect(res.status).toBe(400);
  });

  it("should reject missing externalUserId", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .set("x-run-id", RUN_ID)
      .send({
        externalOrgId: "org-1",
      });

    expect(res.status).toBe(400);
  });

  it("should reject request without API key", async () => {
    const res = await request(app)
      .post("/resolve")
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(401);
  });

  it("should reject request with wrong API key", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", "wrong-key")
      .set("x-run-id", RUN_ID)
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(401);
  });

  it("should return 400 without x-run-id header", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing x-run-id header");
  });
});

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";

const API_KEY = "test_api_key";

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
      .send({
        appId: "my-app",
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
      .send({
        appId: "my-app",
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    const second = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        appId: "my-app",
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(second.status).toBe(200);
    expect(second.body.orgId).toBe(first.body.orgId);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.orgCreated).toBe(false);
    expect(second.body.userCreated).toBe(false);
  });

  it("should scope external IDs per app", async () => {
    const app1 = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        appId: "app-a",
        externalOrgId: "same-org",
        externalUserId: "same-user",
      });

    const app2 = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        appId: "app-b",
        externalOrgId: "same-org",
        externalUserId: "same-user",
      });

    expect(app1.body.orgId).not.toBe(app2.body.orgId);
    expect(app1.body.userId).not.toBe(app2.body.userId);
  });

  it("should pass through profile data on create", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        appId: "my-app",
        externalOrgId: "org-profile",
        externalUserId: "user-profile",
        email: "test@example.com",
        firstName: "John",
        lastName: "Doe",
      });

    expect(res.status).toBe(200);
    expect(res.body.userCreated).toBe(true);
  });

  it("should reject missing appId", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(400);
  });

  it("should reject missing externalOrgId", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        appId: "my-app",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(400);
  });

  it("should reject missing externalUserId", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        appId: "my-app",
        externalOrgId: "org-1",
      });

    expect(res.status).toBe(400);
  });

  it("should reject request without API key", async () => {
    const res = await request(app)
      .post("/resolve")
      .send({
        appId: "my-app",
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(401);
  });

  it("should reject request with wrong API key", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", "wrong-key")
      .send({
        appId: "my-app",
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(401);
  });
});

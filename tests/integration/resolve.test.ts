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
        externalOrgId: "clerk_org_123",
        externalUserId: "clerk_user_456",
        email: "user@example.com",
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
        externalOrgId: "org-1",
        externalUserId: "user-1",
        email: "idempotent@example.com",
      });

    const second = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
        email: "idempotent@example.com",
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

  it("should reject missing email", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(400);
  });

  it("should reject invalid email", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
        email: "not-an-email",
      });

    expect(res.status).toBe(400);
  });

  it("should reject missing externalOrgId", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalUserId: "user-1",
      });

    expect(res.status).toBe(400);
  });

  it("should reject missing externalUserId", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
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
      .send({
        externalOrgId: "org-1",
        externalUserId: "user-1",
      });

    expect(res.status).toBe(401);
  });

  it("should not require x-run-id header (infrastructure endpoint)", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-no-run",
        externalUserId: "user-no-run",
        email: "norun@example.com",
      });

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBeDefined();
    expect(res.body.userId).toBeDefined();
  });
});

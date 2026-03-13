import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { users } from "../../src/db/schema.js";

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

  it("should create user without email", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-no-email",
        externalUserId: "user-no-email",
      });

    expect(res.status).toBe(200);
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

  it("should not overwrite existing email when omitted on update", async () => {
    // First call: create with email
    const first = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-preserve",
        externalUserId: "user-preserve",
        email: "original@example.com",
        firstName: "Alice",
      });
    expect(first.status).toBe(200);

    // Second call: omit email and firstName
    const second = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-preserve",
        externalUserId: "user-preserve",
      });
    expect(second.status).toBe(200);
    expect(second.body.userId).toBe(first.body.userId);

    // Verify DB still has original values
    const [row] = await db
      .select({ email: users.email, firstName: users.firstName })
      .from(users)
      .where(eq(users.id, first.body.userId));
    expect(row.email).toBe("original@example.com");
    expect(row.firstName).toBe("Alice");
  });

  it("should overwrite existing fields when explicitly provided on update", async () => {
    // First call: create with email
    await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-overwrite",
        externalUserId: "user-overwrite",
        email: "old@example.com",
        firstName: "Bob",
      });

    // Second call: provide new email and firstName
    const second = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org-overwrite",
        externalUserId: "user-overwrite",
        email: "new@example.com",
        firstName: "Robert",
      });

    // Verify DB has updated values
    const [row] = await db
      .select({ email: users.email, firstName: users.firstName })
      .from(users)
      .where(eq(users.id, second.body.userId));
    expect(row.email).toBe("new@example.com");
    expect(row.firstName).toBe("Robert");
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

  it("should accept optional workflow tracking headers", async () => {
    const res = await request(app)
      .post("/resolve")
      .set("x-api-key", API_KEY)
      .set("x-campaign-id", "camp-resolve-1")
      .set("x-brand-id", "brand-resolve-1")
      .set("x-workflow-name", "resolve-flow")
      .send({
        externalOrgId: "org-wf-resolve",
        externalUserId: "user-wf-resolve",
        email: "wf-resolve@example.com",
      });

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBeDefined();
    expect(res.body.userId).toBeDefined();
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

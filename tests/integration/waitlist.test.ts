import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { waitlist } from "../../src/db/schema.js";

const API_KEY = "test_api_key";

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

describe("POST /public/waitlist/request-access", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  it("should create new waitlist entry with position", async () => {
    const res = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "founder@example.com", brandUrl: "https://example.com" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.position).toBe("number");
    expect(res.body.position).toBeGreaterThan(0);

    const [row] = await db
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, "founder@example.com"));
    expect(row.brandUrl).toBe("https://example.com");
    expect(row.position).toBe(res.body.position);
  });

  it("should return same position on idempotent re-call (first write wins)", async () => {
    const first = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "idem@example.com", brandUrl: "https://original.com" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "idem@example.com", brandUrl: "https://changed.com" });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.position).toBe(first.body.position);

    const [row] = await db
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, "idem@example.com"));
    expect(row.brandUrl).toBe("https://original.com");
  });

  it("should increment position monotonically across distinct emails", async () => {
    const a = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "a@example.com", brandUrl: "https://a.com" });
    const b = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "b@example.com", brandUrl: "https://b.com" });
    const c = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "c@example.com", brandUrl: "https://c.com" });

    expect(b.body.position).toBeGreaterThan(a.body.position);
    expect(c.body.position).toBeGreaterThan(b.body.position);
  });

  it("should return 400 for invalid email", async () => {
    const res = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "not-an-email", brandUrl: "https://example.com" });

    expect(res.status).toBe(400);
  });

  it("should return 400 for missing brandUrl", async () => {
    const res = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "missing-brand@example.com" });

    expect(res.status).toBe(400);
  });

  it("should return 401 without API key", async () => {
    const res = await request(app)
      .post("/public/waitlist/request-access")
      .send({ email: "noauth@example.com", brandUrl: "https://example.com" });

    expect(res.status).toBe(401);
  });
});

describe("GET /public/waitlist/position", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  it("should return position for existing email", async () => {
    const created = await request(app)
      .post("/public/waitlist/request-access")
      .set("x-api-key", API_KEY)
      .send({ email: "lookup@example.com", brandUrl: "https://example.com" });

    const res = await request(app)
      .get("/public/waitlist/position")
      .query({ email: "lookup@example.com" })
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ position: created.body.position });
  });

  it("should return 404 for email not on waitlist", async () => {
    const res = await request(app)
      .get("/public/waitlist/position")
      .query({ email: "ghost@example.com" })
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Email not on waitlist");
  });

  it("should return 400 for missing email query", async () => {
    const res = await request(app)
      .get("/public/waitlist/position")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
  });

  it("should return 400 for invalid email query", async () => {
    const res = await request(app)
      .get("/public/waitlist/position")
      .query({ email: "not-an-email" })
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
  });

  it("should return 401 without API key", async () => {
    const res = await request(app)
      .get("/public/waitlist/position")
      .query({ email: "noauth@example.com" });

    expect(res.status).toBe(401);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const TEST_ORG_UUID = "660e8400-e29b-41d4-a716-446655440000";

// Mock the DB module before importing routes
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  sql: {},
}));

function createTestAppWithAnonymousOrgs() {
  const app = express();
  app.use(express.json());

  return import("../../src/routes/anonymous-orgs.js").then((mod) => {
    app.use(mod.default);
    app.use((_req, res) => {
      res.status(404).json({ error: "Not found" });
    });
    return app;
  });
}

function getApiKeyHeaders() {
  return {
    "x-api-key": "test_api_key",
    "Content-Type": "application/json",
  };
}

describe("Anonymous Orgs Routes", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createTestAppWithAnonymousOrgs();
  });

  describe("GET /anonymous-orgs", () => {
    it("should reject requests without API key", async () => {
      const res = await request(app)
        .get("/anonymous-orgs?appId=polaritycourse");

      expect(res.status).toBe(401);
    });

    it("should reject requests without appId", async () => {
      const res = await request(app)
        .get("/anonymous-orgs")
        .set(getApiKeyHeaders());

      expect(res.status).toBe(400);
    });
  });

  describe("GET /anonymous-orgs/:id", () => {
    it("should reject requests without API key", async () => {
      const res = await request(app)
        .get(`/anonymous-orgs/${TEST_ORG_UUID}`);

      expect(res.status).toBe(401);
    });

    it("should reject requests with invalid UUID", async () => {
      const res = await request(app)
        .get("/anonymous-orgs/not-a-uuid")
        .set(getApiKeyHeaders());

      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /anonymous-orgs/:id", () => {
    it("should reject requests without API key", async () => {
      const res = await request(app)
        .patch(`/anonymous-orgs/${TEST_ORG_UUID}`)
        .send({ name: "Team A" });

      expect(res.status).toBe(401);
    });

    it("should reject requests with empty body", async () => {
      const res = await request(app)
        .patch(`/anonymous-orgs/${TEST_ORG_UUID}`)
        .set(getApiKeyHeaders())
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("No fields to update");
    });

    it("should reject requests with invalid UUID", async () => {
      const res = await request(app)
        .patch("/anonymous-orgs/not-a-uuid")
        .set(getApiKeyHeaders())
        .send({ name: "Team A" });

      expect(res.status).toBe(400);
    });
  });
});

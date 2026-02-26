import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_ORG_UUID = "660e8400-e29b-41d4-a716-446655440000";

const mockOrg = {
  id: TEST_ORG_UUID,
  appId: "polaritycourse",
  name: "Personal",
  metadata: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

const mockUser = {
  id: TEST_UUID,
  appId: "polaritycourse",
  email: "test@example.com",
  firstName: "John",
  lastName: null,
  imageUrl: null,
  phone: null,
  orgId: TEST_ORG_UUID,
  metadata: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

// Mock the DB module before importing routes
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockOrg]),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockUser]),
        }),
      }),
    }),
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

function createTestAppWithAnonymousUsers() {
  const app = express();
  app.use(express.json());

  return import("../../src/routes/anonymous-users.js").then((mod) => {
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

describe("Anonymous Users Routes", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createTestAppWithAnonymousUsers();
  });

  describe("POST /anonymous-users", () => {
    it("should reject requests without API key", async () => {
      const res = await request(app)
        .post("/anonymous-users")
        .send({ appId: "polaritycourse", email: "test@example.com" });

      expect(res.status).toBe(401);
    });

    it("should reject requests with invalid body", async () => {
      const res = await request(app)
        .post("/anonymous-users")
        .set(getApiKeyHeaders())
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid request body");
    });

    it("should reject requests with invalid email", async () => {
      const res = await request(app)
        .post("/anonymous-users")
        .set(getApiKeyHeaders())
        .send({ appId: "polaritycourse", email: "not-an-email" });

      expect(res.status).toBe(400);
    });

    it("should create anonymous user with auto-created org", async () => {
      const res = await request(app)
        .post("/anonymous-users")
        .set(getApiKeyHeaders())
        .send({ appId: "polaritycourse", email: "test@example.com", firstName: "John" });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.org).toBeDefined();
      expect(res.body.org.name).toBe("Personal");
      expect(res.body).toHaveProperty("created");
    });

    it("should accept imageUrl on create", async () => {
      const res = await request(app)
        .post("/anonymous-users")
        .set(getApiKeyHeaders())
        .send({
          appId: "polaritycourse",
          email: "test@example.com",
          imageUrl: "https://example.com/photo.jpg",
        });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
    });

    it("should reject invalid imageUrl on create", async () => {
      const res = await request(app)
        .post("/anonymous-users")
        .set(getApiKeyHeaders())
        .send({
          appId: "polaritycourse",
          email: "test@example.com",
          imageUrl: "not-a-url",
        });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /anonymous-users", () => {
    it("should reject requests without API key", async () => {
      const res = await request(app)
        .get("/anonymous-users?appId=polaritycourse");

      expect(res.status).toBe(401);
    });

    it("should reject requests without appId", async () => {
      const res = await request(app)
        .get("/anonymous-users")
        .set(getApiKeyHeaders());

      expect(res.status).toBe(400);
    });
  });

  describe("GET /anonymous-users/:id", () => {
    it("should reject requests without API key", async () => {
      const res = await request(app)
        .get(`/anonymous-users/${TEST_UUID}`);

      expect(res.status).toBe(401);
    });

    it("should reject requests with invalid UUID", async () => {
      const res = await request(app)
        .get("/anonymous-users/not-a-uuid")
        .set(getApiKeyHeaders());

      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /anonymous-users/:id", () => {
    it("should reject requests without API key", async () => {
      const res = await request(app)
        .patch(`/anonymous-users/${TEST_UUID}`)
        .send({ firstName: "Jane" });

      expect(res.status).toBe(401);
    });

    it("should reject requests with empty body", async () => {
      const res = await request(app)
        .patch(`/anonymous-users/${TEST_UUID}`)
        .set(getApiKeyHeaders())
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("No fields to update");
    });

    it("should reject requests with invalid UUID", async () => {
      const res = await request(app)
        .patch("/anonymous-users/not-a-uuid")
        .set(getApiKeyHeaders())
        .send({ firstName: "Jane" });

      expect(res.status).toBe(400);
    });

    it("should accept imageUrl on update", async () => {
      const { db } = await import("../../src/db/index.js");
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...mockUser, imageUrl: "https://example.com/photo.jpg" }]),
          }),
        }),
      } as any);

      const res = await request(app)
        .patch(`/anonymous-users/${TEST_UUID}`)
        .set(getApiKeyHeaders())
        .send({ imageUrl: "https://example.com/photo.jpg" });

      expect(res.status).toBe(200);
      expect(res.body.user.imageUrl).toBe("https://example.com/photo.jpg");
    });

    it("should accept null imageUrl on update", async () => {
      const { db } = await import("../../src/db/index.js");
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...mockUser, imageUrl: null }]),
          }),
        }),
      } as any);

      const res = await request(app)
        .patch(`/anonymous-users/${TEST_UUID}`)
        .set(getApiKeyHeaders())
        .send({ imageUrl: null });

      expect(res.status).toBe(200);
      expect(res.body.user.imageUrl).toBeNull();
    });
  });
});

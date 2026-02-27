import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const TEST_ORG_UUID = "660e8400-e29b-41d4-a716-446655440000";

const mockDbOrg = {
  id: TEST_ORG_UUID,
  clerkOrgId: "org_test456",
  appId: null,
  name: null,
  metadata: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn().mockResolvedValue({
    sub: "user_test123",
    org_id: "org_test456",
  }),
  createClerkClient: vi.fn().mockReturnValue({
    users: { getUser: vi.fn() },
  }),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockDbOrg]),
        }),
        returning: vi.fn().mockResolvedValue([mockDbOrg]),
      }),
    }),
  },
  sql: {},
}));

function createTestApp() {
  const app = express();
  app.use(express.json());

  return import("../../src/routes/orgs.js").then((mod) => {
    app.use(mod.default);
    return app;
  });
}

function getAuthHeaders() {
  return { Authorization: "Bearer valid-token" };
}

describe("Orgs Routes", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await createTestApp();
  });

  describe("POST /orgs/sync", () => {
    it("should create org via upsert", async () => {
      const res = await request(app)
        .post("/orgs/sync")
        .set(getAuthHeaders());

      expect(res.status).toBe(200);
      expect(res.body.org).toBeDefined();
      expect(res.body.created).toBe(true);
    });

    it("should return created=false for existing org", async () => {
      const existingOrg = {
        ...mockDbOrg,
        updatedAt: new Date("2024-01-02T00:00:00Z"),
      };
      const { db } = await import("../../src/db/index.js");
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([existingOrg]),
          }),
          returning: vi.fn().mockResolvedValue([existingOrg]),
        }),
      } as any);

      const res = await request(app)
        .post("/orgs/sync")
        .set(getAuthHeaders());

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(false);
    });

    it("should reject requests without auth", async () => {
      const res = await request(app)
        .post("/orgs/sync");

      expect(res.status).toBe(401);
    });
  });
});

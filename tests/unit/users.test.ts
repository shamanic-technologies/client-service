import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";

const mockClerkUser = {
  id: "user_test123",
  firstName: "Test",
  lastName: "User",
  imageUrl: "https://img.clerk.com/test123",
  emailAddresses: [{ emailAddress: "test@example.com" }],
};

const mockDbUser = {
  id: TEST_UUID,
  clerkUserId: "user_test123",
  appId: null,
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
  imageUrl: "https://img.clerk.com/test123",
  phone: null,
  orgId: null,
  metadata: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

const mockGetUser = vi.fn().mockResolvedValue(mockClerkUser);

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn().mockResolvedValue({
    sub: "user_test123",
    org_id: "org_test456",
  }),
  createClerkClient: vi.fn().mockReturnValue({
    users: { getUser: mockGetUser },
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
          returning: vi.fn().mockResolvedValue([mockDbUser]),
        }),
        returning: vi.fn().mockResolvedValue([mockDbUser]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockDbUser]),
        }),
      }),
    }),
  },
  sql: {},
}));

function createTestApp() {
  const app = express();
  app.use(express.json());

  return import("../../src/routes/users.js").then((mod) => {
    app.use(mod.default);
    return app;
  });
}

function getAuthHeaders() {
  return { Authorization: "Bearer valid-token" };
}

describe("Users Routes", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue(mockClerkUser);
    app = await createTestApp();
  });

  describe("POST /users/sync", () => {
    it("should fetch Clerk profile and create user", async () => {
      const res = await request(app)
        .post("/users/sync")
        .set(getAuthHeaders());

      expect(res.status).toBe(200);
      expect(mockGetUser).toHaveBeenCalledWith("user_test123");
      expect(res.body.user).toBeDefined();
      expect(res.body.created).toBe(true);
    });

    it("should sync profile data on existing user", async () => {
      const existingUser = {
        ...mockDbUser,
        updatedAt: new Date("2024-01-02T00:00:00Z"), // different from createdAt → not created
      };
      const { db } = await import("../../src/db/index.js");
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([existingUser]),
          }),
          returning: vi.fn().mockResolvedValue([existingUser]),
        }),
      } as any);

      const res = await request(app)
        .post("/users/sync")
        .set(getAuthHeaders());

      expect(res.status).toBe(200);
      expect(mockGetUser).toHaveBeenCalledWith("user_test123");
      expect(res.body.created).toBe(false);
    });

    it("should handle Clerk user with no email", async () => {
      mockGetUser.mockResolvedValue({
        ...mockClerkUser,
        emailAddresses: [],
      });

      const res = await request(app)
        .post("/users/sync")
        .set(getAuthHeaders());

      expect(res.status).toBe(200);
    });

    it("should reject requests without auth", async () => {
      const res = await request(app)
        .post("/users/sync");

      expect(res.status).toBe(401);
    });
  });
});

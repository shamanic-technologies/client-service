import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the Clerk SDK so no real network/secret is needed.
const { deleteOrgMock, deleteUserMock } = vi.hoisted(() => ({
  deleteOrgMock: vi.fn(),
  deleteUserMock: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    organizations: { deleteOrganization: deleteOrgMock },
    users: { deleteUser: deleteUserMock },
  }),
}));

import { deleteClerkOrganization, deleteClerkUser, ClerkServiceError } from "../../src/lib/clerk-client.js";

describe("deleteClerkOrganization", () => {
  const savedKey = process.env.CLERK_SECRET_KEY;

  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_clerk";
    deleteOrgMock.mockReset();
  });

  afterEach(() => {
    process.env.CLERK_SECRET_KEY = savedKey;
  });

  it("returns 'deleted' when Clerk deletes the org", async () => {
    deleteOrgMock.mockResolvedValueOnce({ id: "org_x", deleted: true });
    const result = await deleteClerkOrganization("org_x");
    expect(result).toBe("deleted");
    expect(deleteOrgMock).toHaveBeenCalledWith("org_x");
  });

  it("returns 'not_found' on a Clerk 404 (already deleted — idempotent)", async () => {
    deleteOrgMock.mockRejectedValueOnce({ status: 404, errors: [{ code: "resource_not_found" }] });
    const result = await deleteClerkOrganization("org_gone");
    expect(result).toBe("not_found");
  });

  it("throws ClerkServiceError (fail loud) on a non-404 Clerk error", async () => {
    deleteOrgMock.mockRejectedValueOnce({ status: 500, errors: [{ message: "clerk down" }] });
    const err = await deleteClerkOrganization("org_x").catch((e) => e);
    expect(err).toBeInstanceOf(ClerkServiceError);
    expect(err.status).toBe(500);
  });

  it("throws when CLERK_SECRET_KEY is not configured", async () => {
    delete process.env.CLERK_SECRET_KEY;
    await expect(deleteClerkOrganization("org_x")).rejects.toThrow("CLERK_SECRET_KEY not configured");
  });
});

describe("deleteClerkUser", () => {
  const savedKey = process.env.CLERK_SECRET_KEY;

  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_clerk";
    deleteUserMock.mockReset();
  });

  afterEach(() => {
    process.env.CLERK_SECRET_KEY = savedKey;
  });

  it("returns 'deleted' when Clerk deletes the user", async () => {
    deleteUserMock.mockResolvedValueOnce({ id: "user_x", deleted: true });
    const result = await deleteClerkUser("user_x");
    expect(result).toBe("deleted");
    expect(deleteUserMock).toHaveBeenCalledWith("user_x");
  });

  it("returns 'not_found' on a Clerk 404 (already deleted — idempotent)", async () => {
    deleteUserMock.mockRejectedValueOnce({ status: 404, errors: [{ code: "resource_not_found" }] });
    const result = await deleteClerkUser("user_gone");
    expect(result).toBe("not_found");
  });

  it("throws ClerkServiceError (fail loud) on a non-404 Clerk error", async () => {
    deleteUserMock.mockRejectedValueOnce({ status: 500, errors: [{ message: "clerk down" }] });
    const err = await deleteClerkUser("user_x").catch((e) => e);
    expect(err).toBeInstanceOf(ClerkServiceError);
    expect(err.status).toBe(500);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the Clerk SDK so no real network/secret is needed.
const { deleteOrgMock, deleteUserMock, createUserMock, createOrgMock } = vi.hoisted(() => ({
  deleteOrgMock: vi.fn(),
  deleteUserMock: vi.fn(),
  createUserMock: vi.fn(),
  createOrgMock: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    organizations: { deleteOrganization: deleteOrgMock, createOrganization: createOrgMock },
    users: { deleteUser: deleteUserMock, createUser: createUserMock },
  }),
}));

import {
  deleteClerkOrganization,
  deleteClerkUser,
  createClerkPhoneAccount,
  syntheticPhoneEmail,
  ClerkServiceError,
} from "../../src/lib/clerk-client.js";

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

describe("createClerkPhoneAccount", () => {
  const savedKey = process.env.CLERK_SECRET_KEY;

  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_clerk";
    createUserMock.mockReset();
    createOrgMock.mockReset();
    deleteUserMock.mockReset();
  });

  afterEach(() => {
    process.env.CLERK_SECRET_KEY = savedKey;
  });

  it("creates a user keyed on a synthetic email (NOT the phone), no password, + an org they administer", async () => {
    createUserMock.mockResolvedValueOnce({ id: "user_ph" });
    createOrgMock.mockResolvedValueOnce({ id: "org_ph" });

    const result = await createClerkPhoneAccount("+15551234567", "WhatsApp +15551234567");

    expect(result).toEqual({ clerkUserId: "user_ph", clerkOrgId: "org_ph" });
    // The phone must NOT be a Clerk sign-in identifier (globally restricted).
    expect(createUserMock).toHaveBeenCalledWith({
      emailAddress: ["wa-15551234567@phone.distribute.you"],
      skipPasswordRequirement: true,
    });
    const createArgs = createUserMock.mock.calls[0][0];
    expect(createArgs).not.toHaveProperty("phoneNumber");
    expect(createOrgMock).toHaveBeenCalledWith({
      name: "WhatsApp +15551234567",
      createdBy: "user_ph",
    });
  });

  it("succeeds for a +33 France phone (unsupported as a Clerk phone identifier)", async () => {
    createUserMock.mockResolvedValueOnce({ id: "user_fr" });
    createOrgMock.mockResolvedValueOnce({ id: "org_fr" });

    const result = await createClerkPhoneAccount("+33612345678", "WhatsApp +33612345678");

    expect(result).toEqual({ clerkUserId: "user_fr", clerkOrgId: "org_fr" });
    expect(createUserMock).toHaveBeenCalledWith({
      emailAddress: ["wa-33612345678@phone.distribute.you"],
      skipPasswordRequirement: true,
    });
    expect(createUserMock.mock.calls[0][0]).not.toHaveProperty("phoneNumber");
  });

  it("derives a deterministic synthetic email from the phone digits", () => {
    expect(syntheticPhoneEmail("+33612345678")).toBe("wa-33612345678@phone.distribute.you");
    expect(syntheticPhoneEmail("+15551234567")).toBe("wa-15551234567@phone.distribute.you");
  });

  it("honors PHONE_ACCOUNT_EMAIL_DOMAIN override", () => {
    const saved = process.env.PHONE_ACCOUNT_EMAIL_DOMAIN;
    process.env.PHONE_ACCOUNT_EMAIL_DOMAIN = "wa.example.test";
    try {
      expect(syntheticPhoneEmail("+33612345678")).toBe("wa-33612345678@wa.example.test");
    } finally {
      if (saved === undefined) delete process.env.PHONE_ACCOUNT_EMAIL_DOMAIN;
      else process.env.PHONE_ACCOUNT_EMAIL_DOMAIN = saved;
    }
  });

  it("cleans up the orphan user + fails loud when org creation fails", async () => {
    createUserMock.mockResolvedValueOnce({ id: "user_orphan" });
    createOrgMock.mockRejectedValueOnce({ status: 422, errors: [{ message: "org bad" }] });
    deleteUserMock.mockResolvedValueOnce({ id: "user_orphan", deleted: true });

    const err = await createClerkPhoneAccount("+15551234567", "n").catch((e) => e);

    expect(err).toBeInstanceOf(ClerkServiceError);
    expect(err.status).toBe(422);
    expect(deleteUserMock).toHaveBeenCalledWith("user_orphan");
  });

  it("fails loud when user creation itself fails (no cleanup needed)", async () => {
    createUserMock.mockRejectedValueOnce({ status: 500, errors: [{ message: "clerk down" }] });
    const err = await createClerkPhoneAccount("+15551234567", "n").catch((e) => e);
    expect(err).toBeInstanceOf(ClerkServiceError);
    expect(err.status).toBe(500);
    expect(deleteUserMock).not.toHaveBeenCalled();
    expect(createOrgMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs, users } from "../../src/db/schema.js";
import { deleteClerkOrganization, deleteClerkUser } from "../../src/lib/clerk-client.js";
import { deleteStripeCustomerByOrg } from "../../src/lib/stripe-service-client.js";
import {
  deleteBillingByOrg,
  deleteCampaignsByOrg,
  deleteKeysByOrg,
  deleteRunsByOrg,
} from "../../src/lib/internal-service-client.js";

// Mock the external-provider clients but keep the real error classes. The DB
// cascade runs against the real test DB.
vi.mock("../../src/lib/clerk-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/clerk-client.js")>();
  return { ...actual, deleteClerkOrganization: vi.fn(), deleteClerkUser: vi.fn() };
});
vi.mock("../../src/lib/stripe-service-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/stripe-service-client.js")>();
  return { ...actual, deleteStripeCustomerByOrg: vi.fn() };
});
vi.mock("../../src/lib/internal-service-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/internal-service-client.js")>();
  return {
    ...actual,
    deleteBillingByOrg: vi.fn(),
    deleteCampaignsByOrg: vi.fn(),
    deleteRunsByOrg: vi.fn(),
    deleteKeysByOrg: vi.fn(),
  };
});

const API_KEY = "test_api_key";

describe("DELETE /internal/orgs/by-external/:externalOrgId (teardown by Clerk org id)", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    vi.mocked(deleteBillingByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteCampaignsByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteRunsByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteKeysByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteStripeCustomerByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteClerkOrganization).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteClerkUser).mockReset().mockResolvedValue("deleted");
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("resolves external->internal and runs the full cascade incl. Clerk users", async () => {
    const org = await insertTestOrg({ externalId: "org_ext_teardown", name: "Ext Co" });
    await insertTestUser({ externalId: "user_a", orgId: org.id });
    await insertTestUser({ externalId: "user_b", orgId: org.id });

    const res = await request(app)
      .delete("/internal/orgs/by-external/org_ext_teardown")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    // Summary reports the resolved INTERNAL uuid, not the Clerk id
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.clientService).toEqual({ orgs: 1, users: 2, invites: 0 });
    expect(res.body.clerk).toBe("deleted");
    expect(res.body.clerkUsers).toEqual({ deleted: 2, notFound: 0 });

    // Producers + Stripe keyed by the resolved internal UUID
    expect(vi.mocked(deleteBillingByOrg)).toHaveBeenCalledWith(org.id);
    expect(vi.mocked(deleteStripeCustomerByOrg)).toHaveBeenCalledWith(org.id);
    // Clerk org keyed by external id; users keyed by their Clerk user ids
    expect(vi.mocked(deleteClerkOrganization)).toHaveBeenCalledWith("org_ext_teardown");
    expect(vi.mocked(deleteClerkUser)).toHaveBeenCalledWith("user_a");
    expect(vi.mocked(deleteClerkUser)).toHaveBeenCalledWith("user_b");

    const remainingOrg = await db.select().from(orgs).where(eq(orgs.id, org.id));
    const remainingUsers = await db.select().from(users).where(eq(users.orgId, org.id));
    expect(remainingOrg).toHaveLength(0);
    expect(remainingUsers).toHaveLength(0);
  });

  it("returns 404 for an unknown external id and creates NOTHING", async () => {
    const res = await request(app)
      .delete("/internal/orgs/by-external/org_does_not_exist")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(404);

    // Read-only resolution: no org row was created for the unknown external id
    const created = await db.select().from(orgs).where(eq(orgs.externalId, "org_does_not_exist"));
    expect(created).toHaveLength(0);
    const allOrgs = await db.select().from(orgs);
    expect(allOrgs).toHaveLength(0);

    // No cascade ran
    expect(vi.mocked(deleteBillingByOrg)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteStripeCustomerByOrg)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteClerkOrganization)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteClerkUser)).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run after the org is gone returns 404 (already torn down)", async () => {
    const org = await insertTestOrg({ externalId: "org_ext_idem" });
    await insertTestUser({ externalId: "user_idem", orgId: org.id });

    const first = await request(app)
      .delete("/internal/orgs/by-external/org_ext_idem")
      .set("x-api-key", API_KEY);
    expect(first.status).toBe(200);
    expect(first.body.clientService.orgs).toBe(1);

    const second = await request(app)
      .delete("/internal/orgs/by-external/org_ext_idem")
      .set("x-api-key", API_KEY);
    // The org row is gone, so external->internal resolution 404s (nothing recreated)
    expect(second.status).toBe(404);
    const allOrgs = await db.select().from(orgs);
    expect(allOrgs).toHaveLength(0);
  });

  it("returns 401 without an API key", async () => {
    const res = await request(app).delete("/internal/orgs/by-external/org_x");
    expect(res.status).toBe(401);
  });
});

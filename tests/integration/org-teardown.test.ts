import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs, users, invites } from "../../src/db/schema.js";
import { deleteClerkOrganization, ClerkServiceError } from "../../src/lib/clerk-client.js";
import { deleteStripeCustomerByOrg, StripeServiceError } from "../../src/lib/stripe-service-client.js";
import {
  deleteBillingByOrg,
  deleteCampaignsByOrg,
  deleteKeysByOrg,
  deleteRunsByOrg,
  InternalServiceTeardownError,
} from "../../src/lib/internal-service-client.js";

// Mock the external-provider clients but keep the real error classes (needed
// for the route's instanceof checks). The DB cascade runs against the real test DB.
vi.mock("../../src/lib/clerk-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/clerk-client.js")>();
  return { ...actual, deleteClerkOrganization: vi.fn() };
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

describe("DELETE /internal/orgs/:orgId (cascade teardown)", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    vi.mocked(deleteBillingByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteCampaignsByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteRunsByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteKeysByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteStripeCustomerByOrg).mockReset().mockResolvedValue("deleted");
    vi.mocked(deleteClerkOrganization).mockReset().mockResolvedValue("deleted");
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("tears down client-service data + Clerk + Stripe, returns JSON result", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_teardown", name: "Teardown Co" });
    await insertTestUser({ externalId: "u1", email: "a@t.com", orgId: org.id });
    await insertTestUser({ externalId: "u2", email: "b@t.com", orgId: org.id });
    const invitee = await insertTestOrg({ externalId: "org_invitee" });
    await db.insert(invites).values({
      inviterOrgId: org.id,
      inviteeOrgId: invitee.id,
      code: "teardown-co",
      status: "signed_up",
      signedUpAt: new Date(),
    });

    const res = await request(app)
      .delete(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgId: org.id,
      clientService: { orgs: 1, users: 2, invites: 1 },
      billing: "deleted",
      campaign: "deleted",
      runs: "deleted",
      key: "deleted",
      stripe: "deleted",
      clerk: "deleted",
    });

    // Rows actually gone
    const remainingOrg = await db.select().from(orgs).where(eq(orgs.id, org.id));
    const remainingUsers = await db.select().from(users).where(eq(users.orgId, org.id));
    expect(remainingOrg).toHaveLength(0);
    expect(remainingUsers).toHaveLength(0);
  });

  it("calls producers with the internal UUID before Stripe and Clerk", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_xyz" });

    await request(app).delete(`/internal/orgs/${org.id}`).set("x-api-key", API_KEY);

    expect(vi.mocked(deleteBillingByOrg)).toHaveBeenCalledWith(org.id);
    expect(vi.mocked(deleteCampaignsByOrg)).toHaveBeenCalledWith(org.id);
    expect(vi.mocked(deleteRunsByOrg)).toHaveBeenCalledWith(org.id);
    expect(vi.mocked(deleteKeysByOrg)).toHaveBeenCalledWith(org.id);
    expect(vi.mocked(deleteStripeCustomerByOrg)).toHaveBeenCalledWith(org.id);
    expect(vi.mocked(deleteClerkOrganization)).toHaveBeenCalledWith("org_clerk_xyz");

    expect(vi.mocked(deleteBillingByOrg).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteStripeCustomerByOrg).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(deleteCampaignsByOrg).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteStripeCustomerByOrg).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(deleteRunsByOrg).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteStripeCustomerByOrg).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(deleteKeysByOrg).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteStripeCustomerByOrg).mock.invocationCallOrder[0],
    );
  });

  it("is idempotent: unknown org returns 200 with zero rows", async () => {
    const ghost = randomId();

    const res = await request(app)
      .delete(`/internal/orgs/${ghost}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.clientService).toEqual({ orgs: 0, users: 0, invites: 0 });
    expect(res.body.clerk).toBe("not_found"); // no row => no external_id => Clerk skipped
    expect(vi.mocked(deleteBillingByOrg)).toHaveBeenCalledWith(ghost);
    expect(vi.mocked(deleteCampaignsByOrg)).toHaveBeenCalledWith(ghost);
    expect(vi.mocked(deleteRunsByOrg)).toHaveBeenCalledWith(ghost);
    expect(vi.mocked(deleteKeysByOrg)).toHaveBeenCalledWith(ghost);
    // Stripe still called defensively with the inbound UUID
    expect(vi.mocked(deleteStripeCustomerByOrg)).toHaveBeenCalledWith(ghost);
  });

  it("fails loud (502) when a producer errors — does NOT delete downstream/local state", async () => {
    const org = await insertTestOrg({ externalId: "org_billing_fail" });
    await insertTestUser({ externalId: "u-bf", orgId: org.id });
    vi.mocked(deleteBillingByOrg).mockRejectedValueOnce(
      new InternalServiceTeardownError("billing", 500, "billing boom"),
    );

    const res = await request(app)
      .delete(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(502);
    expect(res.body.provider).toBe("billing");
    expect(res.body.upstreamStatus).toBe(500);
    expect(res.body.upstreamBody).toBe("billing boom");

    expect(vi.mocked(deleteStripeCustomerByOrg)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteClerkOrganization)).not.toHaveBeenCalled();
    const remainingOrg = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(remainingOrg).toHaveLength(1);
  });

  it("fails loud (502) when stripe-service errors — does NOT delete client-service data", async () => {
    const org = await insertTestOrg({ externalId: "org_stripe_fail" });
    await insertTestUser({ externalId: "u-sf", orgId: org.id });
    vi.mocked(deleteStripeCustomerByOrg).mockRejectedValueOnce(new StripeServiceError(500, "stripe boom"));

    const res = await request(app)
      .delete(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(502);
    expect(res.body.provider).toBe("stripe");
    expect(res.body.upstreamStatus).toBe(500);
    expect(res.body.upstreamBody).toBe("stripe boom");

    // Stripe runs before Clerk + DB — org row preserved for retry
    expect(vi.mocked(deleteClerkOrganization)).not.toHaveBeenCalled();
    const remainingOrg = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(remainingOrg).toHaveLength(1);
  });

  it("fails loud (502) when Clerk errors — does NOT delete client-service data", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_fail" });
    vi.mocked(deleteClerkOrganization).mockRejectedValueOnce(new ClerkServiceError(500, "clerk boom"));

    const res = await request(app)
      .delete(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(502);
    expect(res.body.provider).toBe("clerk");
    expect(res.body.upstreamStatus).toBe(500);

    // Clerk is step 2 (before DB) — org row preserved for retry
    const remainingOrg = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(remainingOrg).toHaveLength(1);
  });

  it("treats Clerk 404 as not_found and still cascades the DB delete", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_404" });
    await insertTestUser({ externalId: "u-404", orgId: org.id });
    vi.mocked(deleteClerkOrganization).mockResolvedValueOnce("not_found");

    const res = await request(app)
      .delete(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.clerk).toBe("not_found");
    expect(res.body.clientService.orgs).toBe(1);
    const remainingOrg = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(remainingOrg).toHaveLength(0);
  });

  it("unlinks (does not delete) an invite where the torn-down org is the invitee", async () => {
    const inviter = await insertTestOrg({ externalId: "org_inviter_keep" });
    const invitee = await insertTestOrg({ externalId: "org_invitee_teardown" });
    await db.insert(invites).values({
      inviterOrgId: inviter.id,
      inviteeOrgId: invitee.id,
      code: "inviter-keep",
      status: "signed_up",
      signedUpAt: new Date(),
    });

    const res = await request(app)
      .delete(`/internal/orgs/${invitee.id}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.clientService.invites).toBe(0); // invitee is not the inviter — nothing deleted

    // Inviter's invite row preserved, invitee unlinked
    const inviterInvites = await db.select().from(invites).where(eq(invites.inviterOrgId, inviter.id));
    expect(inviterInvites).toHaveLength(1);
    expect(inviterInvites[0].inviteeOrgId).toBeNull();

    // Invitee org gone
    const remainingInvitee = await db.select().from(orgs).where(eq(orgs.id, invitee.id));
    expect(remainingInvitee).toHaveLength(0);
  });

  it("returns 400 for a non-UUID orgId", async () => {
    const res = await request(app)
      .delete("/internal/orgs/not-a-uuid")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid parameters");
  });

  it("returns 401 without an API key", async () => {
    const res = await request(app).delete(`/internal/orgs/${randomId()}`);
    expect(res.status).toBe(401);
  });
});

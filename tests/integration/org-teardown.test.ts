import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs, users, invites } from "../../src/db/schema.js";
import { deleteClerkOrganization, ClerkServiceError } from "../../src/lib/clerk-client.js";
import { deleteStripeCustomerByOrg, StripeServiceError } from "../../src/lib/stripe-service-client.js";

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

const API_KEY = "test_api_key";

describe("DELETE /internal/orgs/:orgId (cascade teardown)", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
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
      clerk: "deleted",
      stripe: "deleted",
    });

    // Rows actually gone
    const remainingOrg = await db.select().from(orgs).where(eq(orgs.id, org.id));
    const remainingUsers = await db.select().from(users).where(eq(users.orgId, org.id));
    expect(remainingOrg).toHaveLength(0);
    expect(remainingUsers).toHaveLength(0);
  });

  it("calls Clerk with external_id and stripe-service with the internal UUID", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_xyz" });

    await request(app).delete(`/internal/orgs/${org.id}`).set("x-api-key", API_KEY);

    expect(vi.mocked(deleteStripeCustomerByOrg)).toHaveBeenCalledWith(org.id);
    expect(vi.mocked(deleteClerkOrganization)).toHaveBeenCalledWith("org_clerk_xyz");
  });

  it("is idempotent: unknown org returns 200 with zero rows", async () => {
    const ghost = randomId();

    const res = await request(app)
      .delete(`/internal/orgs/${ghost}`)
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.clientService).toEqual({ orgs: 0, users: 0, invites: 0 });
    expect(res.body.clerk).toBe("not_found"); // no row => no external_id => Clerk skipped
    // Stripe still called defensively with the inbound UUID
    expect(vi.mocked(deleteStripeCustomerByOrg)).toHaveBeenCalledWith(ghost);
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

    // Stripe is step 1 — Clerk + DB untouched, org row preserved for retry
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

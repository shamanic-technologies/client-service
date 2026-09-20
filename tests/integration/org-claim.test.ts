import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb, randomId } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs, users, invites } from "../../src/db/schema.js";

const API_KEY = "test_api_key";

process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand_key";
process.env.STRIPE_SERVICE_URL = "http://stripe.test";
process.env.STRIPE_SERVICE_API_KEY = "stripe_key";

/** What the rest of the fleet says about the org holding an identity. */
type Fleet = {
  brands: Array<{ id: string; orgId: string; domain: string | null; name: string }>;
  payments: Array<{ currency: string; amount_received: number }>;
  brandStatus: number;
  stripeStatus: number;
};

let fleet: Fleet;

function stubFleet() {
  fleet = { brands: [], payments: [], brandStatus: 200, stripeStatus: 200 };

  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/internal/brands/all")) {
      if (fleet.brandStatus !== 200) {
        return new Response("brand-service down", { status: fleet.brandStatus });
      }
      return Response.json({ brands: fleet.brands });
    }

    if (url.includes("/internal/payment_summary/by-org/")) {
      if (fleet.stripeStatus !== 200) {
        return new Response("stripe-service down", { status: fleet.stripeStatus });
      }
      return Response.json({ totals: fleet.payments });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });
}

/**
 * Claiming is the one transition anonymous -> identified. What it must never do
 * is move anything: the internal uuid stays, so every reference taken while the
 * visitor was signed out keeps resolving.
 */
describe("POST /internal/orgs/:orgId/claim", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    stubFleet();
  });

  // The db connection is shared across this file; only the last describe closes it.
  afterAll(async () => {
    await cleanTestData();
  });

  async function anonymousOrg(externalId = `anon-${randomId()}`) {
    return insertTestOrg({ externalId, anonymousAt: new Date(), name: "Anonymous visitor" });
  }

  it("attaches the identity, keeps the internal uuid, and makes the signer-up a member", async () => {
    const org = await anonymousOrg();

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org_clerk_new",
        externalUserId: "user_clerk_new",
        email: "founder@example.com",
        orgName: "Acme Inc",
      });

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(org.id);
    expect(res.body.externalOrgId).toBe("org_clerk_new");
    expect(res.body.alreadyClaimed).toBe(false);
    expect(res.body.claimedAt).toBeTruthy();

    // Same org row, now resolving by the identity-provider id.
    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.externalId).toBe("org_clerk_new");
    expect(row.name).toBe("Acme Inc");
    expect(row.anonymousAt).not.toBeNull();
    expect(row.claimedAt).not.toBeNull();

    const [byExternal] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.externalId, "org_clerk_new"));
    expect(byExternal.id).toBe(org.id);

    // The person signing up is a member the way any member is.
    const [user] = await db.select().from(users).where(eq(users.externalId, "user_clerk_new"));
    expect(user.orgId).toBe(org.id);
    expect(user.id).toBe(res.body.userId);
  });

  it("leaves every reference taken before the call pointing at the same org", async () => {
    const org = await anonymousOrg();
    // Stand-in for the work done while signed out: a row written against the
    // internal uuid by another service (here, a user of the anonymous org).
    const visitor = await insertTestUser({ externalId: `anon-user-${randomId()}`, orgId: org.id });

    await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_keeps", externalUserId: "user_clerk_keeps" });

    const [stillThere] = await db.select().from(users).where(eq(users.id, visitor.id));
    expect(stillThere.orgId).toBe(org.id);

    const res = await request(app)
      .get(`/internal/orgs/${org.id}`)
      .set("x-api-key", API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.externalId).toBe("org_clerk_keeps");
  });

  it("is harmless called twice with the same inputs", async () => {
    const org = await anonymousOrg();
    const body = { externalOrgId: "org_clerk_twice", externalUserId: "user_clerk_twice" };

    const first = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send(body);
    const second = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.alreadyClaimed).toBe(true);
    expect(second.body.orgId).toBe(first.body.orgId);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.claimedAt).toBe(first.body.claimedAt);

    const allOrgs = await db.select().from(orgs);
    expect(allOrgs).toHaveLength(1);
    const allUsers = await db.select().from(users);
    expect(allUsers).toHaveLength(1);
  });

  it("refuses an org that already carries a different identity, distinguishably", async () => {
    const org = await anonymousOrg();
    await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_first", externalUserId: "user_clerk_first" });

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_second", externalUserId: "user_clerk_second" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("org_already_claimed");

    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.externalId).toBe("org_clerk_first");
  });

  it("refuses an identity a SOMEBODY'S org already uses, distinguishably", async () => {
    const org = await anonymousOrg();
    // Somebody else's signed-out walk, on the same identity. Theirs, so untouchable.
    const theirs = await insertTestOrg({ externalId: "org_clerk_taken", anonymousAt: new Date() });

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_taken", externalUserId: "user_clerk_x" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("external_id_taken");

    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.claimedAt).toBeNull();
    const [untouched] = await db.select().from(orgs).where(eq(orgs.id, theirs.id));
    expect(untouched.externalId).toBe("org_clerk_taken");
    expect(untouched.absorbedAt).toBeNull();
  });

  it("refuses an org that was never a throwaway one, distinguishably", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_real" });

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_other", externalUserId: "user_clerk_y" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("org_not_anonymous");

    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.externalId).toBe("org_clerk_real");
  });

  it("404s an unknown org, distinguishably", async () => {
    const res = await request(app)
      .post(`/internal/orgs/${randomId()}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_z", externalUserId: "user_clerk_z" });

    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("org_not_found");
  });

  it("400s an invalid orgId and an incomplete body", async () => {
    const badId = await request(app)
      .post("/internal/orgs/not-a-uuid/claim")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_a", externalUserId: "user_a" });
    expect(badId.status).toBe(400);
    expect(badId.body.reason).toBe("invalid_request");

    const org = await anonymousOrg();
    const badBody = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_a" });
    expect(badBody.status).toBe(400);
    expect(badBody.body.reason).toBe("invalid_request");
  });

  it("401s without the API key", async () => {
    const org = await anonymousOrg();
    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .send({ externalOrgId: "org_a", externalUserId: "user_a" });
    expect(res.status).toBe(401);
  });

  it("moves a user who already exists onto the claimed org rather than duplicating them", async () => {
    const org = await anonymousOrg();
    const existing = await insertTestUser({ externalId: "user_clerk_existing" });

    const res = await request(app)
      .post(`/internal/orgs/${org.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_m", externalUserId: "user_clerk_existing" });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(existing.id);

    const rows = await db.select().from(users).where(eq(users.externalId, "user_clerk_existing"));
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(org.id);
  });
});

/**
 * The race that broke every real signup: an authenticated read resolves the
 * identity the visitor just created, an org comes into being for it, and the
 * claim that arrives a second later finds its own customer's identity "taken".
 *
 * That second row is an artifact of a read, not an organisation anybody decided
 * on. The claim may take the identity off it — and only off it.
 */
describe("POST /internal/orgs/:orgId/claim — an identity held by a shell", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
    stubFleet();
  });

  afterAll(async () => {
    await cleanTestData();
    vi.unstubAllGlobals();
  });

  async function anonymousOrg() {
    return insertTestOrg({ externalId: `anon-${randomId()}`, anonymousAt: new Date() });
  }

  /** What `POST /internal/resolve` leaves behind: an org, and the reader in it. */
  async function shellHolding(externalOrgId: string, externalUserId: string) {
    const shell = await insertTestOrg({ externalId: externalOrgId, name: "Read artifact" });
    await insertTestUser({ externalId: externalUserId, orgId: shell.id });
    return shell;
  }

  it("gives the customer the org holding their work, and makes them a member of it", async () => {
    const work = await anonymousOrg();
    const reader = await insertTestUser({ externalId: "anon_visitor", orgId: work.id });
    const shell = await shellHolding("org_clerk_race", "user_clerk_race");

    const res = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({
        externalOrgId: "org_clerk_race",
        externalUserId: "user_clerk_race",
        email: "htkiro@example.com",
      });

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(work.id);
    expect(res.body.absorbedOrgId).toBe(shell.id);

    // The identity now resolves to the org that holds the work.
    const [claimed] = await db.select().from(orgs).where(eq(orgs.id, work.id));
    expect(claimed.externalId).toBe("org_clerk_race");
    expect(claimed.claimedAt).not.toBeNull();

    // They are a member of it.
    const [member] = await db.select().from(users).where(eq(users.externalId, "user_clerk_race"));
    expect(member.orgId).toBe(work.id);
    expect(member.id).toBe(res.body.userId);

    // The shell kept its uuid and its rows; it simply stopped answering to an
    // identity that was never its.
    const [absorbed] = await db.select().from(orgs).where(eq(orgs.id, shell.id));
    expect(absorbed.externalId).toBeNull();
    expect(absorbed.absorbedIntoOrgId).toBe(work.id);
    expect(absorbed.absorbedAt).not.toBeNull();

    // Nothing that pointed at the claimed org moved.
    const [stillThere] = await db.select().from(users).where(eq(users.id, reader.id));
    expect(stillThere.orgId).toBe(work.id);
  });

  it("is still idempotent: the replay answers success and absorbs nothing twice", async () => {
    const work = await anonymousOrg();
    const shell = await shellHolding("org_clerk_replay", "user_clerk_replay");
    const body = { externalOrgId: "org_clerk_replay", externalUserId: "user_clerk_replay" };

    const first = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send(body);
    const second = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.alreadyClaimed).toBe(true);
    expect(second.body.claimedAt).toBe(first.body.claimedAt);
    expect(second.body.absorbedOrgId).toBeUndefined();

    const [absorbed] = await db.select().from(orgs).where(eq(orgs.id, shell.id));
    expect(absorbed.absorbedIntoOrgId).toBe(work.id);
  });

  it("refuses when the holder has a member who is not the person signing up", async () => {
    const work = await anonymousOrg();
    const holder = await shellHolding("org_clerk_team", "user_clerk_team");
    await insertTestUser({ externalId: "user_clerk_colleague", orgId: holder.id });

    const res = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_team", externalUserId: "user_clerk_team" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("external_id_taken");
    const [untouched] = await db.select().from(orgs).where(eq(orgs.id, holder.id));
    expect(untouched.externalId).toBe("org_clerk_team");
  });

  it("refuses when the holder carries state of its own", async () => {
    const work = await anonymousOrg();
    const holder = await shellHolding("org_clerk_invited", "user_clerk_invited");
    await db.insert(invites).values({
      inviterOrgId: holder.id,
      code: `code-${randomId()}`,
      status: "pending",
    });

    const res = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_invited", externalUserId: "user_clerk_invited" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("external_id_taken");
  });

  it("refuses when somebody built a brand in the holder", async () => {
    const work = await anonymousOrg();
    const holder = await shellHolding("org_clerk_brand", "user_clerk_brand");
    fleet.brands = [
      { id: randomId(), orgId: holder.id, domain: "theirs.com", name: "Theirs" },
    ];

    const res = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_brand", externalUserId: "user_clerk_brand" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("external_id_taken");
  });

  it("refuses when the holder has paid real money in", async () => {
    const work = await anonymousOrg();
    await shellHolding("org_clerk_paid", "user_clerk_paid");
    fleet.payments = [{ currency: "usd", amount_received: 4900 }];

    const res = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_paid", externalUserId: "user_clerk_paid" });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("external_id_taken");
  });

  it("refuses an anonymous holder and an already-claimed one, whatever the fleet says", async () => {
    const work = await anonymousOrg();
    await insertTestOrg({ externalId: "org_clerk_theirs", anonymousAt: new Date() });

    const anonymousHolder = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_theirs", externalUserId: "user_clerk_t" });

    expect(anonymousHolder.status).toBe(409);
    expect(anonymousHolder.body.reason).toBe("external_id_taken");

    const other = await anonymousOrg();
    await request(app)
      .post(`/internal/orgs/${other.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_mine", externalUserId: "user_clerk_mine" });

    const claimedHolder = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_mine", externalUserId: "user_clerk_someone" });

    expect(claimedHolder.status).toBe(409);
    expect(claimedHolder.body.reason).toBe("external_id_taken");
  });

  it("refuses LOUDLY when it cannot find out whether the holder is empty", async () => {
    const work = await anonymousOrg();
    const holder = await shellHolding("org_clerk_unknown", "user_clerk_unknown");
    fleet.brandStatus = 503;

    const res = await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_unknown", externalUserId: "user_clerk_unknown" });

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("identity_holder_unverifiable");

    const [untouched] = await db.select().from(orgs).where(eq(orgs.id, holder.id));
    expect(untouched.externalId).toBe("org_clerk_unknown");
    const [unclaimed] = await db.select().from(orgs).where(eq(orgs.id, work.id));
    expect(unclaimed.claimedAt).toBeNull();
  });

  it("stops calling a shell real once it has handed its identity over", async () => {
    const work = await anonymousOrg();
    const shell = await shellHolding("org_clerk_reality", "user_clerk_reality");

    await request(app)
      .post(`/internal/orgs/${work.id}/claim`)
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_reality", externalUserId: "user_clerk_reality" });

    const res = await request(app)
      .post("/internal/orgs/real")
      .set("x-api-key", API_KEY)
      .send({ orgIds: [work.id, shell.id] });

    expect(res.status).toBe(200);
    expect(res.body.realOrgIds).toEqual([work.id]);
  });
});

/**
 * Anonymity is a fact we RECORD at creation, never one we infer by looking at
 * what the external id happens to be.
 */
describe("POST /internal/resolve — the anonymous marker", () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanTestData();
  });

  afterAll(async () => {
    await cleanTestData();
    await closeDb();
  });

  it("marks the org it creates when the caller declares it anonymous", async () => {
    const res = await request(app)
      .post("/internal/resolve")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "anon_abc", externalUserId: "anon_user_abc", anonymous: true });

    expect(res.status).toBe(200);
    const [org] = await db.select().from(orgs).where(eq(orgs.id, res.body.orgId));
    expect(org.anonymousAt).not.toBeNull();
    expect(org.claimedAt).toBeNull();
  });

  it("leaves the org unmarked when the caller says nothing", async () => {
    const res = await request(app)
      .post("/internal/resolve")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_plain", externalUserId: "user_clerk_plain" });

    const [org] = await db.select().from(orgs).where(eq(orgs.id, res.body.orgId));
    expect(org.anonymousAt).toBeNull();
  });

  it("never re-labels an existing real org as anonymous", async () => {
    const org = await insertTestOrg({ externalId: "org_clerk_real2" });

    await request(app)
      .post("/internal/resolve")
      .set("x-api-key", API_KEY)
      .send({ externalOrgId: "org_clerk_real2", externalUserId: "user_clerk_real2", anonymous: true });

    const [row] = await db.select().from(orgs).where(eq(orgs.id, org.id));
    expect(row.anonymousAt).toBeNull();
  });
});

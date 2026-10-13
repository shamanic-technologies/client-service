import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import request from "supertest";

// The identity provider is mocked at the SDK boundary; key-service is stubbed on fetch.
const { orgListMock, userListMock } = vi.hoisted(() => ({
  orgListMock: vi.fn(),
  userListMock: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    organizations: { getOrganizationList: orgListMock },
    users: { getUserList: userListMock },
  }),
}));

import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, insertTestOrg, insertTestUser, closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { orgs, signupFactUnresolved, users } from "../../src/db/schema.js";
import { DISTRIBUTE_YOU_BRAND_ID } from "../../src/lib/signup-facts.js";
import { eq, sql } from "drizzle-orm";

const API_KEY = "test_api_key";

afterAll(async () => {
  await cleanTestData();
  await closeDb();
});

/** Clerk knows these orgs (id → creator) and these users. */
function clerkKnows(orgCreators: Record<string, string | null>, people: Record<string, { email: string; firstName?: string; lastName?: string }>) {
  orgListMock.mockImplementation(async ({ organizationId }: { organizationId: string[] }) => ({
    data: organizationId.filter((id) => id in orgCreators).map((id) => ({ id, createdBy: orgCreators[id] })),
  }));
  userListMock.mockImplementation(async ({ userId }: { userId: string[] }) => ({
    data: userId
      .filter((id) => id in people)
      .map((id) => ({
        id,
        primaryEmailAddress: { emailAddress: people[id].email },
        firstName: people[id].firstName ?? null,
        lastName: people[id].lastName ?? null,
      })),
  }));
}

describe("signup facts", () => {
  const app = createTestApp();
  const reconcile = () => request(app).post("/internal/signup-facts/reconcile").set("x-api-key", API_KEY);
  const feed = (q = "") => request(app).get(`/internal/signup-facts${q}`).set("x-api-key", API_KEY);

  beforeEach(async () => {
    await cleanTestData();
    orgListMock.mockReset();
    userListMock.mockReset();
    process.env.KEY_SERVICE_URL = "https://key.test";
    process.env.KEY_SERVICE_API_KEY = "key_key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ provider: "clerk", key: "sk_test" }) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("backfills one signup per REAL org, naming the person who created it and the distribute.you brand", async () => {
    const ordinary = await insertTestOrg({ externalId: "org_ordinary" });
    const claimedAt = new Date("2026-10-01T10:00:00Z");
    const claimed = await insertTestOrg({ externalId: "org_claimed", anonymousAt: new Date("2026-09-30T10:00:00Z"), claimedAt });
    await insertTestOrg({ externalId: "anon_walk", anonymousAt: new Date() }); // never claimed: not a signup
    const shell = await insertTestOrg({ externalId: "org_shell_tmp" });
    await db
      .update(orgs)
      .set({ externalId: null, absorbedIntoOrgId: claimed.id, absorbedAt: new Date() })
      .where(eq(orgs.id, shell.id)); // absorbed shell: not a signup
    const goneAtClerk = await insertTestOrg({ externalId: "org_gone" });
    const phoneOrg = await insertTestOrg({ externalId: "org_phone" });
    const alice = await insertTestUser({ externalId: "user_alice", email: "alice@acme.com", orgId: claimed.id });
    await insertTestUser({ externalId: "user_wa", orgId: phoneOrg.id });
    await db.update(users).set({ phone: "+33612345678" }).where(eq(users.externalId, "user_wa"));

    clerkKnows(
      { org_ordinary: "user_bob", org_claimed: "user_alice", org_phone: "user_wa" },
      {
        user_bob: { email: "bob@bobco.com", firstName: "Bob", lastName: "Stone" },
        user_alice: { email: "alice@acme.com", firstName: "Alice" },
        user_wa: { email: "wa-33612345678@phone.distribute.you" },
      },
    );

    const res = await reconcile();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stated: 3, withdrawn: 0, unresolved: 1 });

    const page = await feed();
    expect(page.status).toBe(200);
    expect(page.body.hasMore).toBe(false);
    const facts = page.body.facts;
    expect(facts).toHaveLength(3);
    expect(facts.every((f: { brandId: string; type: string }) => f.brandId === DISTRIBUTE_YOU_BRAND_ID && f.type === "signup")).toBe(true);
    expect(facts.map((f: { seq: number }) => f.seq)).toEqual([...facts.map((f: { seq: number }) => f.seq)].sort((a, b) => a - b));

    const byOrg = new Map(facts.map((f: { customerOrgId: string }) => [f.customerOrgId, f]));
    expect(byOrg.get(claimed.id)).toMatchObject({
      clerkOrgId: "org_claimed",
      clerkUserId: "user_alice",
      userId: alice.id,
      email: "alice@acme.com",
      fullName: "Alice",
      occurredAt: claimedAt.toISOString(),
      dateBasis: "org_claimed_at",
      withdrawnOf: null,
    });
    expect(byOrg.get(ordinary.id)).toMatchObject({
      clerkUserId: "user_bob",
      userId: null, // no row of ours for Bob: still his signup
      email: "bob@bobco.com",
      fullName: "Bob Stone",
      occurredAt: ordinary.createdAt.toISOString(),
      dateBasis: "org_created_at",
    });
    // A phone-origin account's address is a placeholder: the fact carries the phone instead.
    expect(byOrg.get(phoneOrg.id)).toMatchObject({ email: null, phone: "+33612345678" });
    expect(byOrg.has(goneAtClerk.id)).toBe(false);

    const [skip] = await db.select().from(signupFactUnresolved).where(eq(signupFactUnresolved.orgId, goneAtClerk.id));
    expect(skip.reason).toBe("identity_provider_org_not_found");
  });

  it("a second pass states nothing and asks the identity provider nothing", async () => {
    await insertTestOrg({ externalId: "org_one" });
    await insertTestOrg({ externalId: "org_gone" });
    clerkKnows({ org_one: "user_one" }, { user_one: { email: "one@x.com" } });
    expect((await reconcile()).body).toEqual({ stated: 1, withdrawn: 0, unresolved: 1 });

    orgListMock.mockClear();
    userListMock.mockClear();
    expect((await reconcile()).body).toEqual({ stated: 0, withdrawn: 0, unresolved: 0 });
    expect(orgListMock).not.toHaveBeenCalled();
    expect(userListMock).not.toHaveBeenCalled();
  });

  it("an unresolvable org is looked at again once a day", async () => {
    const gone = await insertTestOrg({ externalId: "org_gone" });
    clerkKnows({}, {});
    expect((await reconcile()).body.unresolved).toBe(1);
    await db
      .update(signupFactUnresolved)
      .set({ checkedAt: new Date(Date.now() - 25 * 3600 * 1000) })
      .where(eq(signupFactUnresolved.orgId, gone.id));
    clerkKnows({ org_gone: "user_back" }, { user_back: { email: "back@x.com" } });
    expect((await reconcile()).body).toEqual({ stated: 1, withdrawn: 0, unresolved: 0 });
    expect(await db.select().from(signupFactUnresolved)).toHaveLength(0);
  });

  it("a deleted or absorbed org is CORRECTED with a withdrawn fact, never silently removed", async () => {
    const deleted = await insertTestOrg({ externalId: "org_deleted" });
    const absorbed = await insertTestOrg({ externalId: "org_absorbed" });
    const keeper = await insertTestOrg({ externalId: "org_keeper", anonymousAt: new Date(), claimedAt: new Date() });
    clerkKnows(
      { org_deleted: "user_d", org_absorbed: "user_a", org_keeper: "user_a" },
      { user_d: { email: "d@x.com" }, user_a: { email: "a@x.com" } },
    );
    expect((await reconcile()).body.stated).toBe(3);

    await db.delete(orgs).where(eq(orgs.id, deleted.id));
    await db
      .update(orgs)
      .set({ externalId: null, slug: null, absorbedIntoOrgId: keeper.id, absorbedAt: new Date() })
      .where(eq(orgs.id, absorbed.id));

    expect((await reconcile()).body).toEqual({ stated: 0, withdrawn: 2, unresolved: 0 });
    expect((await reconcile()).body).toEqual({ stated: 0, withdrawn: 0, unresolved: 0 });

    const { facts } = (await feed()).body;
    expect(facts).toHaveLength(5);
    const signups = facts.filter((f: { type: string }) => f.type === "signup");
    const withdrawals = facts.filter((f: { type: string }) => f.type === "withdrawn");
    const signupOf = (orgId: string) => signups.find((f: { customerOrgId: string }) => f.customerOrgId === orgId);
    expect(withdrawals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ withdrawnOf: signupOf(deleted.id).factId, withdrawnReason: "org_deleted", customerOrgId: deleted.id, email: "d@x.com" }),
        expect.objectContaining({ withdrawnOf: signupOf(absorbed.id).factId, withdrawnReason: "org_absorbed", customerOrgId: absorbed.id }),
      ]),
    );
    // Withdrawals come after what they correct.
    for (const w of withdrawals) expect(w.seq).toBeGreaterThan(signups.find((s: { factId: string }) => s.factId === w.withdrawnOf).seq);
  });

  it("pages the feed in seq order after the cursor", async () => {
    for (const n of [1, 2, 3]) await insertTestOrg({ externalId: `org_${n}` });
    clerkKnows({ org_1: "u1", org_2: "u2", org_3: "u3" }, { u1: { email: "1@x.com" }, u2: { email: "2@x.com" }, u3: { email: "3@x.com" } });
    await reconcile();

    const first = await feed("?limit=2");
    expect(first.body.facts).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);
    const second = await feed(`?since=${first.body.nextCursor}&limit=2`);
    expect(second.body.facts).toHaveLength(1);
    expect(second.body.hasMore).toBe(false);
    const empty = await feed(`?since=${second.body.nextCursor}`);
    expect(empty.body).toEqual({ facts: [], nextCursor: second.body.nextCursor, hasMore: false });
    expect((await feed("?limit=0")).status).toBe(400);
  });

  it("an identity-provider failure is a 502 and writes nothing", async () => {
    await insertTestOrg({ externalId: "org_one" });
    orgListMock.mockRejectedValue(Object.assign(new Error("boom"), { status: 503 }));
    const res = await reconcile();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("identity_provider_unavailable");
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM signup_facts`)) as unknown as { n: number }[];
    expect(n).toBe(0);
    expect(await db.select().from(signupFactUnresolved)).toHaveLength(0);
  });

  it("requires the API key", async () => {
    expect((await request(app).get("/internal/signup-facts")).status).toBe(401);
  });
});

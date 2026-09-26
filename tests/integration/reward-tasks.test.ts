import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { sql as rawSql } from "drizzle-orm";
import rewardTasksRoutes from "../../src/routes/reward-tasks.js";
import { db } from "../../src/db/index.js";
import { closeDb } from "../helpers/test-db.js";

/**
 * The reward ledger end to end, against a real database: what is due, since
 * when, what a genuine refresh pays, and what a no-op touch does not.
 */

const BRAND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OFFER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OFFER_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const API_KEY = "test_api_key";

process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand_key";
process.env.BILLING_SERVICE_URL = "http://billing.test";
process.env.BILLING_SERVICE_API_KEY = "billing_key";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(rewardTasksRoutes);
  return instance;
}

type Leg = {
  fromStep: string;
  toStep: string;
  ratePct: number | null;
  stated: boolean;
  statedAt: string | null;
};

type Offer = {
  offerId: string;
  name: string;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueStatedAt: string | null;
  bookingUrl?: string | null;
  destinationUrl?: string | null;
};

type World = {
  claims: Array<{ id: string; orgId: string }>;
  offers: Offer[];
  legRates: Leg[];
  billingStatus: number;
  grants: Array<Record<string, unknown>>;
};

let world: World;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    offerId: OFFER,
    name: "Self serve",
    lifetimeRevenueUsd: 4900,
    lifetimeRevenueStatedAt: daysAgo(40),
    bookingUrl: null,
    destinationUrl: "https://acme.test/pricing",
    ...overrides,
  };
}

/** The brand's leg rates, all stated at `statedAt`. */
function legs(statedAt: string = daysAgo(40), visitToSignup = 4.2): Leg[] {
  return [
    { fromStep: "Website visit", toStep: "Signup", ratePct: visitToSignup, stated: true, statedAt },
    { fromStep: "Signup", toStep: "Paid client", ratePct: 11, stated: true, statedAt },
    { fromStep: "Positive reply", toStep: "Paid client", ratePct: null, stated: false, statedAt: null },
  ];
}

function stubFleet() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/internal/brands/all")) {
        return new Response(
          JSON.stringify({
            brands: world.claims.map((c) => ({ ...c, domain: null, name: "Acme" })),
          }),
          { status: 200 },
        );
      }
      if (url.includes("/sales-funnels")) {
        throw new Error(`the retired funnel route was called: ${url}`);
      }
      if (url.match(/\/internal\/brands\/[^/]+\/offer-economics$/)) {
        return new Response(JSON.stringify({ legRates: world.legRates, offers: world.offers }), {
          status: 200,
        });
      }
      if (url.includes("/internal/credits/grant")) {
        world.grants.push(JSON.parse(String(init?.body ?? "{}")));
        if (world.billingStatus !== 200) {
          return new Response(JSON.stringify({ error: "billing is down" }), {
            status: world.billingStatus,
          });
        }
        return new Response(JSON.stringify({ ok: true, newBalanceCents: "500" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

async function read(orgId?: string) {
  const req = request(app())
    .get(`/internal/brands/${BRAND}/reward-tasks`)
    .set("x-api-key", API_KEY);
  if (orgId) req.set("x-org-id", orgId);
  return req;
}

/** Push a task's refresh clock into the past, as a month of real time would. */
async function ageClock(days: number) {
  await db.execute(
    rawSql`UPDATE reward_task_states SET content_changed_at = now() - make_interval(days => ${days})`,
  );
}

beforeEach(async () => {
  await db.execute(rawSql`DELETE FROM reward_task_completions`);
  await db.execute(rawSql`DELETE FROM reward_task_states`);
  await db.execute(rawSql`DELETE FROM reward_offer_observations`);

  world = {
    claims: [{ id: BRAND, orgId: ORG }],
    offers: [offer()],
    legRates: legs(),
    billingStatus: 200,
    grants: [],
  };
  stubFleet();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

describe("an offer's refresh becomes due after 30 days", () => {
  it("reports DUE with the date it became due when the numbers are older than 30 days", async () => {
    // The clock starts from the LATEST stated number, in the producer's own
    // Postgres instant form.
    const updatedAt = daysAgo(40);
    world.offers = [offer({ lifetimeRevenueStatedAt: daysAgo(50) })];
    world.legRates = legs(updatedAt.replace("T", " ").replace("Z", "+00"));

    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.orgId).toBe(ORG);
    expect(res.body.tasks).toHaveLength(1);

    const task = res.body.tasks[0];
    expect(task.taskKey).toBe("offer_economics_refresh");
    expect(task.scope).toEqual({ type: "offer", brandId: BRAND, offerId: OFFER });
    expect(task.due).toBe(true);
    expect(task.rewardCents).toBe(100);
    expect(task.lastCompletedAt).toBeNull();
    // Due since exactly 30 days after the numbers were last touched.
    expect(new Date(task.dueAt).getTime()).toBe(
      new Date(updatedAt).getTime() + 30 * 24 * 60 * 60 * 1000,
    );
    // First sighting: we could not have watched the change ourselves.
    expect(task.contentChangedProvenance).toBe("producer_ts");
  });

  it("reports nothing due under 30 days", async () => {
    world.offers = [offer({ lifetimeRevenueStatedAt: daysAgo(5) })];

    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].due).toBe(false);
    expect(res.body.rollup.brand).toEqual({ dueCount: 0, taskCount: 1 });
  });

  it("does not complete anything merely by being read", async () => {
    await read();
    await read();

    expect(world.grants).toHaveLength(0);
    expect((await read()).body.tasks[0].completedCount).toBe(0);
  });
});

describe("changing the numbers completes the task and pays once per window", () => {
  it("pays $1 exactly once, and nothing more for a second edit in the same window", async () => {
    await read();

    world.legRates = legs(new Date().toISOString(), 6.4);
    const completed = await read();

    expect(completed.status).toBe(200);
    expect(world.grants).toHaveLength(1);
    expect(world.grants[0]).toMatchObject({
      orgId: ORG,
      amountCents: 100,
      reason: "product_task_completed",
    });
    expect(typeof world.grants[0].completionId).toBe("string");

    const task = completed.body.tasks[0];
    expect(task.due).toBe(false);
    expect(task.completedCount).toBe(1);
    expect(task.lastCompletedAt).not.toBeNull();
    expect(task.contentChangedProvenance).toBe("observed");

    // Same window, edited again: fresh numbers, no second dollar.
    world.offers = [offer({ lifetimeRevenueUsd: 7300 })];
    const again = await read();

    expect(world.grants).toHaveLength(1);
    expect(again.body.tasks[0].completedCount).toBe(1);
    expect(again.body.tasks[0].due).toBe(false);
  });

  it("a changed booking link on a due offer is a refresh and pays", async () => {
    await read();

    world.offers = [offer({ bookingUrl: "https://cal.test/acme" })];
    const res = await read();

    expect(world.grants).toHaveLength(1);
    expect(res.body.tasks[0].completedCount).toBe(1);
  });

  it("comes due again 30 days later, and pays again", async () => {
    await read();
    world.legRates = legs(daysAgo(40), 6.4);
    await read();
    expect(world.grants).toHaveLength(1);

    // A month passes.
    await ageClock(31);
    expect((await read()).body.tasks[0].due).toBe(true);
    expect(world.grants).toHaveLength(1);

    world.legRates = legs(daysAgo(40), 7.9);
    const second = await read();

    expect(world.grants).toHaveLength(2);
    expect(world.grants[1].completionId).not.toBe(world.grants[0].completionId);
    expect(second.body.tasks[0].completedCount).toBe(2);
  });

  it("an edit made BEFORE the refresh was owed restarts the clock and pays nothing", async () => {
    world.offers = [offer({ lifetimeRevenueStatedAt: daysAgo(5) })];
    await read();

    world.offers = [offer({ lifetimeRevenueStatedAt: daysAgo(5), lifetimeRevenueUsd: 8800 })];
    const res = await read();

    expect(world.grants).toHaveLength(0);
    expect(res.body.tasks[0].due).toBe(false);
    expect(res.body.tasks[0].completedCount).toBe(0);
    expect(res.body.tasks[0].contentChangedProvenance).toBe("observed");
  });
});

describe("saving an unchanged number is not a refresh", () => {
  it("completes nothing and pays nothing, and does not reset the clock", async () => {
    const before = await read();
    expect(before.body.tasks[0].due).toBe(true);
    const dueAt = before.body.tasks[0].dueAt;

    // Same numbers, every statedAt moved to now by a re-save.
    const now = new Date().toISOString();
    world.offers = [offer({ lifetimeRevenueStatedAt: now })];
    world.legRates = legs(now);
    const after = await read();

    expect(world.grants).toHaveLength(0);
    expect(after.body.tasks[0].completedCount).toBe(0);
    expect(after.body.tasks[0].due).toBe(true);
    expect(after.body.tasks[0].dueAt).toBe(dueAt);
  });
});

describe("a clock carried over from the retired sales-funnel grain", () => {
  /** Migration 0016's shape: a state with a clock and no fingerprint. */
  async function carriedState(daysOld: number) {
    await db.execute(rawSql`
      INSERT INTO reward_task_states
        (org_id, brand_id, offer_id, task_key, content_fingerprint,
         content_changed_at, content_changed_provenance)
      VALUES (${ORG}, ${BRAND}, ${OFFER}, 'offer_economics_refresh', NULL,
              now() - make_interval(days => ${daysOld}), 'producer_ts')
    `);
  }

  it("keeps the carried clock and pays nothing for the change of shape", async () => {
    await carriedState(45);
    // The producer's own statedAt is recent; the carried clock must win.
    world.offers = [offer({ lifetimeRevenueStatedAt: daysAgo(1) })];
    world.legRates = legs(daysAgo(1));

    const res = await read();

    expect(res.status).toBe(200);
    expect(world.grants).toHaveLength(0);
    expect(res.body.tasks[0].due).toBe(true);
    expect(res.body.tasks[0].completedCount).toBe(0);

    const [state] = (await db.execute(
      rawSql`SELECT content_fingerprint FROM reward_task_states`,
    )) as unknown as Array<{ content_fingerprint: string | null }>;
    expect(state.content_fingerprint).not.toBeNull();
  });

  it("then pays for a genuine refresh like any other due task", async () => {
    await carriedState(45);
    await read();

    world.offers = [offer({ lifetimeRevenueUsd: 5200 })];
    const res = await read();

    expect(world.grants).toHaveLength(1);
    expect(res.body.tasks[0].completedCount).toBe(1);
    expect(res.body.tasks[0].due).toBe(false);
  });
});

describe("a billing failure is loud and retries", () => {
  it("answers 502, leaves the completion undelivered, and delivers it on the next call", async () => {
    await read();

    world.billingStatus = 500;
    world.legRates = legs(daysAgo(40), 6.4);
    const failed = await read();

    expect(failed.status).toBe(502);
    expect(world.grants).toHaveLength(1);

    const undelivered = (await db.execute(
      rawSql`SELECT id, billing_notified_at FROM reward_task_completions`,
    )) as unknown as Array<{ id: string; billing_notified_at: Date | null }>;
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0].billing_notified_at).toBeNull();

    world.billingStatus = 200;
    const retried = await read();

    expect(retried.status).toBe(200);
    expect(world.grants).toHaveLength(2);
    // Same completion, retried — billing's idempotency key is what stops a
    // double payment, and we hand it the same one.
    expect(world.grants[1].completionId).toBe(world.grants[0].completionId);
    expect(world.grants[1].completionId).toBe(undelivered[0].id);

    const delivered = (await db.execute(
      rawSql`SELECT billing_notified_at FROM reward_task_completions`,
    )) as unknown as Array<{ billing_notified_at: Date | null }>;
    expect(delivered[0].billing_notified_at).not.toBeNull();

    // And a further read notifies nobody again.
    await read();
    expect(world.grants).toHaveLength(2);
  });

  it("surfaces a brand-service failure as a 502, never as nothing-is-due", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("brand-service exploded", { status: 503 })),
    );

    const res = await read(ORG);

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("503");
  });
});

describe("degenerate inputs answer cleanly and honestly", () => {
  it("a brand with no offers has no tasks", async () => {
    world.offers = [];

    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.tasks).toEqual([]);
    expect(res.body.rollup).toEqual({ brand: { dueCount: 0, taskCount: 0 }, offers: [] });
  });

  it("an offer with nothing stated has no task, and the offer is still reported", async () => {
    world.offers = [offer({ lifetimeRevenueUsd: null, lifetimeRevenueStatedAt: null })];
    world.legRates = legs().map((l) => ({ ...l, ratePct: null, stated: false, statedAt: null }));

    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
    expect(res.body.rollup.offers).toEqual([{ offerId: OFFER, dueCount: 0, taskCount: 0 }]);
  });

  it("an offer served without its link keys is a 502, never read as null", async () => {
    const { bookingUrl: _b, ...withoutBooking } = offer();
    world.offers = [withoutBooking as Offer];

    const res = await read();

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("bookingUrl");
  });

  it("a stated number served with no statedAt is a 502, not an invented clock", async () => {
    world.offers = [offer({ lifetimeRevenueStatedAt: null })];

    const res = await read();

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("statedAt");
  });

  it("the brand's leg rates alone start an offer's clock", async () => {
    world.offers = [offer({ lifetimeRevenueUsd: null, lifetimeRevenueStatedAt: null })];

    const res = await read();

    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].due).toBe(true);
  });

  it("an unclaimed brand says so rather than reporting nothing due", async () => {
    world.claims = [];

    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_org_claims_brand");
    expect(res.body.orgId).toBeNull();
    expect(res.body.tasks).toEqual([]);
  });

  it("refuses to guess whose reward it is when several orgs claim the brand", async () => {
    world.claims = [
      { id: BRAND, orgId: ORG },
      { id: BRAND, orgId: ORG_B },
    ];

    const res = await read();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ORG_REQUIRED");
    expect(res.body.orgIds).toHaveLength(2);
  });

  it("an org with nothing configured is a clean empty answer, named", async () => {
    world.offers = [];

    const res = await read(ORG_B);

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(ORG_B);
    expect(res.body.tasks).toEqual([]);
  });

  it("rejects a brandId that is not a uuid", async () => {
    const res = await request(app())
      .get("/internal/brands/not-a-uuid/reward-tasks")
      .set("x-api-key", API_KEY);

    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated caller", async () => {
    const res = await request(app()).get(`/internal/brands/${BRAND}/reward-tasks`);
    expect(res.status).toBe(401);
  });
});

describe("a superior scope can be told how many of its children have something due", () => {
  it("counts due children per offer and for the brand, without restating their tasks", async () => {
    // Leg rates are the brand's; each offer's own lifetime revenue decides its
    // latest statedAt. OFFER_2 was restated 3 days ago, so it is not due.
    world.legRates = legs(daysAgo(60));
    world.offers = [
      offer({ offerId: OFFER, lifetimeRevenueStatedAt: daysAgo(40) }),
      offer({ offerId: OFFER_2, name: "Enterprise", lifetimeRevenueStatedAt: daysAgo(3) }),
    ];

    const res = await read();

    expect(res.body.rollup.brand).toEqual({ dueCount: 1, taskCount: 2 });
    expect(res.body.rollup.offers).toEqual(
      expect.arrayContaining([
        { offerId: OFFER, dueCount: 1, taskCount: 1 },
        { offerId: OFFER_2, dueCount: 0, taskCount: 1 },
      ]),
    );
    expect(res.body.tasks).toHaveLength(2);
  });
});

describe("the bronze layer records what the producer served", () => {
  it("appends a row when the money content changes, and not on an identical re-read", async () => {
    await read();
    await read();
    await read();

    let rows = (await db.execute(
      rawSql`SELECT payload, producer_stated_at FROM reward_offer_observations`,
    )) as unknown as Array<{ payload: Record<string, any>; producer_stated_at: Date }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.offer.offerId).toBe(OFFER);
    expect(rows[0].payload.offer.lifetimeRevenueUsd).toBe(4900);
    // Only STATED legs are the content we keep.
    expect(rows[0].payload.legRates).toHaveLength(2);

    world.offers = [offer({ lifetimeRevenueUsd: 5100 })];
    await read();

    rows = (await db.execute(
      rawSql`SELECT payload, producer_stated_at FROM reward_offer_observations`,
    )) as unknown as Array<{ payload: Record<string, any>; producer_stated_at: Date }>;
    expect(rows).toHaveLength(2);
  });
});

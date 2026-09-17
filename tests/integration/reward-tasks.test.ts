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

type Funnel = {
  funnelKey: string;
  name?: string;
  active?: boolean;
  rates?: Record<string, number | null>;
  arrows?: Array<Record<string, unknown>>;
  lifetimeRevenueUsd?: number | null;
  destinationUrl?: string | null;
  bookingUrl?: string | null;
  updatedAt: string;
};

type World = {
  claims: Array<{ id: string; orgId: string }>;
  offers: Array<{ offerId: string; brandId: string; name: string }>;
  funnels: Record<string, Funnel[]>;
  billingStatus: number;
  grants: Array<Record<string, unknown>>;
};

let world: World;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function funnel(overrides: Partial<Funnel> = {}): Funnel {
  return {
    funnelKey: "website_purchases",
    name: "Website purchases",
    active: true,
    rates: { visit_to_signup: 4.2, signup_to_paid: 11 },
    arrows: [],
    lifetimeRevenueUsd: 4900,
    destinationUrl: "https://acme.test/pricing",
    bookingUrl: null,
    updatedAt: daysAgo(40),
    ...overrides,
  };
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
      if (url.includes("/offers") && url.includes("/internal/brands/")) {
        return new Response(JSON.stringify({ offers: world.offers }), { status: 200 });
      }
      const funnelMatch = url.match(/\/internal\/offers\/([^/]+)\/sales-funnels/);
      if (funnelMatch) {
        return new Response(JSON.stringify({ funnels: world.funnels[funnelMatch[1]] ?? [] }), {
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
  await db.execute(rawSql`DELETE FROM reward_funnel_observations`);

  world = {
    claims: [{ id: BRAND, orgId: ORG }],
    offers: [{ offerId: OFFER, brandId: BRAND, name: "Self serve" }],
    funnels: { [OFFER]: [funnel()] },
    billingStatus: 200,
    grants: [],
  };
  stubFleet();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

describe("a funnel's refresh becomes due after 30 days", () => {
  it("reports DUE with the date it became due when the numbers are older than 30 days", async () => {
    const updatedAt = daysAgo(40);
    world.funnels[OFFER] = [funnel({ updatedAt })];

    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.orgId).toBe(ORG);
    expect(res.body.tasks).toHaveLength(1);

    const task = res.body.tasks[0];
    expect(task.taskKey).toBe("sales_funnel_refresh");
    expect(task.scope).toEqual({
      type: "sales_funnel",
      brandId: BRAND,
      offerId: OFFER,
      funnelKey: "website_purchases",
    });
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
    world.funnels[OFFER] = [funnel({ updatedAt: daysAgo(5) })];

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

    world.funnels[OFFER] = [funnel({ rates: { visit_to_signup: 6.4, signup_to_paid: 11 } })];
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
    world.funnels[OFFER] = [funnel({ lifetimeRevenueUsd: 7300 })];
    const again = await read();

    expect(world.grants).toHaveLength(1);
    expect(again.body.tasks[0].completedCount).toBe(1);
    expect(again.body.tasks[0].due).toBe(false);
  });

  it("comes due again 30 days later, and pays again", async () => {
    await read();
    world.funnels[OFFER] = [funnel({ rates: { visit_to_signup: 6.4 } })];
    await read();
    expect(world.grants).toHaveLength(1);

    // A month passes.
    await ageClock(31);
    expect((await read()).body.tasks[0].due).toBe(true);
    expect(world.grants).toHaveLength(1);

    world.funnels[OFFER] = [funnel({ rates: { visit_to_signup: 7.9 } })];
    const second = await read();

    expect(world.grants).toHaveLength(2);
    expect(world.grants[1].completionId).not.toBe(world.grants[0].completionId);
    expect(second.body.tasks[0].completedCount).toBe(2);
  });

  it("an edit made BEFORE the refresh was owed restarts the clock and pays nothing", async () => {
    world.funnels[OFFER] = [funnel({ updatedAt: daysAgo(5) })];
    await read();

    world.funnels[OFFER] = [funnel({ updatedAt: daysAgo(5), lifetimeRevenueUsd: 8800 })];
    const res = await read();

    expect(world.grants).toHaveLength(0);
    expect(res.body.tasks[0].due).toBe(false);
    expect(res.body.tasks[0].completedCount).toBe(0);
    expect(res.body.tasks[0].contentChangedProvenance).toBe("observed");
  });
});

describe("switching a funnel off and back on is not a refresh", () => {
  it("completes nothing and pays nothing, and does not reset the clock", async () => {
    const before = await read();
    expect(before.body.tasks[0].due).toBe(true);
    const dueAt = before.body.tasks[0].dueAt;

    // OFF — brand-service never lists an inactive funnel, so it simply vanishes.
    world.funnels[OFFER] = [];
    const off = await read();
    expect(off.body.tasks).toHaveLength(0);
    expect(off.body.rollup.brand).toEqual({ dueCount: 0, taskCount: 0 });
    expect(world.grants).toHaveLength(0);

    // ON again — same numbers, and a producer timestamp the toggle moved forward.
    world.funnels[OFFER] = [funnel({ updatedAt: new Date().toISOString() })];
    const on = await read();

    expect(world.grants).toHaveLength(0);
    expect(on.body.tasks[0].completedCount).toBe(0);
    // The clock survived the toggle: still due, since the same instant.
    expect(on.body.tasks[0].due).toBe(true);
    expect(on.body.tasks[0].dueAt).toBe(dueAt);
  });
});

describe("a billing failure is loud and retries", () => {
  it("answers 502, leaves the completion undelivered, and delivers it on the next call", async () => {
    await read();

    world.billingStatus = 500;
    world.funnels[OFFER] = [funnel({ rates: { visit_to_signup: 6.4 } })];
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

  it("an offer with no funnels reports the offer with nothing due", async () => {
    world.funnels[OFFER] = [];

    const res = await read();

    expect(res.body.tasks).toEqual([]);
    expect(res.body.rollup.offers).toEqual([{ offerId: OFFER, dueCount: 0, taskCount: 0 }]);
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
    world.offers = [
      { offerId: OFFER, brandId: BRAND, name: "Self serve" },
      { offerId: OFFER_2, brandId: BRAND, name: "Enterprise" },
    ];
    world.funnels = {
      [OFFER]: [funnel({ updatedAt: daysAgo(40) })],
      [OFFER_2]: [
        funnel({ funnelKey: "sales_from_conversation", updatedAt: daysAgo(3) }),
        funnel({ funnelKey: "form_magnet", updatedAt: daysAgo(90) }),
      ],
    };

    const res = await read();

    expect(res.body.rollup.brand).toEqual({ dueCount: 2, taskCount: 3 });
    expect(res.body.rollup.offers).toEqual(
      expect.arrayContaining([
        { offerId: OFFER, dueCount: 1, taskCount: 1 },
        { offerId: OFFER_2, dueCount: 1, taskCount: 2 },
      ]),
    );
    // The rollup stands on its own — an offer page never has to add the children up.
    expect(res.body.tasks).toHaveLength(3);
  });
});

describe("the bronze layer records what the producer served", () => {
  it("appends a row when the money content changes, and not on an identical re-read", async () => {
    await read();
    await read();
    await read();

    let rows = (await db.execute(
      rawSql`SELECT payload, producer_updated_at FROM reward_funnel_observations`,
    )) as unknown as Array<{ payload: Record<string, unknown>; producer_updated_at: Date }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.funnelKey).toBe("website_purchases");
    expect(rows[0].payload.lifetimeRevenueUsd).toBe(4900);

    world.funnels[OFFER] = [funnel({ lifetimeRevenueUsd: 5100 })];
    await read();

    rows = (await db.execute(
      rawSql`SELECT payload, producer_updated_at FROM reward_funnel_observations`,
    )) as unknown as Array<{ payload: Record<string, unknown>; producer_updated_at: Date }>;
    expect(rows).toHaveLength(2);
  });
});

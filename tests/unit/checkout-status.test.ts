import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import checkoutStatusRoutes from "../../src/routes/checkout-status.js";

const BRAND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_BRAND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const API_KEY = "test_api_key";

/** App with ONLY the checkout-status router — no DB import, runs anywhere. */
function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(checkoutStatusRoutes);
  return instance;
}

type Upstreams = {
  /** brand-service GET /internal/brands/all rows */
  brands?: Array<{ id: string; orgId: string; domain: string | null; name: string }>;
  /** per-org billing daily budget for the brand under test */
  budgets?: Record<string, string | null>;
  /** per-org stripe payment totals */
  payments?: Record<string, Array<{ currency: string; amount_received: number }>>;
  /** force a non-2xx from one upstream */
  fail?: { match: string; status: number; body: string };
};

function stubUpstreams(upstreams: Upstreams) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (upstreams.fail && url.includes(upstreams.fail.match)) {
      const { status, body } = upstreams.fail;
      return { ok: false, status, text: async () => body, json: async () => ({}) };
    }

    if (url.includes("/internal/brands/all")) {
      const brands = upstreams.brands ?? [];
      return { ok: true, status: 200, json: async () => ({ brands }) };
    }

    const budgetMatch = url.match(/\/internal\/brands\/([^/]+)\/daily-budget$/);
    if (budgetMatch) {
      // billing keys the budget on (x-org-id, brandId): the org travels in a
      // header, so read it off THIS request — org lookups run concurrently.
      const dailyBudgetCents = upstreams.budgets?.[headers["x-org-id"]] ?? null;
      return {
        ok: true,
        status: 200,
        json: async () => ({ brandId: budgetMatch[1], dailyBudgetCents, updatedAt: null }),
      };
    }

    const paymentMatch = url.match(/\/internal\/payment_summary\/by-org\/([^/]+)$/);
    if (paymentMatch) {
      const totals = upstreams.payments?.[paymentMatch[1]] ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: "payment_summary",
          org_id: paymentMatch[1],
          customer: null,
          totals,
        }),
      };
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("checkout-status routes", () => {
  beforeEach(() => {
    process.env.CLIENT_SERVICE_API_KEY = API_KEY;
    process.env.BRAND_SERVICE_URL = "http://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "brand-key";
    process.env.BILLING_SERVICE_URL = "http://billing.test";
    process.env.BILLING_SERVICE_API_KEY = "billing-key";
    process.env.STRIPE_SERVICE_URL = "http://stripe.test";
    process.env.STRIPE_SERVICE_API_KEY = "stripe-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("GET /internal/brands/:brandId/checkout-status", () => {
    it("reports checked_out when a claiming org both paid and budgeted the brand", async () => {
      stubUpstreams({
        brands: [{ id: BRAND, orgId: ORG_A, domain: "acme.com", name: "Acme" }],
        budgets: { [ORG_A]: "5000" },
        payments: { [ORG_A]: [{ currency: "usd", amount_received: 12500 }] },
      });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        brandId: BRAND,
        status: "checked_out",
        checkedOut: true,
      });
      expect(res.body.orgs).toHaveLength(1);
      expect(res.body.orgs[0]).toMatchObject({
        orgId: ORG_A,
        checkedOut: true,
        reason: "checked_out",
        brandDailyBudgetCents: "5000",
        orgPayments: [{ currency: "usd", amountReceivedCents: 12500 }],
      });
    });

    it("reports not_checked_out (nobody paid) when the brand is claimed but no budget was ever set", async () => {
      stubUpstreams({
        brands: [{ id: BRAND, orgId: ORG_A, domain: "acme.com", name: "Acme" }],
        budgets: { [ORG_A]: null },
        payments: { [ORG_A]: [{ currency: "usd", amount_received: 12500 }] },
      });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("not_checked_out");
      expect(res.body.checkedOut).toBe(false);
      expect(res.body.orgs[0]).toMatchObject({
        reason: "no_brand_budget",
        brandDailyBudgetCents: null,
      });
    });

    it("reports not_checked_out when the brand is budgeted but the org never paid a cent", async () => {
      stubUpstreams({
        brands: [{ id: BRAND, orgId: ORG_A, domain: "acme.com", name: "Acme" }],
        budgets: { [ORG_A]: "5000" },
        payments: { [ORG_A]: [] },
      });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("not_checked_out");
      expect(res.body.orgs[0]).toMatchObject({ reason: "org_never_paid", orgPayments: [] });
    });

    it("does not count a zero-amount payment row as money in", async () => {
      stubUpstreams({
        brands: [{ id: BRAND, orgId: ORG_A, domain: "acme.com", name: "Acme" }],
        budgets: { [ORG_A]: "5000" },
        payments: { [ORG_A]: [{ currency: "usd", amount_received: 0 }] },
      });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.body.checkedOut).toBe(false);
      expect(res.body.orgs[0].reason).toBe("org_never_paid");
    });

    it("reports no_org_claims_brand — distinct from a claimed-but-unpaid brand", async () => {
      stubUpstreams({
        brands: [{ id: OTHER_BRAND, orgId: ORG_A, domain: "other.com", name: "Other" }],
      });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        brandId: BRAND,
        status: "no_org_claims_brand",
        checkedOut: false,
        orgs: [],
      });
    });

    it("evaluates every claiming org and marks the brand checked out if any of them paid", async () => {
      stubUpstreams({
        brands: [
          { id: BRAND, orgId: ORG_A, domain: "acme.com", name: "Acme" },
          { id: BRAND, orgId: ORG_B, domain: "acme.com", name: "Acme" },
        ],
        budgets: { [ORG_A]: null, [ORG_B]: "2500" },
        payments: { [ORG_A]: [], [ORG_B]: [{ currency: "eur", amount_received: 9900 }] },
      });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.body.status).toBe("checked_out");
      expect(res.body.orgs).toHaveLength(2);
      const paid = res.body.orgs.filter((o: { checkedOut: boolean }) => o.checkedOut);
      expect(paid).toHaveLength(1);
      expect(paid[0].orgId).toBe(ORG_B);
    });

    it("400s on a non-uuid brandId", async () => {
      stubUpstreams({});
      const res = await request(app())
        .get("/internal/brands/not-a-uuid/checkout-status")
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
    });

    it("401s without the service api key", async () => {
      stubUpstreams({});
      const res = await request(app()).get(`/internal/brands/${BRAND}/checkout-status`);
      expect(res.status).toBe(401);
    });

    it("502s (fail loud) when brand-service errors — never a defaulted 'nobody paid'", async () => {
      stubUpstreams({ fail: { match: "/internal/brands/all", status: 500, body: "boom" } });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("brand-service");
    });

    it("502s (fail loud) when billing-service errors", async () => {
      stubUpstreams({
        brands: [{ id: BRAND, orgId: ORG_A, domain: "acme.com", name: "Acme" }],
        fail: { match: "daily-budget", status: 503, body: "unavailable" },
      });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("billing-service");
    });

    it("502s (fail loud) when stripe-service errors", async () => {
      stubUpstreams({
        brands: [{ id: BRAND, orgId: ORG_A, domain: "acme.com", name: "Acme" }],
        budgets: { [ORG_A]: "5000" },
        fail: { match: "payment_summary", status: 500, body: "kaboom" },
      });

      const res = await request(app())
        .get(`/internal/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("stripe-service");
    });
  });

  describe("GET /internal/orgs/:orgId/brands/:brandId/checkout-status", () => {
    it("answers the pair without any brand-service lookup", async () => {
      const fetchMock = stubUpstreams({
        budgets: { [ORG_A]: "5000" },
        payments: { [ORG_A]: [{ currency: "usd", amount_received: 2500 }] },
      });

      const res = await request(app())
        .get(`/internal/orgs/${ORG_A}/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        orgId: ORG_A,
        brandId: BRAND,
        checkedOut: true,
        reason: "checked_out",
      });
      const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
      expect(calledUrls.some((u) => u.includes("/internal/brands/all"))).toBe(false);
    });

    it("returns a truthful never-paid verdict instead of a 404", async () => {
      stubUpstreams({ budgets: { [ORG_A]: null }, payments: { [ORG_A]: [] } });

      const res = await request(app())
        .get(`/internal/orgs/${ORG_A}/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        checkedOut: false,
        reason: "no_brand_budget",
        brandDailyBudgetCents: null,
        orgPayments: [],
      });
    });

    it("sends the org as x-org-id to billing (billing keys the budget on the org)", async () => {
      const fetchMock = stubUpstreams({
        budgets: { [ORG_A]: "100" },
        payments: { [ORG_A]: [{ currency: "usd", amount_received: 1 }] },
      });

      await request(app())
        .get(`/internal/orgs/${ORG_A}/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);

      const billingCall = fetchMock.mock.calls.find((c) =>
        (c[0] as string).includes("daily-budget"),
      );
      expect(billingCall).toBeDefined();
      expect((billingCall![1] as RequestInit).headers).toMatchObject({
        "x-api-key": "billing-key",
        "x-org-id": ORG_A,
      });
    });

    it("400s on a non-uuid orgId", async () => {
      stubUpstreams({});
      const res = await request(app())
        .get(`/internal/orgs/nope/brands/${BRAND}/checkout-status`)
        .set("x-api-key", API_KEY);
      expect(res.status).toBe(400);
    });

    it("401s without the service api key", async () => {
      stubUpstreams({});
      const res = await request(app()).get(
        `/internal/orgs/${ORG_A}/brands/${BRAND}/checkout-status`,
      );
      expect(res.status).toBe(401);
    });
  });
});

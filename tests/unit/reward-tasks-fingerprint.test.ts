import { describe, it, expect } from "vitest";
import {
  fingerprintOfferContent,
  latestStatedAt,
  StatedAtMissingError,
} from "../../src/lib/reward-tasks.js";
import type { BrandLegRate, OfferLifetimeRevenue } from "../../src/lib/brand-service-client.js";

/**
 * The whole reward ledger rests on one discrimination: a real refresh of an
 * offer's money numbers versus a no-op touch. brand-service's own `statedAt`
 * cannot make it — an unchanged number saved again moves it with nobody having
 * changed anything — so the fingerprint below is what makes it instead.
 */

function offer(overrides: Partial<OfferLifetimeRevenue> = {}): OfferLifetimeRevenue {
  return {
    offerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Self serve",
    lifetimeRevenueUsd: 4900,
    lifetimeRevenueStatedAt: "2026-08-01 10:00:00+00",
    raw: {},
    ...overrides,
  };
}

function leg(overrides: Partial<BrandLegRate> = {}): BrandLegRate {
  return {
    fromStep: "Website visit",
    toStep: "Signup",
    ratePct: 4.2,
    stated: true,
    statedAt: "2026-08-01 10:00:00+00",
    ...overrides,
  };
}

const LEGS = [leg(), leg({ fromStep: "Signup", toStep: "Paid client", ratePct: 11 })];
const UNSTATED = leg({ fromStep: "Positive reply", toStep: "Paid client", ratePct: null, stated: false, statedAt: null });

describe("fingerprintOfferContent", () => {
  it("is stable across two readings of identical numbers", () => {
    expect(fingerprintOfferContent(offer(), LEGS)).toBe(fingerprintOfferContent(offer(), LEGS));
  });

  it("ignores the producer's statedAt — an unchanged re-save is not a refresh", () => {
    expect(
      fingerprintOfferContent(offer({ lifetimeRevenueStatedAt: "2026-09-26 09:00:00+00" }), [
        leg({ statedAt: "2026-09-26 09:00:00+00" }),
        LEGS[1],
      ]),
    ).toBe(fingerprintOfferContent(offer(), LEGS));
  });

  it("ignores a rename — renaming an offer refreshes no number", () => {
    expect(fingerprintOfferContent(offer({ name: "Enterprise" }), LEGS)).toBe(
      fingerprintOfferContent(offer(), LEGS),
    );
  });

  it("ignores an unstated leg, so a leg brand-service newly learns is not a refresh", () => {
    expect(fingerprintOfferContent(offer(), [...LEGS, UNSTATED])).toBe(
      fingerprintOfferContent(offer(), LEGS),
    );
  });

  it("does not depend on the order the producer served the legs in", () => {
    expect(fingerprintOfferContent(offer(), [...LEGS].reverse())).toBe(
      fingerprintOfferContent(offer(), LEGS),
    );
  });

  it("changes when a leg's conversion rate changes", () => {
    expect(fingerprintOfferContent(offer(), [leg({ ratePct: 5.1 }), LEGS[1]])).not.toBe(
      fingerprintOfferContent(offer(), LEGS),
    );
  });

  it("changes when a leg is stated for the first time", () => {
    expect(
      fingerprintOfferContent(offer(), [...LEGS, { ...UNSTATED, ratePct: 3, stated: true, statedAt: "2026-09-26 09:00:00+00" }]),
    ).not.toBe(fingerprintOfferContent(offer(), LEGS));
  });

  it("changes when the lifetime revenue of a won client changes", () => {
    expect(fingerprintOfferContent(offer({ lifetimeRevenueUsd: 6200 }), LEGS)).not.toBe(
      fingerprintOfferContent(offer(), LEGS),
    );
  });

  it("tells a null apart from a zero", () => {
    // Nothing upstream is defaulted: a value the brand never stated reads null,
    // which never means zero. Stating a real zero IS a refresh.
    expect(fingerprintOfferContent(offer({ lifetimeRevenueUsd: 0 }), LEGS)).not.toBe(
      fingerprintOfferContent(offer({ lifetimeRevenueUsd: null, lifetimeRevenueStatedAt: null }), LEGS),
    );
  });
});

describe("latestStatedAt", () => {
  it("is the latest instant across the offer's stated numbers, parsed from Postgres form", () => {
    expect(
      latestStatedAt(offer(), [leg({ statedAt: "2026-09-25 07:03:47.40352+00" }), UNSTATED]),
    ).toBe("2026-09-25T07:03:47.403Z");
  });

  it("is null when nothing is stated at all — no instant to start a clock from", () => {
    expect(
      latestStatedAt(offer({ lifetimeRevenueUsd: null, lifetimeRevenueStatedAt: null }), [UNSTATED]),
    ).toBeNull();
  });

  it("refuses a stated number with no usable statedAt rather than inventing one", () => {
    expect(() => latestStatedAt(offer({ lifetimeRevenueStatedAt: null }), [])).toThrow(
      StatedAtMissingError,
    );
    expect(() => latestStatedAt(offer(), [leg({ statedAt: "not a date" })])).toThrow(
      StatedAtMissingError,
    );
  });
});

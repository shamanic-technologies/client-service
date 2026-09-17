import { describe, it, expect } from "vitest";
import { fingerprintFunnelContent } from "../../src/lib/reward-tasks.js";
import type { OfferSalesFunnel } from "../../src/lib/brand-service-client.js";

/**
 * The whole reward ledger rests on one discrimination: a real refresh of a
 * funnel's money numbers versus a no-op touch. brand-service's own last-touched
 * timestamp cannot make it — a toggle moves that with nobody having looked at a
 * number — so the fingerprint below is what makes it instead.
 */

function funnel(overrides: Partial<OfferSalesFunnel> = {}): OfferSalesFunnel {
  const base: OfferSalesFunnel = {
    funnelKey: "website_purchases",
    name: "Website purchases",
    active: true,
    rates: { visit_to_signup: 4.2, signup_to_paid: 11 },
    arrows: [
      { fromStep: "website_visit", toStep: "signup", ratePct: 4.2, provenance: "stated_arrow", rateKey: "visit_to_signup" },
    ],
    lifetimeRevenueUsd: 4900,
    destinationUrl: "https://acme.test/pricing",
    bookingUrl: null,
    updatedAt: "2026-08-01T10:00:00.000Z",
    raw: {},
  };
  return { ...base, ...overrides };
}

describe("fingerprintFunnelContent", () => {
  it("is stable across two readings of identical numbers", () => {
    expect(fingerprintFunnelContent(funnel())).toBe(fingerprintFunnelContent(funnel()));
  });

  it("ignores the producer's last-touched timestamp", () => {
    // The timestamp moves on a mere toggle. If it fed the fingerprint, switching
    // a funnel off and back on would complete the task and pay for it.
    expect(fingerprintFunnelContent(funnel({ updatedAt: "2026-09-17T09:00:00.000Z" }))).toBe(
      fingerprintFunnelContent(funnel()),
    );
  });

  it("ignores whether the funnel is switched on", () => {
    expect(fingerprintFunnelContent(funnel({ active: false }))).toBe(
      fingerprintFunnelContent(funnel()),
    );
  });

  it("ignores a rename — renaming a funnel refreshes no number", () => {
    expect(fingerprintFunnelContent(funnel({ name: "Self-serve checkout" }))).toBe(
      fingerprintFunnelContent(funnel()),
    );
  });

  it("changes when a conversion rate changes", () => {
    expect(fingerprintFunnelContent(funnel({ rates: { visit_to_signup: 5.1, signup_to_paid: 11 } }))).not.toBe(
      fingerprintFunnelContent(funnel()),
    );
  });

  it("changes when a step's stated arrow rate changes", () => {
    const edited = funnel({
      arrows: [
        { fromStep: "website_visit", toStep: "signup", ratePct: 6, provenance: "stated_arrow", rateKey: "visit_to_signup" },
      ],
    });
    expect(fingerprintFunnelContent(edited)).not.toBe(fingerprintFunnelContent(funnel()));
  });

  it("changes when the lifetime revenue of a won client changes", () => {
    expect(fingerprintFunnelContent(funnel({ lifetimeRevenueUsd: 6200 }))).not.toBe(
      fingerprintFunnelContent(funnel()),
    );
  });

  it("changes when the booking link is set for the first time", () => {
    expect(fingerprintFunnelContent(funnel({ bookingUrl: "https://cal.test/acme" }))).not.toBe(
      fingerprintFunnelContent(funnel()),
    );
  });

  it("changes when the destination the outreach click lands on changes", () => {
    expect(fingerprintFunnelContent(funnel({ destinationUrl: "https://acme.test/offer" }))).not.toBe(
      fingerprintFunnelContent(funnel()),
    );
  });

  it("does not depend on the key order the producer happened to serve", () => {
    const reordered = funnel({ rates: { signup_to_paid: 11, visit_to_signup: 4.2 } });
    expect(fingerprintFunnelContent(reordered)).toBe(fingerprintFunnelContent(funnel()));
  });

  it("tells a null apart from a zero", () => {
    // Nothing upstream is defaulted: a value the brand never declared reads null,
    // which never means zero. Stating a real zero IS a refresh.
    expect(fingerprintFunnelContent(funnel({ lifetimeRevenueUsd: 0 }))).not.toBe(
      fingerprintFunnelContent(funnel({ lifetimeRevenueUsd: null })),
    );
  });
});

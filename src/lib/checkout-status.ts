import { getBrandDailyBudgetCents } from "./billing-service-client.js";
import { listOrgsClaimingBrand } from "./brand-service-client.js";
import { getOrgPaymentTotals, type OrgPaymentTotal } from "./stripe-service-client.js";

/**
 * "Has this org actually gone through checkout for this brand?"
 *
 * client-service owns the user journey and sits between brand identity
 * (brand-service) and money (billing-service / stripe-service), so it owns the
 * join no single one of them can make.
 *
 * DEFINITION — an (org, brand) pair is CHECKED OUT when BOTH hold:
 *
 *   1. MONEY: the org has paid real money in. Evidence = stripe-service's
 *      payment summary reporting a positive `amount_received` in at least one
 *      currency (gross over `succeeded` PaymentIntents). Checkout is an
 *      org-level act — Stripe carries no brand on a Checkout Session or a
 *      PaymentIntent anywhere in the fleet — so this leg alone cannot tell one
 *      brand from another.
 *
 *   2. BRAND COMMITMENT: the org configured a per-brand daily spend ceiling for
 *      THIS brand. Evidence = a billing-service `brand_daily_budgets` row for
 *      (org, brand), i.e. `dailyBudgetCents` not null. This is the only per-brand
 *      money signal that exists, and in the product it is written by the
 *      post-payment launch step — an onboarding that is abandoned before paying
 *      never reaches it. This leg is what makes the answer brand-specific.
 *
 * Both legs are read LIVE from their owning service; client-service stores no
 * copy and derives no fallback. An unset budget stays unset, an org with no
 * mirrored payments stays unpaid.
 */

export type CheckoutReason =
  /** Both legs hold: real money in AND this brand committed to spend. */
  | "checked_out"
  /** The org has no daily budget for this brand — it never committed this brand. */
  | "no_brand_budget"
  /** The brand is committed but the org never paid real money in. */
  | "org_never_paid";

export type OrgBrandCheckout = {
  orgId: string;
  brandId: string;
  checkedOut: boolean;
  reason: CheckoutReason;
  /** Raw cents string billing serves, or null when this org set no budget for the brand. */
  brandDailyBudgetCents: string | null;
  /** Gross paid in per currency; empty when the org has no mirrored payments. */
  orgPayments: OrgPaymentTotal[];
};

export type BrandCheckoutStatus =
  /** At least one claiming org completed checkout on this brand. */
  | "checked_out"
  /** The brand is claimed by at least one org and NONE of them completed checkout. */
  | "not_checked_out"
  /**
   * brand-service reports no org claiming this brand id: either the brand does
   * not exist, or it is a global brand row no org has claimed. Nobody can have
   * gone through checkout on it. client-service does not own brands and does not
   * probe brand existence separately — the by-id brand reads lazy-fill through a
   * platform-billed LLM extraction, which a status read must never trigger.
   */
  | "no_org_claims_brand";

export type BrandCheckout = {
  brandId: string;
  status: BrandCheckoutStatus;
  checkedOut: boolean;
  orgs: OrgBrandCheckout[];
};

/** Resolve the checkout verdict for one (org, brand) pair. */
export async function resolveOrgBrandCheckout(
  orgId: string,
  brandId: string,
): Promise<OrgBrandCheckout> {
  const [brandDailyBudgetCents, orgPayments] = await Promise.all([
    getBrandDailyBudgetCents(orgId, brandId),
    getOrgPaymentTotals(orgId),
  ]);

  const orgPaidIn = orgPayments.some((total) => total.amountReceivedCents > 0);
  const brandCommitted = brandDailyBudgetCents !== null;

  // Report the brand-specific miss first: it is the more precise statement about
  // this pair, and an org can be missing both legs at once.
  const reason: CheckoutReason = !brandCommitted
    ? "no_brand_budget"
    : !orgPaidIn
      ? "org_never_paid"
      : "checked_out";

  return {
    orgId,
    brandId,
    checkedOut: reason === "checked_out",
    reason,
    brandDailyBudgetCents,
    orgPayments,
  };
}

/** Resolve the checkout verdict for a brand across every org that claims it. */
export async function resolveBrandCheckout(brandId: string): Promise<BrandCheckout> {
  const claims = await listOrgsClaimingBrand(brandId);

  if (claims.length === 0) {
    return { brandId, status: "no_org_claims_brand", checkedOut: false, orgs: [] };
  }

  const orgIds = [...new Set(claims.map((claim) => claim.orgId))];
  const orgs = await Promise.all(orgIds.map((orgId) => resolveOrgBrandCheckout(orgId, brandId)));

  const checkedOut = orgs.some((org) => org.checkedOut);

  return {
    brandId,
    status: checkedOut ? "checked_out" : "not_checked_out",
    checkedOut,
    orgs,
  };
}

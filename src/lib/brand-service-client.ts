import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Error thrown when brand-service returns a non-2xx. Carries the upstream HTTP
 * status + body so the caller can fail loud with the real provider error.
 */
export class BrandServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[client-service] brand-service read failed (${status}): ${body}`);
    this.name = "BrandServiceError";
  }
}

/** One (brand, org) claim: brand-service's org_brands membership. */
export type BrandOrgClaim = {
  brandId: string;
  orgId: string;
  domain: string | null;
  name: string;
};

type BrandsAllResponse = {
  brands?: Array<{ id?: unknown; orgId?: unknown; domain?: unknown; name?: unknown }>;
};

/**
 * List every org that CLAIMS the given brand, via brand-service's
 * `GET /internal/brands/all` (the only endpoint exposing the brand -> org
 * membership edge; a brand claimed by N orgs yields N rows).
 *
 * We deliberately do NOT use `GET /internal/brands/{id}` or the batch
 * `GET /internal/brands?ids=` for this: neither returns the owning org, and both
 * LAZY-FILL the brand name through a platform-billed extract-fields LLM call.
 * A checkout-status read must never trigger paid enrichment. `/internal/brands/all`
 * is deterministic and does not scrape.
 *
 * Fail loud: any non-2xx throws BrandServiceError.
 */
export async function listOrgsClaimingBrand(brandId: string): Promise<BrandOrgClaim[]> {
  const baseUrl = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error("[client-service] BRAND_SERVICE_URL not configured");
  }
  if (!apiKey) {
    throw new Error("[client-service] BRAND_SERVICE_API_KEY not configured");
  }

  const url = `${baseUrl.replace(/\/$/, "")}/internal/brands/all`;
  const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } });

  if (!res.ok) {
    throw new BrandServiceError(res.status, await res.text());
  }

  const payload = (await res.json()) as BrandsAllResponse;
  const rows = Array.isArray(payload.brands) ? payload.brands : [];

  return rows
    .filter((row) => row.id === brandId && typeof row.orgId === "string")
    .map((row) => ({
      brandId,
      orgId: row.orgId as string,
      domain: typeof row.domain === "string" ? row.domain : null,
      name: typeof row.name === "string" ? row.name : "",
    }));
}

/**
 * List every brand the given org CLAIMS, via the same deterministic
 * `GET /internal/brands/all` read — the only endpoint exposing the brand -> org
 * membership edge, and the only one that does not lazy-fill a brand name through
 * a platform-billed LLM extraction.
 *
 * The question it answers is "has anybody built anything in this org?", asked of
 * an org the claim is about to take an identity away from. An empty list is a
 * real answer (nobody claimed anything); an unreachable brand-service is NOT —
 * it throws, and the claim refuses loudly rather than assuming emptiness.
 */
export async function listBrandsClaimedByOrg(orgId: string): Promise<BrandOrgClaim[]> {
  const { baseUrl, apiKey } = brandServiceConfig();

  const url = `${baseUrl}/internal/brands/all`;
  const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } });

  if (!res.ok) {
    throw new BrandServiceError(res.status, await res.text());
  }

  const payload = (await res.json()) as BrandsAllResponse;
  const rows = Array.isArray(payload.brands) ? payload.brands : [];

  return rows
    .filter((row) => row.orgId === orgId && typeof row.id === "string")
    .map((row) => ({
      brandId: row.id as string,
      orgId,
      domain: typeof row.domain === "string" ? row.domain : null,
      name: typeof row.name === "string" ? row.name : "",
    }));
}

/** One offer under a brand, as brand-service serves it. */
export type BrandOffer = {
  offerId: string;
  brandId: string;
  name: string;
};

/**
 * One ACTIVE sales funnel of an offer, as brand-service serves it.
 *
 * Only the fields the reward ledger reasons about are typed. `updatedAt` is kept
 * because it is the only anchor available the FIRST time we ever see a funnel —
 * but it is never treated as a confirmation that anybody refreshed anything: it
 * also moves when a funnel is merely switched off or back on.
 */
export type OfferSalesFunnel = {
  funnelKey: string;
  name: string;
  active: boolean;
  rates: Record<string, number | null>;
  arrows: Array<Record<string, unknown>>;
  lifetimeRevenueUsd: number | null;
  destinationUrl: string | null;
  bookingUrl: string | null;
  updatedAt: string | null;
  /** Everything brand-service served for this funnel, kept verbatim for bronze. */
  raw: Record<string, unknown>;
};

function brandServiceConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error("[client-service] BRAND_SERVICE_URL not configured");
  }
  if (!apiKey) {
    throw new Error("[client-service] BRAND_SERVICE_API_KEY not configured");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

/**
 * List the offers under a brand, via `GET /internal/brands/{brandId}/offers`.
 *
 * The org is passed explicitly: brand-service resolves it itself only when
 * exactly one org claims the brand, and we already know which org we are asking
 * about. An unclaimed brand answers 200 with an empty list — not an error.
 *
 * This read is deterministic and triggers no enrichment. We deliberately do NOT
 * reach for `GET /internal/brands/{id}`, which lazy-fills the brand name through
 * a platform-billed LLM extraction: a reward-status read must never cost money.
 *
 * Fail loud: any non-2xx throws BrandServiceError.
 */
export async function listBrandOffers(brandId: string, orgId: string): Promise<BrandOffer[]> {
  const { baseUrl, apiKey } = brandServiceConfig();

  const url = `${baseUrl}/internal/brands/${encodeURIComponent(brandId)}/offers`;
  const res = await fetchWithRetry(url, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });

  if (!res.ok) {
    throw new BrandServiceError(res.status, await res.text());
  }

  const payload = (await res.json()) as {
    offers?: Array<{ offerId?: unknown; brandId?: unknown; name?: unknown }>;
  };
  const rows = Array.isArray(payload.offers) ? payload.offers : [];

  return rows
    .filter((row) => typeof row.offerId === "string")
    .map((row) => ({
      offerId: row.offerId as string,
      brandId: typeof row.brandId === "string" ? row.brandId : brandId,
      name: typeof row.name === "string" ? row.name : "",
    }));
}

/**
 * List one offer's ACTIVE sales funnels, via
 * `GET /internal/offers/{offerId}/sales-funnels`.
 *
 * brand-service never lists a funnel that is switched off, so a funnel simply
 * DISAPPEARS from this read while it is inactive and reappears unchanged when it
 * is switched back on. The ledger treats a disappearance as nothing at all: it
 * neither completes a task nor resets a clock.
 *
 * Nothing is defaulted upstream — a value the brand never declared reads `null`,
 * which never means zero — and we pass those nulls straight through.
 *
 * Fail loud: any non-2xx throws BrandServiceError.
 */
export async function listOfferSalesFunnels(offerId: string): Promise<OfferSalesFunnel[]> {
  const { baseUrl, apiKey } = brandServiceConfig();

  const url = `${baseUrl}/internal/offers/${encodeURIComponent(offerId)}/sales-funnels`;
  const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } });

  if (!res.ok) {
    throw new BrandServiceError(res.status, await res.text());
  }

  const payload = (await res.json()) as { funnels?: unknown };
  const rows = Array.isArray(payload.funnels) ? (payload.funnels as Record<string, unknown>[]) : [];

  return rows
    .filter((row) => typeof row.funnelKey === "string")
    .map((row) => ({
      funnelKey: row.funnelKey as string,
      name: typeof row.name === "string" ? row.name : "",
      active: row.active === true,
      rates: (row.rates ?? {}) as Record<string, number | null>,
      arrows: Array.isArray(row.arrows) ? (row.arrows as Array<Record<string, unknown>>) : [],
      lifetimeRevenueUsd:
        typeof row.lifetimeRevenueUsd === "number" ? row.lifetimeRevenueUsd : null,
      destinationUrl: typeof row.destinationUrl === "string" ? row.destinationUrl : null,
      bookingUrl: typeof row.bookingUrl === "string" ? row.bookingUrl : null,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
      raw: row,
    }));
}

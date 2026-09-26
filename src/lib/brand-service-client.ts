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
 * Every (brand, org) claim held by ANY of the given orgs, via the same
 * deterministic
 * `GET /internal/brands/all` read — the only endpoint exposing the brand -> org
 * membership edge, and the only one that does not lazy-fill a brand name through
 * a platform-billed LLM extraction.
 *
 * Several orgs at once because the question the claim asks is comparative: a
 * brand claimed by the org holding an identity AND by the org claiming it is the
 * same customer's same brand, not somebody else's work. An empty list is a real
 * answer (nobody claimed anything); an unreachable brand-service is NOT — it
 * throws, and the claim refuses loudly rather than assuming emptiness.
 */
export async function listBrandClaimsForOrgs(orgIds: string[]): Promise<BrandOrgClaim[]> {
  const { baseUrl, apiKey } = brandServiceConfig();
  const wanted = new Set(orgIds);

  const url = `${baseUrl}/internal/brands/all`;
  const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } });

  if (!res.ok) {
    throw new BrandServiceError(res.status, await res.text());
  }

  const payload = (await res.json()) as BrandsAllResponse;
  const rows = Array.isArray(payload.brands) ? payload.brands : [];

  return rows
    .filter(
      (row) =>
        typeof row.orgId === "string" && wanted.has(row.orgId) && typeof row.id === "string",
    )
    .map((row) => ({
      brandId: row.id as string,
      orgId: row.orgId as string,
      domain: typeof row.domain === "string" ? row.domain : null,
      name: typeof row.name === "string" ? row.name : "",
    }));
}

/**
 * One leg rate of a brand, as brand-service serves it. Rates are stated per
 * (org, brand, leg) and shared by every offer of the brand. An unstated leg reads
 * `ratePct: null, stated: false` — never a zero, never a default.
 */
export type BrandLegRate = {
  fromStep: string;
  toStep: string;
  ratePct: number | null;
  stated: boolean;
  /** When this rate was last written. Also moves on an unchanged re-save. */
  statedAt: string | null;
};

/** One offer of a brand with its lifetime revenue, as brand-service serves it. */
export type OfferLifetimeRevenue = {
  offerId: string;
  name: string;
  /** What a paying client of this offer is worth, USD. `null` = never stated. */
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueStatedAt: string | null;
  /** Everything brand-service served for this offer, kept verbatim for bronze. */
  raw: Record<string, unknown>;
};

/** A brand's money economics: its leg rates and every offer's lifetime revenue. */
export type BrandOfferEconomics = {
  legRates: BrandLegRate[];
  offers: OfferLifetimeRevenue[];
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
 * Read a brand's money economics for one org, via
 * `GET /internal/brands/{brandId}/offer-economics`: the brand's leg rates (the
 * brand grain, shared by every offer) and each offer's lifetime revenue.
 *
 * The org is passed explicitly: brand-service resolves it itself only when
 * exactly one org claims the brand, and we already know which org we are asking
 * about. This read is deterministic and triggers no enrichment — a reward-status
 * read must never cost money.
 *
 * Nothing is defaulted upstream — a value the brand never stated reads `null`,
 * which never means zero — and we pass those nulls straight through.
 *
 * Fail loud: any non-2xx throws BrandServiceError.
 */
export async function readBrandOfferEconomics(
  brandId: string,
  orgId: string,
): Promise<BrandOfferEconomics> {
  const { baseUrl, apiKey } = brandServiceConfig();

  const url = `${baseUrl}/internal/brands/${encodeURIComponent(brandId)}/offer-economics`;
  const res = await fetchWithRetry(url, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });

  if (!res.ok) {
    throw new BrandServiceError(res.status, await res.text());
  }

  const payload = (await res.json()) as { legRates?: unknown; offers?: unknown };
  const legRows = Array.isArray(payload.legRates)
    ? (payload.legRates as Record<string, unknown>[])
    : [];
  const offerRows = Array.isArray(payload.offers)
    ? (payload.offers as Record<string, unknown>[])
    : [];

  return {
    legRates: legRows
      .filter((row) => typeof row.fromStep === "string" && typeof row.toStep === "string")
      .map((row) => ({
        fromStep: row.fromStep as string,
        toStep: row.toStep as string,
        ratePct: typeof row.ratePct === "number" ? row.ratePct : null,
        stated: row.stated === true,
        statedAt: typeof row.statedAt === "string" ? row.statedAt : null,
      })),
    offers: offerRows
      .filter((row) => typeof row.offerId === "string")
      .map((row) => ({
        offerId: row.offerId as string,
        name: typeof row.name === "string" ? row.name : "",
        lifetimeRevenueUsd:
          typeof row.lifetimeRevenueUsd === "number" ? row.lifetimeRevenueUsd : null,
        lifetimeRevenueStatedAt:
          typeof row.lifetimeRevenueStatedAt === "string" ? row.lifetimeRevenueStatedAt : null,
        raw: row,
      })),
  };
}

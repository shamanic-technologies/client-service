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

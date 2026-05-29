/**
 * Error thrown when stripe-service returns a non-2xx, non-404 failure deleting
 * a customer. Carries the upstream HTTP status + body so the route can fail
 * loud with the real provider error (never a swallowed 200).
 */
export class StripeServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[client-service] stripe-service customer delete failed (${status}): ${body}`);
    this.name = "StripeServiceError";
  }
}

export type StripeDeleteResult = "deleted";

/**
 * Delete an org's Stripe customer online (+ stripe-service mirror) by calling
 * stripe-service's internal teardown endpoint. Keyed by the internal org UUID
 * (matches stripe-service's `metadata.org_id`).
 *
 * Only a 2xx counts as success. Every non-2xx (INCLUDING 404) throws
 * StripeServiceError (fail loud). We deliberately do NOT treat 404 as
 * "already gone": stripe-service is a route we call, and a 404 is ambiguous
 * between "customer already absent" and "route not deployed yet / wrong path" —
 * swallowing it would silently leave the Stripe customer live while reporting
 * success. Idempotency for an already-deleted customer is stripe-service's
 * contract: it must return 2xx when there is nothing left to delete.
 */
export async function deleteStripeCustomerByOrg(orgId: string): Promise<StripeDeleteResult> {
  const baseUrl = process.env.STRIPE_SERVICE_URL;
  const apiKey = process.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error("[client-service] STRIPE_SERVICE_URL not configured");
  }
  if (!apiKey) {
    throw new Error("[client-service] STRIPE_SERVICE_API_KEY not configured");
  }

  const url = `${baseUrl.replace(/\/$/, "")}/internal/customers/by-org/${encodeURIComponent(orgId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "x-api-key": apiKey },
  });

  if (res.ok) return "deleted";

  const body = await res.text();
  throw new StripeServiceError(res.status, body);
}

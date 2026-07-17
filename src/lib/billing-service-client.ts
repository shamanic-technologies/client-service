import { randomUUID } from "node:crypto";

/**
 * Error thrown when billing-service returns a non-2xx creating/reading an org's
 * billing account. Carries the upstream HTTP status + body so the caller can
 * fail loud with the real provider error (never a swallowed 200).
 */
export class BillingServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[client-service] billing-service account provisioning failed (${status}): ${body}`);
    this.name = "BillingServiceError";
  }
}

/**
 * Trigger billing-service's signup/welcome path for a freshly-provisioned org
 * by calling its get-or-create account endpoint (`GET /v1/accounts`). On
 * first-create, billing-service creates the billing account, ensures the Stripe
 * customer, and redeems the welcome promo — i.e. the exact same welcome credit a
 * dashboard signup receives. We deliberately do NOT grant credit ourselves; this
 * reuses billing's existing path.
 *
 * Keyed by the org's internal UUID (`x-org-id`) + the user's internal UUID
 * (`x-user-id`), which is what billing's `requireOrgHeaders` expects. Idempotent:
 * a repeat call returns the existing account with no double-grant (welcome promo
 * redemption is unique per org in billing-service).
 *
 * Fail loud: any non-2xx throws BillingServiceError.
 */
export async function ensureBillingWelcome(orgId: string, userId: string): Promise<void> {
  const baseUrl = process.env.BILLING_SERVICE_URL;
  if (!baseUrl) {
    throw new Error("[client-service] BILLING_SERVICE_URL not configured");
  }
  const apiKey = process.env.BILLING_SERVICE_API_KEY;

  const url = `${baseUrl.replace(/\/$/, "")}/v1/accounts`;
  const headers: Record<string, string> = {
    "x-org-id": orgId,
    "x-user-id": userId,
    // billing's /v1/accounts requires x-run-id for run/cost tracking. This
    // channel-provisioning path has no inbound request run, so mint one (billing
    // treats run-id as a tracking value, not a validated FK).
    "x-run-id": randomUUID(),
  };
  // Send the service api-key too when configured (belt-and-suspenders for any
  // gateway-level auth); the route itself gates on the org/user headers.
  if (apiKey) headers["x-api-key"] = apiKey;

  const res = await fetch(url, { method: "GET", headers });

  if (res.ok) return;

  const body = await res.text();
  throw new BillingServiceError(res.status, body);
}

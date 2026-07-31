import { randomUUID } from "node:crypto";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Error thrown when billing-service returns a non-2xx. Carries the upstream HTTP
 * status + body so the caller can fail loud with the real provider error (never
 * a swallowed 200).
 */
export class BillingServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[client-service] billing-service call failed (${status}): ${body}`);
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

/**
 * Tell billing-service that `inviteeOrgId` signed up through `inviterOrgId`'s
 * invite link, via `POST /internal/referrals/claim`.
 *
 * billing owns every consequence: it opens the INVITEE's outstanding free-credit
 * promise carrying the referrer, and remembers who to pay when that promise is
 * earned. Nothing is granted here and nothing is granted there at claim time —
 * client-service moves no money and holds no amount.
 *
 * Field names are billing's, not ours: its `orgId` is the org being referred
 * (our invitee) and `referrerOrgId` is the inviter.
 *
 * Idempotent on billing's side too — a repeat claim of the same pair returns the
 * existing promise with `alreadyClaimed: true` rather than opening a second one.
 * That is a backstop, not our guard: the caller only calls this when
 * `invites.billing_notified_at` is still NULL.
 *
 * Fail loud: any non-2xx throws BillingServiceError, which the claim route turns
 * into a 502. In particular billing answers 409 when the invitee was already
 * referred by a DIFFERENT org — a real conflict a retry cannot resolve, so it
 * surfaces rather than being absorbed.
 */
export async function notifyReferralClaim(params: {
  inviterOrgId: string;
  inviteeOrgId: string;
}): Promise<void> {
  const baseUrl = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error("[client-service] BILLING_SERVICE_URL not configured");
  }
  if (!apiKey) {
    throw new Error("[client-service] BILLING_SERVICE_API_KEY not configured");
  }

  const url = `${baseUrl.replace(/\/$/, "")}/internal/referrals/claim`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      orgId: params.inviteeOrgId,
      referrerOrgId: params.inviterOrgId,
    }),
  });

  if (!res.ok) {
    throw new BillingServiceError(res.status, await res.text());
  }
}

/**
 * Read the daily spend ceiling org `orgId` has configured for brand `brandId`,
 * via billing-service `GET /internal/brands/{brandId}/daily-budget`.
 *
 * Returns the raw cents string billing serves, or `null` when the org has NO
 * budget configured for that brand — billing's own documented "legitimate unset
 * state". We pass `null` straight through: an absent budget is exactly the
 * signal that this org never committed this brand to spend, and substituting a
 * zero/default here would erase it.
 *
 * Fail loud: any non-2xx throws BillingServiceError.
 */
export async function getBrandDailyBudgetCents(
  orgId: string,
  brandId: string,
): Promise<string | null> {
  const baseUrl = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!baseUrl) {
    throw new Error("[client-service] BILLING_SERVICE_URL not configured");
  }
  if (!apiKey) {
    throw new Error("[client-service] BILLING_SERVICE_API_KEY not configured");
  }

  const url = `${baseUrl.replace(/\/$/, "")}/internal/brands/${encodeURIComponent(brandId)}/daily-budget`;
  const res = await fetchWithRetry(url, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });

  if (!res.ok) {
    throw new BillingServiceError(res.status, await res.text());
  }

  const payload = (await res.json()) as { dailyBudgetCents?: unknown };
  const raw = payload.dailyBudgetCents;
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

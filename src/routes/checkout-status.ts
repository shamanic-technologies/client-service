import { Router, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { BrandCheckoutParamsSchema, OrgBrandCheckoutParamsSchema } from "../schemas.js";
import { resolveBrandCheckout, resolveOrgBrandCheckout } from "../lib/checkout-status.js";
import { BillingServiceError } from "../lib/billing-service-client.js";
import { BrandServiceError } from "../lib/brand-service-client.js";
import { StripeServiceError } from "../lib/stripe-service-client.js";

const router = Router();

/**
 * Surface an upstream owner's failure as a 502 carrying its real status + body.
 *
 * Fail loud: a checkout verdict is a money question, so a partial read is never
 * downgraded to a "no" — the caller must be able to tell "nobody paid" from
 * "we could not find out".
 */
function handleUpstreamError(error: unknown, res: Response) {
  if (
    error instanceof BrandServiceError ||
    error instanceof BillingServiceError ||
    error instanceof StripeServiceError
  ) {
    console.error("[client-service] Checkout status upstream error:", error.message);
    return res.status(502).json({ error: error.message });
  }

  console.error("[client-service] Checkout status error:", error);
  return res.status(500).json({ error: "Failed to resolve checkout status" });
}

/**
 * GET /internal/brands/:brandId/checkout-status
 *
 * Has ANY org actually gone through checkout for this brand, and which?
 * See the OpenAPI description in `src/schemas.ts` and the definition of
 * "checked out" in `src/lib/checkout-status.ts`.
 */
router.get("/internal/brands/:brandId/checkout-status", requireApiKey, async (req, res) => {
  const parsed = BrandCheckoutParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
  }

  try {
    return res.status(200).json(await resolveBrandCheckout(parsed.data.brandId));
  } catch (error) {
    return handleUpstreamError(error, res);
  }
});

/**
 * GET /internal/orgs/:orgId/brands/:brandId/checkout-status
 *
 * Has THIS org gone through checkout for this brand? Same definition, no
 * brand-service membership lookup.
 */
router.get(
  "/internal/orgs/:orgId/brands/:brandId/checkout-status",
  requireApiKey,
  async (req, res) => {
    const parsed = OrgBrandCheckoutParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
    }

    const { orgId, brandId } = parsed.data;

    try {
      return res.status(200).json(await resolveOrgBrandCheckout(orgId, brandId));
    } catch (error) {
      return handleUpstreamError(error, res);
    }
  },
);

export default router;

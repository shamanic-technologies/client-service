import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { BrandRewardTasksParamsSchema, BrandRewardTasksHeadersSchema } from "../schemas.js";
import {
  resolveBrandRewardTasks,
  FunnelTimestampMissingError,
  RewardScopeAmbiguousError,
} from "../lib/reward-tasks.js";
import { BillingServiceError } from "../lib/billing-service-client.js";
import { BrandServiceError } from "../lib/brand-service-client.js";

const router = Router();

/**
 * GET /internal/brands/:brandId/reward-tasks
 *
 * The reward tasks of this brand's sales funnels: which exist, whether each is
 * DUE, since when, and when each was last DONE — plus a rollup so a superior
 * scope can state how many of its children have something due without restating
 * their tasks.
 *
 * This read OBSERVES. There is no background job: the customer is on the funnel's
 * page when they save their numbers and the dashboard re-reads this immediately
 * after, so the read that matters always happens, and a sweep nobody reads would
 * be worse than none. A refresh that completes a task is paid inside this call.
 *
 * Fail loud at every step. An upstream that could not answer is a 502, never a
 * defaulted "nothing is due" — a consumer must be able to tell "nothing is owed"
 * from "we could not find out". A billing-service failure is likewise a 502: the
 * completion stays recorded and undelivered, and the next call retries it.
 */
router.get("/internal/brands/:brandId/reward-tasks", requireApiKey, async (req, res) => {
  const params = BrandRewardTasksParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({ error: "Invalid parameters", details: params.error.flatten() });
  }

  const headers = BrandRewardTasksHeadersSchema.safeParse({
    "x-org-id": req.headers["x-org-id"],
  });
  if (!headers.success) {
    return res.status(400).json({ error: "Invalid x-org-id", details: headers.error.flatten() });
  }

  try {
    const result = await resolveBrandRewardTasks(
      params.data.brandId,
      headers.data["x-org-id"],
    );
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof RewardScopeAmbiguousError) {
      return res.status(400).json({
        error: "ORG_REQUIRED",
        details: error.message,
        orgIds: error.orgIds,
      });
    }

    if (
      error instanceof BrandServiceError ||
      error instanceof BillingServiceError ||
      error instanceof FunnelTimestampMissingError
    ) {
      console.error("[client-service] Reward tasks upstream error:", error.message);
      return res.status(502).json({ error: error.message });
    }

    console.error("[client-service] Reward tasks error:", error);
    return res.status(500).json({ error: "Failed to resolve reward tasks" });
  }
});

export default router;

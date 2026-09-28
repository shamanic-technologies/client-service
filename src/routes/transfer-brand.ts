import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { TransferBrandBodySchema } from "../schemas.js";
import { transferBrand } from "../lib/brand-transfer.js";

const router = Router();

/**
 * POST /internal/transfer-brand
 *
 * Fleet contract, called by brand-service's transfer orchestration: move every
 * row this service holds for `sourceBrandId` from `sourceOrgId` to
 * `targetOrgId` (re-labelling the brand to `targetBrandId` when given).
 * Idempotent — a replay finds nothing under the source org and reports zeros.
 * See `src/lib/brand-transfer.ts` for what moves and why money does not.
 */
router.post("/internal/transfer-brand", requireApiKey, async (req, res) => {
  const parsed = TransferBrandBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }

  try {
    const result = await transferBrand(parsed.data);
    if (!result.ok) {
      const status = result.refusal.reason === "target_org_not_found" ? 404 : 409;
      console.error("[client-service] transfer-brand refused:", JSON.stringify({ ...parsed.data, ...result.refusal }));
      return res.status(status).json({ error: result.refusal.reason, ...result.refusal });
    }

    console.log(
      `[client-service] transfer-brand: ${JSON.stringify(parsed.data)} moved ${JSON.stringify(result.updatedTables)}`,
    );
    return res.status(200).json({ updatedTables: result.updatedTables });
  } catch (error) {
    console.error("[client-service] transfer-brand error:", error);
    return res.status(500).json({ error: "Failed to transfer brand" });
  }
});

export default router;

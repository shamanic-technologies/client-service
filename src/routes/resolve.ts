import { Router } from "express";
import { db } from "../db/index.js";
import { requireApiKey } from "../middleware/auth.js";
import { ResolveBodySchema } from "../schemas.js";
import { resolveIdentity } from "../lib/resolve-identity.js";
import { recordFirstTouch } from "../lib/acquisition.js";

const router = Router();

/**
 * POST /internal/resolve - Resolve external IDs to internal UUIDs
 * Idempotent: creates org/user if they don't exist, returns existing if they do.
 *
 * `acquisition`, when supplied, is the org's FIRST TOUCH. It is recorded only if
 * the org has none yet; a later resolve carrying another one is ignored, so a
 * second visit can never move the credit.
 */
router.post("/internal/resolve", requireApiKey, async (req, res) => {
  try {
    const parsed = ResolveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { acquisition, ...identity } = parsed.data;
    const { org, user, orgCreated, userCreated } = await resolveIdentity(identity);

    if (acquisition !== undefined) {
      await recordFirstTouch(db, org.id, acquisition, "resolve");
    }

    return res.json({
      orgId: org.id,
      userId: user.id,
      orgCreated,
      userCreated,
    });
  } catch (error) {
    console.error("[client-service] Resolve error:", error);
    return res.status(500).json({ error: "Failed to resolve identity" });
  }
});

export default router;

import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { SignupFactsQuerySchema } from "../schemas.js";
import { ClerkServiceError } from "../lib/clerk-client.js";
import { readSignupFacts, reconcileSignupFacts } from "../lib/signup-facts.js";

const router = Router();

/**
 * GET /internal/signup-facts?since=&limit=
 *
 * Every real signup to distribute.you, as a dated append-only feed (see
 * src/lib/signup-facts.ts). crm-service copies it into the distribute.you
 * brand's people fact feed.
 */
router.get("/internal/signup-facts", requireApiKey, async (req, res) => {
  const parsed = SignupFactsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }
  try {
    return res.status(200).json(await readSignupFacts(parsed.data.since ?? 0, parsed.data.limit ?? 100));
  } catch (error) {
    console.error("[client-service] Signup-fact read failed:", error);
    return res.status(500).json({ error: "Failed to read signup facts" });
  }
});

/** POST /internal/signup-facts/reconcile — the minute tick's pass, on demand. */
router.post("/internal/signup-facts/reconcile", requireApiKey, async (_req, res) => {
  try {
    return res.status(200).json(await reconcileSignupFacts());
  } catch (error) {
    console.error("[client-service] Signup-fact reconciliation failed:", error);
    if (error instanceof ClerkServiceError) {
      return res.status(502).json({ error: "identity_provider_unavailable", message: error.message });
    }
    return res.status(500).json({ error: "Signup-fact reconciliation failed" });
  }
});

export default router;

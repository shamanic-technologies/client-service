import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { UserLinkedinProfileParamsSchema } from "../schemas.js";
import { readLinkedinProfile, resolveLinkedinProfile } from "../lib/user-linkedin-profile.js";

const router = Router();

/**
 * GET /internal/users/:userId/linkedin-profile — the stored answer, never spends.
 * `not_looked_up` until a resolve ran for the user's current email.
 */
router.get("/internal/users/:userId/linkedin-profile", requireApiKey, async (req, res) => {
  const parsed = UserLinkedinProfileParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid userId parameter", details: parsed.error.flatten() });
  }
  try {
    const answer = await readLinkedinProfile(parsed.data.userId);
    if (!answer) return res.status(404).json({ error: "User not found", reason: "user_not_found" });
    return res.json(answer);
  } catch (error) {
    console.error("[client-service] GET linkedin-profile error:", error);
    return res.status(500).json({ error: "Failed to read LinkedIn profile" });
  }
});

/**
 * POST /internal/users/:userId/linkedin-profile/resolve — resolve once, then
 * reuse. Idempotent: a stored answer is returned without asking the vendor.
 */
router.post("/internal/users/:userId/linkedin-profile/resolve", requireApiKey, async (req, res) => {
  const parsed = UserLinkedinProfileParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid userId parameter", details: parsed.error.flatten() });
  }
  try {
    const result = await resolveLinkedinProfile(parsed.data.userId);
    if (!result) return res.status(404).json({ error: "User not found", reason: "user_not_found" });
    return res.json({ ...result.answer, lookedUpNow: result.lookedUpNow });
  } catch (error) {
    console.error("[client-service] POST linkedin-profile/resolve error:", error);
    return res.status(502).json({
      error: error instanceof Error ? error.message : "Person lookup failed",
      reason: "person_lookup_unavailable",
    });
  }
});

export default router;

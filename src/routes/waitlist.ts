import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { waitlist } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  WaitlistRequestBodySchema,
  WaitlistPositionQuerySchema,
} from "../schemas.js";

const router = Router();

/**
 * POST /public/waitlist/request-access
 * Idempotent on email: first write wins (brandUrl + position preserved).
 */
router.post("/public/waitlist/request-access", requireApiKey, async (req, res) => {
  try {
    const parsed = WaitlistRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { email, brandUrl } = parsed.data;

    const [inserted] = await db
      .insert(waitlist)
      .values({ email, brandUrl })
      .onConflictDoNothing({ target: waitlist.email })
      .returning();

    if (inserted) {
      return res.json({ ok: true, position: inserted.position });
    }

    const [existing] = await db
      .select({ position: waitlist.position })
      .from(waitlist)
      .where(eq(waitlist.email, email))
      .limit(1);

    return res.json({ ok: true, position: existing.position });
  } catch (error) {
    console.error("[client-service] Waitlist request-access error:", error);
    return res.status(500).json({ error: "Failed to request waitlist access" });
  }
});

/**
 * GET /public/waitlist/position?email=...
 */
router.get("/public/waitlist/position", requireApiKey, async (req, res) => {
  try {
    const parsed = WaitlistPositionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid email", details: parsed.error.flatten() });
    }

    const { email } = parsed.data;

    const [row] = await db
      .select({ position: waitlist.position })
      .from(waitlist)
      .where(eq(waitlist.email, email))
      .limit(1);

    if (!row) {
      return res.status(404).json({ error: "Email not on waitlist" });
    }

    return res.json({ position: row.position });
  } catch (error) {
    console.error("[client-service] Waitlist position error:", error);
    return res.status(500).json({ error: "Failed to get waitlist position" });
  }
});

export default router;

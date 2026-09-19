import { Router } from "express";
import { inArray, isNull, isNotNull, or, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { OrgRealityBodySchema } from "../schemas.js";

const router = Router();

/**
 * POST /internal/orgs/real
 *
 * Which of these organisations are REAL?
 *
 * REAL = anything that is not an anonymous org still awaiting a claim. An org
 * that was never anonymous is real; an anonymous one that has since been
 * claimed is real (the person signed up, the org is theirs); an anonymous one
 * with no claim is an abandoned signed-out walk and is NOT real.
 *
 * Both halves of that come from columns this service WRITES — `anonymous_at`
 * at creation on the caller's declaration, `claimed_at` at the claim — never
 * from the shape of an external id. A consumer asking this question is acting
 * on behalf of a stranger with no account, so the answer carries nothing about
 * an org beyond its id: no name, no external identity, no timestamps.
 *
 * An id naming no org is simply absent from the answer (nobody real owns it),
 * which is the same thing the caller needs to know and leaks nothing about
 * whether the id exists.
 *
 * Fail loud: a read that could not be performed is a 500, never an empty list.
 * A defaulted "none of these are real" would let a real customer's domain be
 * handed to a stranger.
 */
router.post("/internal/orgs/real", requireApiKey, async (req, res) => {
  const parsed = OrgRealityBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }

  const { orgIds } = parsed.data;
  const unique = [...new Set(orgIds)];

  if (unique.length === 0) {
    return res.status(200).json({ realOrgIds: [] });
  }

  try {
    const rows = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(
        and(
          inArray(orgs.id, unique),
          or(isNull(orgs.anonymousAt), isNotNull(orgs.claimedAt)),
        ),
      );

    return res.status(200).json({ realOrgIds: rows.map((row) => row.id) });
  } catch (error) {
    console.error("[client-service] Org reality read failed:", error);
    return res.status(500).json({ error: "Failed to resolve org reality" });
  }
});

export default router;

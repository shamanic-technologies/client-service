import { Router } from "express";
import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, orgAcquisitions } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  RecordAcquisitionBodySchema,
  OrgAcquisitionParamsSchema,
  ListAcquisitionsQuerySchema,
} from "../schemas.js";
import { resolveIdentity } from "../lib/resolve-identity.js";
import { recordFirstTouch, readFirstTouch, serializeFirstTouch } from "../lib/acquisition.js";

const router = Router();

/**
 * POST /internal/acquisitions — hand over an org's FIRST TOUCH.
 *
 * Addressed by internal uuid (the anonymous org the dashboard created) or by
 * identity-provider ids (an ordinary signup; resolved exactly like
 * /internal/resolve). First hand-over wins; later ones are 200 `recorded: false`.
 */
router.post("/internal/acquisitions", requireApiKey, async (req, res) => {
  const parsed = RecordAcquisitionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const body = parsed.data;

  try {
    let orgId: string;
    let via: "org_id" | "external_ids";

    if ("orgId" in body) {
      const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, body.orgId)).limit(1);
      if (!org) return res.status(404).json({ error: "Org not found" });
      orgId = org.id;
      via = "org_id";
    } else {
      const { org } = await resolveIdentity({
        externalOrgId: body.externalOrgId,
        externalUserId: body.externalUserId,
      });
      orgId = org.id;
      via = "external_ids";
    }

    const recorded = await recordFirstTouch(db, orgId, body.acquisition, via);
    const stored = await readFirstTouch(db, orgId);
    if (!stored) {
      // Only reachable if the org was torn down between the two statements.
      throw new Error(`first touch for org ${orgId} vanished right after it was recorded`);
    }

    return res.json({ orgId, recorded, acquisition: serializeFirstTouch(stored) });
  } catch (error) {
    console.error("[client-service] Record acquisition error:", error);
    return res.status(500).json({ error: "Failed to record acquisition" });
  }
});

/** GET /internal/orgs/:orgId/acquisition — one org's first touch, or null. */
router.get("/internal/orgs/:orgId/acquisition", requireApiKey, async (req, res) => {
  const parsed = OrgAcquisitionParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
  }

  try {
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, parsed.data.orgId)).limit(1);
    if (!org) return res.status(404).json({ error: "Org not found" });

    const stored = await readFirstTouch(db, org.id);
    return res.json({ orgId: org.id, acquisition: stored ? serializeFirstTouch(stored) : null });
  } catch (error) {
    console.error("[client-service] Read acquisition error:", error);
    return res.status(500).json({ error: "Failed to read acquisition" });
  }
});

/**
 * GET /internal/acquisitions?createdAfter=&createdBefore= — every org created in
 * the window with its first touch. Shells are excluded (never a signup);
 * anonymous-unclaimed orgs are included with `real: false`.
 */
router.get("/internal/acquisitions", requireApiKey, async (req, res) => {
  const parsed = ListAcquisitionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  }
  const { createdAfter, createdBefore } = parsed.data;

  try {
    const rows = await db
      .select({ org: orgs, acquisition: orgAcquisitions })
      .from(orgs)
      .leftJoin(orgAcquisitions, eq(orgAcquisitions.orgId, orgs.id))
      .where(
        and(
          isNull(orgs.absorbedAt),
          gte(orgs.createdAt, new Date(createdAfter)),
          ...(createdBefore !== undefined ? [lt(orgs.createdAt, new Date(createdBefore))] : []),
        ),
      )
      .orderBy(desc(orgs.createdAt));

    return res.json({
      orgs: rows.map(({ org, acquisition }) => ({
        orgId: org.id,
        name: org.name,
        createdAt: org.createdAt.toISOString(),
        anonymous: org.anonymousAt !== null,
        claimedAt: org.claimedAt ? org.claimedAt.toISOString() : null,
        real: org.anonymousAt === null || org.claimedAt !== null,
        acquisition: acquisition ? serializeFirstTouch(acquisition) : null,
      })),
    });
  } catch (error) {
    console.error("[client-service] List acquisitions error:", error);
    return res.status(500).json({ error: "Failed to list acquisitions" });
  }
});

export default router;

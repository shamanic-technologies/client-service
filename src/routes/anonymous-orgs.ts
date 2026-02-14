import { Router } from "express";
import { db } from "../db/index.js";
import { anonymousOrgs } from "../db/schema.js";
import { eq, count } from "drizzle-orm";
import { requireApiKey } from "../middleware/auth.js";
import {
  UpdateAnonymousOrgBodySchema,
  AnonymousOrgIdParamSchema,
  AnonymousOrgListQuerySchema,
} from "../schemas.js";

const router = Router();

// List anonymous orgs by app ID
router.get("/anonymous-orgs", requireApiKey, async (req, res) => {
  try {
    const parsed = AnonymousOrgListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    }

    const { appId, limit, offset } = parsed.data;

    const [items, [{ total }]] = await Promise.all([
      db
        .select()
        .from(anonymousOrgs)
        .where(eq(anonymousOrgs.appId, appId))
        .limit(limit)
        .offset(offset)
        .orderBy(anonymousOrgs.createdAt),
      db
        .select({ total: count() })
        .from(anonymousOrgs)
        .where(eq(anonymousOrgs.appId, appId)),
    ]);

    return res.json({ anonymousOrgs: items, total, limit, offset });
  } catch (error) {
    console.error("List anonymous orgs error:", error);
    return res.status(500).json({ error: "Failed to list anonymous orgs" });
  }
});

// Get anonymous org by ID
router.get("/anonymous-orgs/:id", requireApiKey, async (req, res) => {
  try {
    const parsed = AnonymousOrgIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
    }

    const { id } = parsed.data;

    const [anonymousOrg] = await db
      .select()
      .from(anonymousOrgs)
      .where(eq(anonymousOrgs.id, id))
      .limit(1);

    if (!anonymousOrg) {
      return res.status(404).json({ error: "Anonymous org not found" });
    }

    return res.json({ anonymousOrg });
  } catch (error) {
    console.error("Get anonymous org error:", error);
    return res.status(500).json({ error: "Failed to get anonymous org" });
  }
});

// Update anonymous org
router.patch("/anonymous-orgs/:id", requireApiKey, async (req, res) => {
  try {
    const paramsParsed = AnonymousOrgIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      return res.status(400).json({ error: "Invalid parameters", details: paramsParsed.error.flatten() });
    }

    const bodyParsed = UpdateAnonymousOrgBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: bodyParsed.error.flatten() });
    }

    const { id } = paramsParsed.data;
    const updates = bodyParsed.data;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const [anonymousOrg] = await db
      .update(anonymousOrgs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(anonymousOrgs.id, id))
      .returning();

    if (!anonymousOrg) {
      return res.status(404).json({ error: "Anonymous org not found" });
    }

    return res.json({ anonymousOrg });
  } catch (error) {
    console.error("Update anonymous org error:", error);
    return res.status(500).json({ error: "Failed to update anonymous org" });
  }
});

export default router;

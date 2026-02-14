import { Router } from "express";
import { db } from "../db/index.js";
import { orgs } from "../db/schema.js";
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
        .from(orgs)
        .where(eq(orgs.appId, appId))
        .limit(limit)
        .offset(offset)
        .orderBy(orgs.createdAt),
      db
        .select({ total: count() })
        .from(orgs)
        .where(eq(orgs.appId, appId)),
    ]);

    return res.json({ orgs: items, total, limit, offset });
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

    const [org] = await db
      .select()
      .from(orgs)
      .where(eq(orgs.id, id))
      .limit(1);

    if (!org) {
      return res.status(404).json({ error: "Org not found" });
    }

    return res.json({ org });
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

    const [org] = await db
      .update(orgs)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(orgs.id, id))
      .returning();

    if (!org) {
      return res.status(404).json({ error: "Org not found" });
    }

    return res.json({ org });
  } catch (error) {
    console.error("Update anonymous org error:", error);
    return res.status(500).json({ error: "Failed to update anonymous org" });
  }
});

export default router;

import { Router } from "express";
import { db } from "../db/index.js";
import { anonymousUsers } from "../db/schema.js";
import { eq, and, count } from "drizzle-orm";
import { requireApiKey } from "../middleware/auth.js";
import {
  CreateAnonymousUserBodySchema,
  UpdateAnonymousUserBodySchema,
  AnonymousUserIdParamSchema,
  AnonymousUserListQuerySchema,
} from "../schemas.js";

const router = Router();

// Create or upsert anonymous user
router.post("/anonymous-users", requireApiKey, async (req, res) => {
  try {
    const parsed = CreateAnonymousUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { appId, email, ...rest } = parsed.data;

    const [anonymousUser] = await db
      .insert(anonymousUsers)
      .values({ appId, email, ...rest })
      .onConflictDoUpdate({
        target: [anonymousUsers.appId, anonymousUsers.email],
        set: {
          ...rest,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Check if it was created or updated by comparing timestamps
    const created = anonymousUser.createdAt.getTime() === anonymousUser.updatedAt.getTime();

    return res.json({ anonymousUser, created });
  } catch (error) {
    console.error("Create anonymous user error:", error);
    return res.status(500).json({ error: "Failed to create anonymous user" });
  }
});

// List anonymous users by app ID
router.get("/anonymous-users", requireApiKey, async (req, res) => {
  try {
    const parsed = AnonymousUserListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    }

    const { appId, limit, offset } = parsed.data;

    const [items, [{ total }]] = await Promise.all([
      db
        .select()
        .from(anonymousUsers)
        .where(eq(anonymousUsers.appId, appId))
        .limit(limit)
        .offset(offset)
        .orderBy(anonymousUsers.createdAt),
      db
        .select({ total: count() })
        .from(anonymousUsers)
        .where(eq(anonymousUsers.appId, appId)),
    ]);

    return res.json({ anonymousUsers: items, total, limit, offset });
  } catch (error) {
    console.error("List anonymous users error:", error);
    return res.status(500).json({ error: "Failed to list anonymous users" });
  }
});

// Get anonymous user by ID
router.get("/anonymous-users/:id", requireApiKey, async (req, res) => {
  try {
    const parsed = AnonymousUserIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
    }

    const { id } = parsed.data;

    const [anonymousUser] = await db
      .select()
      .from(anonymousUsers)
      .where(eq(anonymousUsers.id, id))
      .limit(1);

    if (!anonymousUser) {
      return res.status(404).json({ error: "Anonymous user not found" });
    }

    return res.json({ anonymousUser });
  } catch (error) {
    console.error("Get anonymous user error:", error);
    return res.status(500).json({ error: "Failed to get anonymous user" });
  }
});

// Update anonymous user
router.patch("/anonymous-users/:id", requireApiKey, async (req, res) => {
  try {
    const paramsParsed = AnonymousUserIdParamSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      return res.status(400).json({ error: "Invalid parameters", details: paramsParsed.error.flatten() });
    }

    const bodyParsed = UpdateAnonymousUserBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: bodyParsed.error.flatten() });
    }

    const { id } = paramsParsed.data;
    const updates = bodyParsed.data;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const [anonymousUser] = await db
      .update(anonymousUsers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(anonymousUsers.id, id))
      .returning();

    if (!anonymousUser) {
      return res.status(404).json({ error: "Anonymous user not found" });
    }

    return res.json({ anonymousUser });
  } catch (error) {
    console.error("Update anonymous user error:", error);
    return res.status(500).json({ error: "Failed to update anonymous user" });
  }
});

export default router;

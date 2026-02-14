import { Router } from "express";
import { db } from "../db/index.js";
import { users, orgs } from "../db/schema.js";
import { eq, count } from "drizzle-orm";
import { requireApiKey } from "../middleware/auth.js";
import {
  CreateAnonymousUserBodySchema,
  UpdateAnonymousUserBodySchema,
  AnonymousUserIdParamSchema,
  AnonymousUserListQuerySchema,
} from "../schemas.js";

const router = Router();

// Create or upsert anonymous user (auto-creates org if not provided)
router.post("/anonymous-users", requireApiKey, async (req, res) => {
  try {
    const parsed = CreateAnonymousUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { appId, email, orgId: providedOrgId, ...rest } = parsed.data;

    // Resolve or create org
    let org;
    if (providedOrgId) {
      const [existing] = await db
        .select()
        .from(orgs)
        .where(eq(orgs.id, providedOrgId))
        .limit(1);

      if (!existing) {
        return res.status(400).json({ error: "Org not found" });
      }
      org = existing;
    } else {
      [org] = await db
        .insert(orgs)
        .values({ appId, name: "Personal" })
        .returning();
    }

    const [user] = await db
      .insert(users)
      .values({ appId, email, orgId: org.id, ...rest })
      .onConflictDoUpdate({
        target: [users.appId, users.email],
        set: {
          ...rest,
          orgId: org.id,
          updatedAt: new Date(),
        },
      })
      .returning();

    // Check if it was created or updated by comparing timestamps
    const created = user.createdAt.getTime() === user.updatedAt.getTime();

    return res.json({ user, org, created });
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
        .from(users)
        .where(eq(users.appId, appId))
        .limit(limit)
        .offset(offset)
        .orderBy(users.createdAt),
      db
        .select({ total: count() })
        .from(users)
        .where(eq(users.appId, appId)),
    ]);

    return res.json({ users: items, total, limit, offset });
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

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user });
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

    const [user] = await db
      .update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user });
  } catch (error) {
    console.error("Update anonymous user error:", error);
    return res.status(500).json({ error: "Failed to update anonymous user" });
  }
});

export default router;

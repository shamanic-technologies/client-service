import { Router } from "express";
import { and, eq, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs } from "../db/schema.js";
import { requireApiKey, requireRunId } from "../middleware/auth.js";
import { GetUserParamsSchema, ListUsersQuerySchema } from "../schemas.js";

const router = Router();

/**
 * GET /users/:userId - Get a single user by internal UUID
 */
router.get("/users/:userId", requireApiKey, requireRunId, async (req, res) => {
  try {
    const parsed = GetUserParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid userId parameter", details: parsed.error.flatten() });
    }

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(eq(users.id, parsed.data.userId))
      .limit(1);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user });
  } catch (error) {
    console.error("Get user error:", error);
    return res.status(500).json({ error: "Failed to get user" });
  }
});

/**
 * GET /users - List users filtered by app and org
 */
router.get("/users", requireApiKey, requireRunId, async (req, res) => {
  try {
    const parsed = ListUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
    }

    const { orgId, externalOrgId, email, limit, offset } = parsed.data;

    // Resolve orgId from externalOrgId if needed
    let resolvedOrgId = orgId;
    if (!resolvedOrgId && externalOrgId) {
      const [org] = await db
        .select({ id: orgs.id })
        .from(orgs)
        .where(eq(orgs.externalId, externalOrgId))
        .limit(1);

      if (!org) {
        return res.json({ users: [], total: 0, limit, offset });
      }
      resolvedOrgId = org.id;
    }

    // Build where conditions
    const conditions: ReturnType<typeof eq>[] = [];
    if (resolvedOrgId) {
      conditions.push(eq(users.orgId, resolvedOrgId));
    }
    if (email) {
      conditions.push(eq(users.email, email));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Run data + count queries in parallel
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: users.id,
          externalId: users.externalId,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          imageUrl: users.imageUrl,
          phone: users.phone,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(users.createdAt),
      db
        .select({ total: count() })
        .from(users)
        .where(where),
    ]);

    return res.json({
      users: rows.map((u) => ({
        ...u,
        createdAt: u.createdAt.toISOString(),
      })),
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error("List users error:", error);
    return res.status(500).json({ error: "Failed to list users" });
  }
});

export default router;

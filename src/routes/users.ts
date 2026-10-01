import { Router } from "express";
import { and, eq, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { GetUserParamsSchema, ListUsersQuerySchema, UserOrgsParamsSchema } from "../schemas.js";
import { ClerkServiceError } from "../lib/clerk-client.js";
import { getUserOrganizations, MEMBERSHIP_CACHE_TTL_MS } from "../lib/user-memberships.js";

const router = Router();

/**
 * GET /internal/users/:userId - Get a single user by internal UUID
 */
router.get("/internal/users/:userId", requireApiKey, async (req, res) => {
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
 * GET /internal/users - List users filtered by app and org
 */
router.get("/internal/users", requireApiKey, async (req, res) => {
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
        return res.json({ users: [], total: 0, ...(limit !== undefined && { limit }), ...(offset !== undefined && { offset }) });
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
    let query = db
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
      .orderBy(users.createdAt)
      .$dynamic();

    if (limit !== undefined) {
      query = query.limit(limit);
    }
    if (offset !== undefined) {
      query = query.offset(offset);
    }

    const [rows, [{ total }]] = await Promise.all([
      query,
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
      ...(limit !== undefined && { limit }),
      ...(offset !== undefined && { offset }),
    });
  } catch (error) {
    console.error("List users error:", error);
    return res.status(500).json({ error: "Failed to list users" });
  }
});

/**
 * GET /internal/users/:userId/orgs - The organizations a user belongs to RIGHT NOW.
 *
 * Read from the identity provider (Clerk), never from `users.org_id` (the org
 * last active in the dashboard). Called by the gateway on every user-API-key
 * request, so Clerk's answer is reused for MEMBERSHIP_CACHE_TTL_MS: that is the
 * published staleness bound for a removal. Fail loud: Clerk unreachable is a
 * 502, never an empty list.
 */
router.get("/internal/users/:userId/orgs", requireApiKey, async (req, res) => {
  const parsed = UserOrgsParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid userId parameter", details: parsed.error.flatten() });
  }

  try {
    const result = await getUserOrganizations(parsed.data.userId);
    switch (result.kind) {
      case "user_not_found":
        return res.status(404).json({ error: "User not found", reason: "user_not_found" });
      case "identity_not_found":
        return res.status(404).json({
          error: "The identity provider does not know this user's identity",
          reason: "identity_not_found",
        });
      case "user_has_no_identity":
        return res.status(409).json({
          error: "User has no identity-provider id, so no membership set can be read",
          reason: "user_has_no_identity",
        });
      case "ok":
        return res.status(200).json({
          userId: result.userId,
          organizations: result.organizations,
          unresolved: result.unresolved,
          membershipsCheckedAt: result.checkedAt.toISOString(),
          maxStalenessSeconds: MEMBERSHIP_CACHE_TTL_MS / 1000,
        });
    }
  } catch (error) {
    if (error instanceof ClerkServiceError) {
      console.error("[client-service] Membership read: identity provider failed:", error.message);
      return res.status(502).json({
        error: `Could not read memberships from the identity provider (${error.status}): ${error.body}`,
        reason: "identity_provider_unavailable",
      });
    }
    console.error("[client-service] Membership read failed:", error);
    return res.status(500).json({ error: "Failed to read user organizations" });
  }
});

export default router;

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, orgs } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { ResolveBodySchema } from "../schemas.js";

const router = Router();

/**
 * POST /internal/resolve - Resolve external IDs to internal UUIDs
 * Idempotent: creates org/user if they don't exist, returns existing if they do.
 *
 * orgSlug, when supplied, is set on the org row only when the existing slug
 * is NULL (self-healing backfill from upstream Clerk org slug). Pre-existing
 * slugs are never overwritten — Clerk slugs are immutable per org.
 */
router.post("/internal/resolve", requireApiKey, async (req, res) => {
  try {
    const parsed = ResolveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { externalOrgId, externalUserId, email, firstName, lastName, imageUrl, orgName, orgSlug } = parsed.data;

    const orgInsertData = {
      externalId: externalOrgId,
      ...(orgName !== undefined && { name: orgName }),
      ...(orgSlug !== undefined && { slug: orgSlug }),
    };

    const orgUpdateSet: Record<string, unknown> = {
      ...(orgName !== undefined && { name: orgName }),
      updatedAt: new Date(),
    };
    if (orgSlug !== undefined) {
      orgUpdateSet.slug = sql`COALESCE(${orgs.slug}, ${orgSlug})`;
    }

    const [org] = await db
      .insert(orgs)
      .values(orgInsertData)
      .onConflictDoUpdate({
        target: [orgs.externalId],
        set: orgUpdateSet,
      })
      .returning();

    const orgCreated = org.createdAt.getTime() === org.updatedAt.getTime();

    const profileData = {
      ...(email !== undefined && { email }),
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(imageUrl !== undefined && { imageUrl }),
    };

    const [user] = await db
      .insert(users)
      .values({ externalId: externalUserId, orgId: org.id, ...profileData })
      .onConflictDoUpdate({
        target: [users.externalId],
        set: { ...profileData, orgId: org.id, updatedAt: new Date() },
      })
      .returning();

    const userCreated = user.createdAt.getTime() === user.updatedAt.getTime();

    return res.json({
      orgId: org.id,
      userId: user.id,
      orgCreated,
      userCreated,
    });
  } catch (error) {
    console.error("[client-service] Resolve error:", error);
    return res.status(500).json({ error: "Failed to resolve identity" });
  }
});

export default router;

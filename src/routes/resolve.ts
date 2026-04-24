import { Router } from "express";
import { db } from "../db/index.js";
import { users, orgs } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { ResolveBodySchema } from "../schemas.js";

const router = Router();

/**
 * POST /internal/resolve - Resolve external IDs to internal UUIDs
 * Idempotent: creates org/user if they don't exist, returns existing if they do.
 */
router.post("/internal/resolve", requireApiKey, async (req, res) => {
  try {
    const parsed = ResolveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const { externalOrgId, externalUserId, email, firstName, lastName, imageUrl, orgName } = parsed.data;

    // Upsert org with optional name
    const orgData = {
      ...(orgName !== undefined && { name: orgName }),
    };

    const [org] = await db
      .insert(orgs)
      .values({ externalId: externalOrgId, ...orgData })
      .onConflictDoUpdate({
        target: [orgs.externalId],
        set: { ...orgData, updatedAt: new Date() },
      })
      .returning();

    const orgCreated = org.createdAt.getTime() === org.updatedAt.getTime();

    // Upsert user with optional profile data
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
    console.error("Resolve error:", error);
    return res.status(500).json({ error: "Failed to resolve identity" });
  }
});

export default router;

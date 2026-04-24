import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { OrgMemberCheckParamsSchema } from "../schemas.js";

const router = Router();

/**
 * GET /internal/orgs/:orgId/members/:userId - Check if a user is a member of an org
 */
router.get("/internal/orgs/:orgId/members/:userId", requireApiKey, async (req, res) => {
  const parsed = OrgMemberCheckParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid parameters", details: parsed.error.flatten() });
  }

  const { orgId, userId } = parsed.data;

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1);

  if (!user) {
    return res.status(404).json({ error: "User is not a member of this org" });
  }

  return res.status(200).end();
});

export default router;

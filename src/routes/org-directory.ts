import { Router, type Response } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { GetUserParamsSchema, OrgNamesBodySchema } from "../schemas.js";
import { ClerkServiceError } from "../lib/clerk-client.js";
import { getOrgNamesByExternalId, getUserOrgs, IDENTITY_CACHE_TTL_MS } from "../lib/org-directory.js";

const router = Router();

const MAX_STALENESS_SECONDS = IDENTITY_CACHE_TTL_MS / 1000;

/**
 * "Could not ask the identity provider" is a 502 with the provider's own words,
 * never an empty list a caller would read as "member of nothing".
 */
function identityProviderError(res: Response, error: ClerkServiceError) {
  console.error("[client-service] Identity provider read failed:", error.message);
  return res.status(502).json({
    error: "identity_provider_unavailable",
    message: "Could not ask the identity provider (Clerk)",
    provider: "clerk",
    upstreamStatus: error.status,
    upstreamBody: error.body,
  });
}

/**
 * GET /internal/users/:userId/orgs — every org the user belongs to RIGHT NOW,
 * from Clerk, mapped to internal uuids. See the openapi description for the
 * staleness bound and the `unresolved` contract.
 */
router.get("/internal/users/:userId/orgs", requireApiKey, async (req, res) => {
  const parsed = GetUserParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid userId parameter", details: parsed.error.flatten() });
  }
  const { userId } = parsed.data;

  try {
    const [user] = await db
      .select({ externalId: users.externalId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return res.status(404).json({ error: "user_not_found" });
    if (!user.externalId) return res.status(422).json({ error: "user_has_no_identity" });

    const result = await getUserOrgs(user.externalId);
    if (result === "not_found") return res.status(404).json({ error: "identity_not_found" });

    return res.status(200).json({ userId, ...result, maxStalenessSeconds: MAX_STALENESS_SECONDS });
  } catch (error) {
    if (error instanceof ClerkServiceError) return identityProviderError(res, error);
    console.error("[client-service] List user orgs failed:", error);
    return res.status(500).json({ error: "Failed to list user orgs" });
  }
});

/**
 * POST /internal/orgs/names — display names for up to 500 internal org uuids in
 * one call. Clerk is the name source (our rows mostly carry none); an org Clerk
 * does not know falls back to the stored name.
 */
router.post("/internal/orgs/names", requireApiKey, async (req, res) => {
  const parsed = OrgNamesBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const unique = [...new Set(parsed.data.orgIds)];
  if (unique.length === 0) {
    return res.status(200).json({ orgs: [], missing: [], maxStalenessSeconds: MAX_STALENESS_SECONDS });
  }

  try {
    const rows = await db
      .select({ id: orgs.id, externalId: orgs.externalId, name: orgs.name })
      .from(orgs)
      .where(inArray(orgs.id, unique));
    const rowById = new Map(rows.map((r) => [r.id, r]));

    const externalIds = rows.flatMap((r) => (r.externalId ? [r.externalId] : []));
    const providerNames = await getOrgNamesByExternalId(externalIds);

    const found: { id: string; name: string | null }[] = [];
    const missing: string[] = [];
    for (const id of unique) {
      const row = rowById.get(id);
      if (!row) {
        missing.push(id);
        continue;
      }
      const providerName = row.externalId ? providerNames.get(row.externalId) : null;
      found.push({ id, name: providerName ?? row.name });
    }

    return res.status(200).json({ orgs: found, missing, maxStalenessSeconds: MAX_STALENESS_SECONDS });
  } catch (error) {
    if (error instanceof ClerkServiceError) return identityProviderError(res, error);
    console.error("[client-service] Org names read failed:", error);
    return res.status(500).json({ error: "Failed to resolve org names" });
  }
});

export default router;

import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { CreateOrgBodySchema } from "../schemas.js";
import { createClientOrg, OrgProvisionError } from "../lib/org-provisioning.js";
import { ClerkServiceError, clerkErrorMessage } from "../lib/clerk-client.js";

/**
 * POST /internal/orgs - Create an organization for a new client on behalf of
 * the acting user (src/lib/org-provisioning.ts). The gateway calls it for staff
 * only; this service checks the user exists and nothing else.
 */
const router = Router();

router.post("/internal/orgs", requireApiKey, async (req, res) => {
  const parsed = CreateOrgBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_request",
      message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }

  try {
    const org = await createClientOrg(parsed.data);
    return res.status(org.created ? 201 : 200).json(org);
  } catch (error) {
    if (error instanceof OrgProvisionError) {
      return res.status(404).json({ error: error.code, message: error.message });
    }
    if (error instanceof ClerkServiceError) {
      return res.status(502).json({ error: "identity_provider_failed", message: `Clerk: ${clerkErrorMessage(error.body)}` });
    }
    console.error("[client-service] org create failed:", error);
    return res.status(500).json({ error: "internal_error", message: error instanceof Error ? error.message : "Org create failed" });
  }
});

export default router;

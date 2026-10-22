import { Router, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { MemberInvitationsOrgParamsSchema, OrgMembershipLimitBodySchema } from "../schemas.js";
import { getMembershipLimit, setMembershipLimit } from "../lib/org-membership-limit.js";
import { OrgInvitationError } from "../lib/org-member-invitations.js";
import { ClerkServiceError, clerkErrorMessage } from "../lib/clerk-client.js";
import { errorReason } from "../lib/pg-error.js";

/**
 * How many people one org may hold (src/lib/org-membership-limit.ts): GET reads
 * it, PUT sets it. Staff only: the gateway gates it.
 */
const router = Router();

const STATUS: Partial<Record<OrgInvitationError["code"], number>> = {
  org_not_found: 404,
  org_has_no_identity: 409,
};

function invalid(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  return res.status(400).json({
    error: "invalid_request",
    message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  });
}

function fail(res: Response, error: unknown, what: string, refusable: boolean) {
  if (error instanceof OrgInvitationError && STATUS[error.code]) {
    return res.status(STATUS[error.code]!).json({ error: error.code, message: error.message });
  }
  if (error instanceof ClerkServiceError) {
    // A 4xx on a write is Clerk refusing the value (402 = beyond the Clerk plan).
    if (refusable && error.status >= 400 && error.status < 500 && error.status !== 404) {
      return res.status(422).json({ error: "limit_refused", message: `Clerk: ${clerkErrorMessage(error.body)}` });
    }
    return res.status(502).json({ error: "identity_provider_failed", message: `Clerk: ${clerkErrorMessage(error.body)}` });
  }
  console.error(`[client-service] ${what} failed:`, error);
  return res.status(500).json({ error: "internal_error", message: error instanceof Error ? errorReason(error) : `${what} failed` });
}

router.get("/internal/orgs/:orgId/membership-limit", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  if (!params.success) return invalid(res, params.error.issues);
  try {
    return res.json(await getMembershipLimit(params.data.orgId));
  } catch (error) {
    return fail(res, error, "read membership limit", false);
  }
});

router.put("/internal/orgs/:orgId/membership-limit", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  const body = OrgMembershipLimitBodySchema.safeParse(req.body);
  if (!params.success || !body.success) {
    return invalid(res, [...(params.error?.issues ?? []), ...(body.error?.issues ?? [])]);
  }
  try {
    return res.json(await setMembershipLimit(params.data.orgId, body.data.maxAllowedMemberships));
  } catch (error) {
    return fail(res, error, "set membership limit", true);
  }
});

export default router;

import { Router, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { MemberInvitationsOrgParamsSchema, OrgJoinLinkCreateBodySchema } from "../schemas.js";
import { ensureJoinLink, getJoinLink, revokeJoinLink } from "../lib/org-join-link.js";
import { OrgInvitationError } from "../lib/org-member-invitations.js";
import { ClerkServiceError, clerkErrorMessage } from "../lib/clerk-client.js";

/**
 * An org's shareable join link (src/lib/org-join-link.ts): GET reads it, POST
 * mints it (or returns the existing one), DELETE revokes it. Staff only: the
 * gateway gates it.
 */
const router = Router();

const STATUS: Partial<Record<OrgInvitationError["code"], number>> = {
  org_not_found: 404,
  org_has_no_identity: 409,
  user_not_found: 404,
};

function invalid(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  return res.status(400).json({
    error: "invalid_request",
    message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  });
}

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof OrgInvitationError && STATUS[error.code]) {
    return res.status(STATUS[error.code]!).json({ error: error.code, message: error.message });
  }
  if (error instanceof ClerkServiceError) {
    return res.status(502).json({ error: "identity_provider_failed", message: `Clerk: ${clerkErrorMessage(error.body)}` });
  }
  console.error(`[client-service] ${what} failed:`, error);
  return res.status(500).json({ error: "internal_error", message: error instanceof Error ? error.message : `${what} failed` });
}

router.get("/internal/orgs/:orgId/join-link", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  if (!params.success) return invalid(res, params.error.issues);
  try {
    return res.json({ link: await getJoinLink(params.data.orgId) });
  } catch (error) {
    return fail(res, error, "read join link");
  }
});

router.post("/internal/orgs/:orgId/join-link", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  const body = OrgJoinLinkCreateBodySchema.safeParse(req.body);
  if (!params.success || !body.success) {
    return invalid(res, [...(params.error?.issues ?? []), ...(body.error?.issues ?? [])]);
  }
  try {
    const out = await ensureJoinLink({ orgId: params.data.orgId, createdByUserId: body.data.createdByUserId });
    return res.status(out.created ? 201 : 200).json(out);
  } catch (error) {
    return fail(res, error, "mint join link");
  }
});

router.delete("/internal/orgs/:orgId/join-link", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  if (!params.success) return invalid(res, params.error.issues);
  try {
    return res.json(await revokeJoinLink(params.data.orgId));
  } catch (error) {
    return fail(res, error, "revoke join link");
  }
});

export default router;

import { Router, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import {
  MemberInvitationCreateBodySchema,
  MemberInvitationParamsSchema,
  MemberInvitationsOrgParamsSchema,
} from "../schemas.js";
import {
  inviteMember,
  listPendingInvitations,
  OrgInvitationError,
  revokeInvitation,
} from "../lib/org-member-invitations.js";
import { ClerkServiceError, clerkErrorMessage } from "../lib/clerk-client.js";
import { errorReason } from "../lib/pg-error.js";

/**
 * Invite a person into an org by email, list the pending invitations, revoke
 * one (src/lib/org-member-invitations.ts). Any member may do it; the gateway
 * scopes the org to the authenticated caller.
 */
const router = Router();

const STATUS: Record<OrgInvitationError["code"], number> = {
  org_not_found: 404,
  user_not_found: 404,
  invitation_not_found: 404,
  org_has_no_identity: 409,
  invite_link_unavailable: 502,
};

function invalid(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  return res.status(400).json({
    error: "invalid_request",
    message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  });
}

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof OrgInvitationError) {
    return res.status(STATUS[error.code]).json({ error: error.code, message: error.message });
  }
  if (error instanceof ClerkServiceError) {
    // Clerk's 4xx is a refusal a person can act on (already a member, already
    // accepted, inviter not allowed): say it in Clerk's words. Anything else is
    // Clerk failing.
    if (error.status >= 400 && error.status < 500) {
      return res.status(422).json({ error: "invitation_refused", message: clerkErrorMessage(error.body) });
    }
    return res.status(502).json({ error: "identity_provider_failed", message: `Clerk: ${clerkErrorMessage(error.body)}` });
  }
  console.error(`[client-service] member invitation ${what} failed:`, error);
  return res.status(500).json({ error: "internal_error", message: error instanceof Error ? errorReason(error) : `${what} failed` });
}

router.post("/internal/orgs/:orgId/member-invitations", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  if (!params.success) return invalid(res, params.error.issues);
  const body = MemberInvitationCreateBodySchema.safeParse(req.body);
  if (!body.success) return invalid(res, body.error.issues);

  try {
    const { invitation, created } = await inviteMember({ orgId: params.data.orgId, ...body.data });
    return res.status(created ? 201 : 200).json({ invitation, created });
  } catch (error) {
    return fail(res, error, "create");
  }
});

router.get("/internal/orgs/:orgId/member-invitations", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  if (!params.success) return invalid(res, params.error.issues);

  try {
    return res.status(200).json({ invitations: await listPendingInvitations(params.data.orgId) });
  } catch (error) {
    return fail(res, error, "list");
  }
});

router.delete("/internal/orgs/:orgId/member-invitations/:invitationId", requireApiKey, async (req, res) => {
  const params = MemberInvitationParamsSchema.safeParse(req.params);
  if (!params.success) return invalid(res, params.error.issues);

  try {
    return res.status(200).json({ invitation: await revokeInvitation(params.data.orgId, params.data.invitationId) });
  } catch (error) {
    return fail(res, error, "revoke");
  }
});

export default router;

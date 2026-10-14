import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { OrgMemberAddBodySchema, MemberInvitationsOrgParamsSchema, OrgMemberParamsSchema } from "../schemas.js";
import { addOrgMember, removeOrgMember } from "../lib/org-members.js";
import { OrgInvitationError } from "../lib/org-member-invitations.js";
import { ClerkServiceError, clerkErrorMessage } from "../lib/clerk-client.js";

/**
 * Add a person (by email) to an org as a member, sending them nothing
 * (src/lib/org-members.ts). Staff only: the gateway gates it and mints the
 * person's own API key from the returned user.
 */
const router = Router();

const STATUS: Partial<Record<OrgInvitationError["code"], number>> = {
  org_not_found: 404,
  org_has_no_identity: 409,
  user_not_found: 404,
};

router.post("/internal/orgs/:orgId/members", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  const body = OrgMemberAddBodySchema.safeParse(req.body);
  if (!params.success || !body.success) {
    const issues = [...(params.error?.issues ?? []), ...(body.error?.issues ?? [])];
    return res.status(400).json({
      error: "invalid_request",
      message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }

  try {
    const added = await addOrgMember({ orgId: params.data.orgId, email: body.data.email });
    return res.status(added.membershipCreated ? 201 : 200).json(added);
  } catch (error) {
    if (error instanceof OrgInvitationError && STATUS[error.code]) {
      return res.status(STATUS[error.code]!).json({ error: error.code, message: error.message });
    }
    if (error instanceof ClerkServiceError) {
      if (error.status >= 400 && error.status < 500) {
        return res.status(422).json({ error: "member_refused", message: clerkErrorMessage(error.body) });
      }
      return res.status(502).json({ error: "identity_provider_failed", message: `Clerk: ${clerkErrorMessage(error.body)}` });
    }
    console.error("[client-service] add org member failed:", error);
    return res.status(500).json({ error: "internal_error", message: error instanceof Error ? error.message : "add member failed" });
  }
});

/**
 * Take a person out of an org (src/lib/org-members.ts). Staff only: the gateway
 * gates it. Idempotent: a person who is not a member is a 200 with
 * `membershipRemoved: false`.
 */
router.delete("/internal/orgs/:orgId/members/:userId", requireApiKey, async (req, res) => {
  const params = OrgMemberParamsSchema.safeParse(req.params);
  if (!params.success) {
    return res.status(400).json({
      error: "invalid_request",
      message: params.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
  }

  try {
    return res.json(await removeOrgMember(params.data));
  } catch (error) {
    if (error instanceof OrgInvitationError && STATUS[error.code]) {
      return res.status(STATUS[error.code]!).json({ error: error.code, message: error.message });
    }
    if (error instanceof ClerkServiceError) {
      if (error.status >= 400 && error.status < 500) {
        return res.status(422).json({ error: "member_removal_refused", message: clerkErrorMessage(error.body) });
      }
      return res.status(502).json({ error: "identity_provider_failed", message: `Clerk: ${clerkErrorMessage(error.body)}` });
    }
    console.error("[client-service] remove org member failed:", error);
    return res.status(500).json({ error: "internal_error", message: error instanceof Error ? error.message : "remove member failed" });
  }
});

export default router;

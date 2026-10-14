import { getClerkOrganizationMembershipLimit, setClerkOrganizationMembershipLimit } from "./clerk-client.js";
import { clerkOrgIdOf } from "./org-member-invitations.js";

/**
 * How many people one org may hold, service to service (the gateway, for staff
 * through the distribute MCP).
 *
 * The limit is Clerk's own (`max_allowed_memberships` on the Clerk
 * organization): Clerk refuses a join, an invitation acceptance or a membership
 * past it ("We could not add you to the team" on the join link). Nobody here
 * chose a number: every org, new or old, carries the Clerk INSTANCE default,
 * set to the highest value the Clerk plan allows (20 on 2026-10-14; "no limit"
 * is a paid Clerk feature and is refused with a 402). This route exists so a
 * single org can be moved off that default when somebody decides to.
 *
 * `null` = no limit (Clerk's 0). A value the Clerk plan does not allow is
 * Clerk's refusal, served in Clerk's words, never clamped to something else.
 */

export interface OrgMembershipLimit {
  /** null = no limit. */
  maxAllowedMemberships: number | null;
  membersCount: number;
}

function serve(limit: { maxAllowedMemberships: number; membersCount: number }): OrgMembershipLimit {
  return {
    maxAllowedMemberships: limit.maxAllowedMemberships === 0 ? null : limit.maxAllowedMemberships,
    membersCount: limit.membersCount,
  };
}

export async function getMembershipLimit(orgId: string): Promise<OrgMembershipLimit> {
  return serve(await getClerkOrganizationMembershipLimit(await clerkOrgIdOf(orgId)));
}

export async function setMembershipLimit(orgId: string, maxAllowedMemberships: number | null): Promise<OrgMembershipLimit> {
  const clerkOrgId = await clerkOrgIdOf(orgId);
  const out = serve(await setClerkOrganizationMembershipLimit(clerkOrgId, maxAllowedMemberships ?? 0));
  console.log(`[client-service] membership limit of org=${orgId} set to ${maxAllowedMemberships ?? "none"}`);
  return out;
}

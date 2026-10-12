import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs, users } from "../db/schema.js";
import {
  createClerkOrgInvitation,
  listClerkPendingInvitations,
  revokeClerkOrgInvitation,
  type ClerkOrgInvitation,
} from "./clerk-client.js";

/**
 * Inviting a person into an organization by email, service to service (the
 * gateway, for the distribute MCP). Clerk owns the invitation: it stores it,
 * emails it, and turns the link into a membership. This module states our side
 * of it, the same as the dashboard's own invite form (`apps/dashboard/src/lib/org-invite.ts`):
 * everyone is invited as an admin (one role per team, owner 2026-09-28), and
 * the link lands on the dashboard's `/invite` page, which turns the ticket into
 * an account inside THIS org.
 *
 * Who may invite into which org is the gateway's call (it scopes the org to the
 * authenticated caller); this service checks the org and the inviter exist.
 */

export const INVITE_ROLE = "org:admin";

const DEFAULT_DASHBOARD_URL = "https://dashboard.distribute.you";

function dashboardUrl(): string {
  return (process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/+$/, "");
}

export function inviteRedirectUrl(clerkOrgId: string): string {
  return `${dashboardUrl()}/invite?org=${encodeURIComponent(clerkOrgId)}`;
}

export class OrgInvitationError extends Error {
  constructor(
    public readonly code: "org_not_found" | "org_has_no_identity" | "user_not_found" | "invitation_not_found" | "invite_link_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "OrgInvitationError";
  }
}

export interface MemberInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  inviteUrl: string | null;
  createdAt: string;
  expiresAt: string;
}

function serve(i: ClerkOrgInvitation): MemberInvitation {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    status: i.status,
    inviteUrl: i.url,
    createdAt: new Date(i.createdAt).toISOString(),
    expiresAt: new Date(i.expiresAt).toISOString(),
  };
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The org's identity-provider id. An org with none to invite into (a signed-out
 * onboarding org not yet claimed, or a shell whose identity went elsewhere) is
 * refused by name rather than sent to Clerk with an id Clerk never issued.
 */
async function clerkOrgIdOf(orgId: string): Promise<string> {
  const [org] = await db
    .select({ externalId: orgs.externalId, anonymousAt: orgs.anonymousAt, claimedAt: orgs.claimedAt, absorbedAt: orgs.absorbedAt })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  if (!org) throw new OrgInvitationError("org_not_found", "No org has this id.");
  if (!org.externalId || org.absorbedAt || (org.anonymousAt && !org.claimedAt)) {
    throw new OrgInvitationError(
      "org_has_no_identity",
      "This org has no account to invite people into yet (signed-out onboarding not claimed, or an absorbed shell).",
    );
  }
  return org.externalId;
}

async function clerkUserIdOf(userId: string): Promise<string> {
  const [user] = await db.select({ externalId: users.externalId }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.externalId) {
    throw new OrgInvitationError("user_not_found", "No user with an identity-provider account has this id.");
  }
  return user.externalId;
}

/**
 * Invite `email`. Idempotent per (org, email) while an invitation is pending:
 * the pending one is returned (`created: false`), never a second one.
 */
export async function inviteMember(input: {
  orgId: string;
  email: string;
  invitedByUserId: string;
}): Promise<{ invitation: MemberInvitation; created: boolean }> {
  const clerkOrgId = await clerkOrgIdOf(input.orgId);
  const inviterClerkUserId = await clerkUserIdOf(input.invitedByUserId);
  const email = normalizeEmail(input.email);

  const pending = (await listClerkPendingInvitations(clerkOrgId)).find((i) => normalizeEmail(i.email) === email);
  if (pending) return { invitation: serve(pending), created: false };

  const created = await createClerkOrgInvitation({
    clerkOrgId,
    email,
    role: INVITE_ROLE,
    inviterClerkUserId,
    redirectUrl: inviteRedirectUrl(clerkOrgId),
  });
  if (!created.url) {
    // Clerk emailed it, but the caller asked for a link to forward and got none.
    throw new OrgInvitationError(
      "invite_link_unavailable",
      `The invitation ${created.id} was created and emailed, but the identity provider returned no link.`,
    );
  }
  return { invitation: serve(created), created: true };
}

export async function listPendingInvitations(orgId: string): Promise<MemberInvitation[]> {
  const clerkOrgId = await clerkOrgIdOf(orgId);
  return (await listClerkPendingInvitations(clerkOrgId)).map(serve);
}

export async function revokeInvitation(orgId: string, invitationId: string): Promise<MemberInvitation> {
  const clerkOrgId = await clerkOrgIdOf(orgId);
  const revoked = await revokeClerkOrgInvitation(clerkOrgId, invitationId);
  if (revoked === "not_found") {
    throw new OrgInvitationError("invitation_not_found", "This org has no invitation with this id.");
  }
  return serve(revoked);
}

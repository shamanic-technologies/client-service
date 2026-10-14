import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { getClerkOrganizationPrivate, setClerkOrganizationPrivateKey } from "./clerk-client.js";
import { clerkOrgIdOf, OrgInvitationError } from "./org-member-invitations.js";

/**
 * An org's shareable JOIN LINK, service to service (the gateway, for staff
 * through the distribute MCP). Whoever opens it signs in or signs up on the
 * dashboard with ANY email and becomes an admin of the org (one role per team).
 *
 * This is the SAME link as the dashboard's own Team page (`/api/orgs/invite-link`
 * in distribute.you), not a second one: it lives on the Clerk organization's
 * privateMetadata as `inviteLink: { code, createdAt, createdBy }`, and the
 * dashboard's `/join/<clerkOrgId>.<code>` page + `/api/join` route turn it into a
 * membership, comparing the code on every join. So a link minted here shows on
 * the Team page, and a revoke from either side kills it at once (the join page
 * then says "This invite link is no longer valid. Ask your team for a new one.").
 * Keep the stored shape byte-equal to `apps/dashboard/src/lib/org-invite-link-store.ts`.
 *
 * One link per org; minting returns the existing one. No expiry (owner
 * 2026-09-28, the dashboard's rule): the guards are revoke, and the dashboard
 * emailing the org's other (non-staff) admins when somebody joins. Minting sends
 * nothing to anyone.
 */

const INVITE_LINK_KEY = "inviteLink";
const DEFAULT_DASHBOARD_URL = "https://dashboard.distribute.you";
/** The dashboard's `cleanName` bound for the greeting name the link carries. */
const MAX_GREETING_NAME = 80;

function dashboardUrl(): string {
  return (process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/+$/, "");
}

interface StoredInviteLink {
  code: string;
  createdAt: string;
  createdBy: string;
}

/** Same reader as the dashboard's `readInviteLink`: anything malformed is no link. */
function readInviteLink(privateMetadata: Record<string, unknown>): StoredInviteLink | null {
  const link = privateMetadata[INVITE_LINK_KEY];
  if (typeof link !== "object" || link === null) return null;
  const l = link as Record<string, unknown>;
  return typeof l.code === "string" && typeof l.createdAt === "string" && typeof l.createdBy === "string"
    ? { code: l.code, createdAt: l.createdAt, createdBy: l.createdBy }
    : null;
}

/**
 * The URL the dashboard serves for this link. The org name rides as `bn` so the
 * page (and its link preview) greets "Join the <name> team"; display only, the
 * dashboard re-validates it.
 */
export function joinLinkUrl(clerkOrgId: string, code: string, orgName: string | null): string {
  const base = `${dashboardUrl()}/join/${encodeURIComponent(`${clerkOrgId}.${code}`)}`;
  const name = orgName?.trim();
  return name && name.length <= MAX_GREETING_NAME ? `${base}?${new URLSearchParams({ bn: name })}` : base;
}

export interface OrgJoinLink {
  url: string;
  createdAt: string;
}

function serve(clerkOrgId: string, orgName: string, link: StoredInviteLink): OrgJoinLink {
  return { url: joinLinkUrl(clerkOrgId, link.code, orgName), createdAt: link.createdAt };
}

export async function getJoinLink(orgId: string): Promise<OrgJoinLink | null> {
  const clerkOrgId = await clerkOrgIdOf(orgId);
  const org = await getClerkOrganizationPrivate(clerkOrgId, "GET");
  const link = readInviteLink(org.privateMetadata);
  return link ? serve(clerkOrgId, org.name, link) : null;
}

/** The org's link, minted when it has none (`created: true`). */
export async function ensureJoinLink(input: {
  orgId: string;
  createdByUserId: string;
}): Promise<{ link: OrgJoinLink; created: boolean }> {
  const clerkOrgId = await clerkOrgIdOf(input.orgId);
  const [creator] = await db
    .select({ externalId: users.externalId })
    .from(users)
    .where(eq(users.id, input.createdByUserId))
    .limit(1);
  if (!creator?.externalId) {
    throw new OrgInvitationError("user_not_found", "No user with an identity-provider account has this id.");
  }

  const org = await getClerkOrganizationPrivate(clerkOrgId, "POST");
  const existing = readInviteLink(org.privateMetadata);
  if (existing) return { link: serve(clerkOrgId, org.name, existing), created: false };

  const link: StoredInviteLink = {
    code: randomBytes(18).toString("base64url"),
    createdAt: new Date().toISOString(),
    createdBy: creator.externalId,
  };
  await setClerkOrganizationPrivateKey(clerkOrgId, INVITE_LINK_KEY, link, "POST");
  console.log(`[client-service] join link minted for org=${input.orgId} by user=${input.createdByUserId}`);
  return { link: serve(clerkOrgId, org.name, link), created: true };
}

/** Kill the org's link at once. Idempotent: `revoked: false` when it had none. */
export async function revokeJoinLink(orgId: string): Promise<{ revoked: boolean }> {
  const clerkOrgId = await clerkOrgIdOf(orgId);
  const org = await getClerkOrganizationPrivate(clerkOrgId, "DELETE");
  if (!readInviteLink(org.privateMetadata)) return { revoked: false };
  await setClerkOrganizationPrivateKey(clerkOrgId, INVITE_LINK_KEY, null, "DELETE");
  console.log(`[client-service] join link revoked for org=${orgId}`);
  return { revoked: true };
}

import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { getPlatformKey, type CallerInfo } from "./key-service-client.js";

/**
 * Error thrown when Clerk returns a non-404 failure deleting an organization.
 * Carries the upstream HTTP status + body so the route can fail loud with the
 * real provider error (never a swallowed 200).
 */
export class ClerkServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[client-service] Clerk operation failed (${status}): ${body}`);
    this.name = "ClerkServiceError";
  }
}

/** key-service provider name holding the Clerk backend secret. */
const CLERK_PROVIDER = "clerk";

/**
 * Clerk client memoized against the secret it was built with. Keying the cache on
 * the secret — rather than caching unconditionally — means a key rotation in
 * key-service swaps the client on the next call instead of pinning the dead
 * secret for the life of the process.
 */
let cached: { secretKey: string; client: ClerkClient } | null = null;

/**
 * Build (or reuse) a Clerk client, resolving the secret from key-service.
 *
 * The secret deliberately does NOT live in this service's Railway env: it is a
 * shared platform secret like every other one in the fleet, registered into
 * key-service by the app that owns it. `caller` names the route asking for it so
 * key-service can track which of our endpoints depend on Clerk.
 *
 * Fail loud: an unresolvable secret throws and the Clerk operation never runs.
 */
async function getClerkClient(caller: CallerInfo): Promise<ClerkClient> {
  const secretKey = await getPlatformKey(CLERK_PROVIDER, caller);
  if (!cached || cached.secretKey !== secretKey) {
    cached = { secretKey, client: createClerkClient({ secretKey }) };
  }
  return cached.client;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 404
  );
}

function errorStatus(err: unknown): number {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return 502;
}

function errorBody(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { errors?: unknown; message?: unknown };
    if (e.errors !== undefined) return JSON.stringify(e.errors);
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
}

export type ClerkDeleteResult = "deleted" | "not_found";

export interface ClerkPhoneAccount {
  clerkUserId: string;
  clerkOrgId: string;
}

/**
 * Domain for the synthetic placeholder email a phone-origin Clerk user is keyed
 * on. Overridable via env; the default is a subdomain we control so the address
 * never collides with a real person's inbox. Never receives mail — the user is
 * admin-created (Clerk marks the address verified without sending anything).
 */
function phoneAccountEmailDomain(): string {
  return process.env.PHONE_ACCOUNT_EMAIL_DOMAIN || "phone.distribute.you";
}

/**
 * Deterministic synthetic email for a phone-origin account: `wa-<e164digits>@<domain>`.
 * Deterministic (not random) so a retry after a half-completed provision reuses
 * the same address rather than orphaning a second Clerk user.
 */
export function syntheticPhoneEmail(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `wa-${digits}@${phoneAccountEmailDomain()}`;
}

/**
 * Create a signup-equivalent Clerk identity for a phone number: a Clerk user
 * keyed on a synthetic placeholder EMAIL (NOT the phone), plus a Clerk
 * organization the user administers (createdBy). This mirrors what a dashboard
 * signup produces (user + personal org), so the resulting account behaves
 * identically downstream.
 *
 * Why not the phone: Clerk's phone identifier is globally restricted — many
 * countries (France/+33 confirmed) are unsupported for phone identifiers, and it
 * also requires a per-instance setting. Keying on the phone 502s on the first
 * message from those countries. An admin-created email is accepted for ANY
 * country's user with no instance toggle, so it is the reliable identifier.
 *
 * The phone itself is NOT a Clerk sign-in identifier here; it is persisted on
 * this service's own user row by the caller as the channel's mapping key.
 *
 * Claimability: the account is not a dead end. The same person later claims it
 * on the dashboard by linking their real email / OAuth identity to this Clerk
 * user (the caller resolves phone -> clerkUserId from our DB), then can add a
 * payment card. The synthetic email is a placeholder, freely superseded on claim.
 *
 * The Clerk user is created WITHOUT a password (skipPasswordRequirement); a
 * password / real identity is added later on claim.
 *
 * Fail loud: any Clerk failure throws ClerkServiceError. If the user was created
 * but the org creation failed, the orphan user is best-effort deleted before the
 * throw so a retry can recreate cleanly (the delete result is logged, never
 * swallowed as success).
 */
export async function createClerkPhoneAccount(
  phone: string,
  orgName: string,
): Promise<ClerkPhoneAccount> {
  const clerk = await getClerkClient({ method: "POST", path: "/internal/phone-accounts" });
  let clerkUserId: string | undefined;
  try {
    const user = await clerk.users.createUser({
      emailAddress: [syntheticPhoneEmail(phone)],
      skipPasswordRequirement: true,
    });
    clerkUserId = user.id;
    const org = await clerk.organizations.createOrganization({
      name: orgName,
      createdBy: user.id,
    });
    return { clerkUserId: user.id, clerkOrgId: org.id };
  } catch (err: unknown) {
    if (clerkUserId) {
      // Best-effort cleanup of the orphan user so a retry recreates cleanly.
      try {
        await clerk.users.deleteUser(clerkUserId);
      } catch (cleanupErr) {
        console.error(
          `[client-service] Failed to clean up orphan Clerk user ${clerkUserId} after phone-account create error:`,
          cleanupErr,
        );
      }
    }
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/**
 * Delete a Clerk organization online, keyed by its Clerk org id.
 * Idempotent: a 404 (already-deleted) resolves to "not_found", not an error.
 * Any other failure throws ClerkServiceError (fail loud).
 */
export async function deleteClerkOrganization(clerkOrgId: string): Promise<ClerkDeleteResult> {
  const clerk = await getClerkClient({ method: "DELETE", path: "/internal/orgs/:orgId" });
  try {
    await clerk.organizations.deleteOrganization(clerkOrgId);
    return "deleted";
  } catch (err: unknown) {
    if (isNotFound(err)) return "not_found";
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/**
 * Delete a Clerk user online, keyed by its Clerk user id.
 * Idempotent: a 404 (already-deleted) resolves to "not_found", not an error.
 * Any other failure throws ClerkServiceError (fail loud).
 */
export async function deleteClerkUser(clerkUserId: string): Promise<ClerkDeleteResult> {
  const clerk = await getClerkClient({ method: "DELETE", path: "/internal/orgs/:orgId" });
  try {
    await clerk.users.deleteUser(clerkUserId);
    return "deleted";
  } catch (err: unknown) {
    if (isNotFound(err)) return "not_found";
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/** One organization a Clerk user belongs to, as the identity provider reports it. */
export interface ClerkUserMembership {
  clerkOrgId: string;
  name: string;
  role: string;
}

/** Clerk caps a page at 500; a user in more orgs than that is paged through. */
const CLERK_PAGE_LIMIT = 500;

/**
 * Every organization a Clerk user is a member of RIGHT NOW, read live from Clerk.
 *
 * Returns `null` when Clerk does not know the user (404) — distinct from `[]`,
 * a user Clerk knows who belongs to no organization. Any other failure throws
 * ClerkServiceError: "could not ask" must never read as "member of nothing".
 */
export async function listClerkUserMemberships(
  clerkUserId: string,
): Promise<ClerkUserMembership[] | null> {
  const clerk = await getClerkClient({ method: "GET", path: "/internal/users/:userId/orgs" });
  const memberships: ClerkUserMembership[] = [];
  try {
    for (let offset = 0; ; offset += CLERK_PAGE_LIMIT) {
      const page = await clerk.users.getOrganizationMembershipList({
        userId: clerkUserId,
        limit: CLERK_PAGE_LIMIT,
        offset,
      });
      for (const m of page.data) {
        memberships.push({ clerkOrgId: m.organization.id, name: m.organization.name, role: m.role });
      }
      if (page.data.length < CLERK_PAGE_LIMIT || memberships.length >= page.totalCount) break;
    }
    return memberships;
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/** Clerk's organization-list filter takes ids in the query string; keep URLs short. */
const CLERK_ORG_ID_CHUNK = 100;

/**
 * Display names of a set of Clerk organizations, read live from Clerk in as few
 * calls as the id count allows (one per 100 ids). An id Clerk does not know is
 * simply absent from the map. Any failure throws ClerkServiceError (fail loud).
 */
export async function getClerkOrganizationNames(
  clerkOrgIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (clerkOrgIds.length === 0) return names;
  const clerk = await getClerkClient({ method: "POST", path: "/internal/orgs/names" });
  try {
    for (let i = 0; i < clerkOrgIds.length; i += CLERK_ORG_ID_CHUNK) {
      const chunk = clerkOrgIds.slice(i, i + CLERK_ORG_ID_CHUNK);
      const page = await clerk.organizations.getOrganizationList({
        organizationId: chunk,
        limit: CLERK_ORG_ID_CHUNK,
      });
      for (const org of page.data) names.set(org.id, org.name);
    }
    return names;
  } catch (err: unknown) {
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/** Route label key-service records for the agent-signup Clerk calls. */
const AGENT_SIGNUP_CALLER = { method: "POST", path: "/internal/agent-signups/complete" };

/**
 * Server-only marker on a Clerk user created by an AI agent's signup. It is what
 * lets a retry after a half-finished provision (Clerk user made, our rows not)
 * still recognise the account as agent-born and keep it off free money.
 */
export const AGENT_SIGNUP_SOURCE = "agent_api";

export interface ClerkUserByEmail {
  clerkUserId: string;
  /** `privateMetadata.signupSource`, when the user carries one. */
  signupSource: string | null;
}

/**
 * The Clerk user that owns `email` as one of its addresses, or null when Clerk
 * knows nobody with it. Any failure throws ClerkServiceError: "could not ask"
 * must never read as "nobody has this email", or a second account is created.
 */
export async function findClerkUserByEmail(email: string): Promise<ClerkUserByEmail | null> {
  const clerk = await getClerkClient(AGENT_SIGNUP_CALLER);
  try {
    const page = await clerk.users.getUserList({ emailAddress: [email], limit: 2 });
    const user = page.data[0];
    if (!user) return null;
    const source = (user.privateMetadata as { signupSource?: unknown } | null | undefined)?.signupSource;
    return { clerkUserId: user.id, signupSource: typeof source === "string" ? source : null };
  } catch (err: unknown) {
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

export interface ClerkOrganizationRef {
  clerkOrgId: string;
  slug: string | null;
}

/**
 * Create a Clerk organization administered by `clerkUserId` (createdBy), as a
 * dashboard signup does. Fail loud: any Clerk failure throws ClerkServiceError.
 */
export async function createClerkOrganizationFor(
  clerkUserId: string,
  orgName: string,
): Promise<ClerkOrganizationRef> {
  const clerk = await getClerkClient(AGENT_SIGNUP_CALLER);
  try {
    const org = await clerk.organizations.createOrganization({ name: orgName, createdBy: clerkUserId });
    return { clerkOrgId: org.id, slug: org.slug ?? null };
  } catch (err: unknown) {
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

export interface ClerkEmailAccount extends ClerkOrganizationRef {
  clerkUserId: string;
}

/**
 * Create a signup-equivalent Clerk identity for a REAL email the caller has
 * proven (a one-time code sent to it came back): a Clerk user carrying that
 * email, plus an organization it administers.
 *
 * Unlike the phone account, the email is the person's own, so the user can sign
 * in to the dashboard with it straight away (email code), no claim step.
 * Admin-created, so Clerk records the address as verified without mailing it.
 * No password (skipPasswordRequirement): the person signs in by email code.
 * The user carries `privateMetadata.signupSource = "agent_api"` (server-only).
 *
 * Fail loud: any Clerk failure throws ClerkServiceError. If the user was created
 * but the org creation failed, the orphan user is deleted before the throw so a
 * retry finds nobody with the email and recreates cleanly.
 */
export async function createClerkEmailAccount(email: string, orgName: string): Promise<ClerkEmailAccount> {
  const clerk = await getClerkClient(AGENT_SIGNUP_CALLER);
  let clerkUserId: string | undefined;
  try {
    const user = await clerk.users.createUser({
      emailAddress: [email],
      skipPasswordRequirement: true,
      privateMetadata: { signupSource: AGENT_SIGNUP_SOURCE },
    });
    clerkUserId = user.id;
    const org = await clerk.organizations.createOrganization({ name: orgName, createdBy: user.id });
    return { clerkUserId: user.id, clerkOrgId: org.id, slug: org.slug ?? null };
  } catch (err: unknown) {
    if (clerkUserId) {
      try {
        await clerk.users.deleteUser(clerkUserId);
      } catch (cleanupErr) {
        console.error(
          `[client-service] Failed to clean up orphan Clerk user ${clerkUserId} after agent-signup create error:`,
          cleanupErr,
        );
      }
    }
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/**
 * Create a Clerk organization for a NEW CLIENT on behalf of a staff member
 * (POST /internal/orgs). `createdBy` (when Clerk knows the acting user) makes
 * them an admin of it, so they can keep working in it in the dashboard; null
 * creates an org with no member yet; `onboardingComplete` is the dashboard's
 * first-run flag (`proxy.ts`), set here so the client is never pushed back into
 * the signup walk. Fail loud: any Clerk failure throws ClerkServiceError.
 */
export async function createClerkClientOrganization(
  createdByClerkUserId: string | null,
  orgName: string,
): Promise<ClerkOrganizationRef> {
  const clerk = await getClerkClient({ method: "POST", path: "/internal/orgs" });
  try {
    const org = await clerk.organizations.createOrganization({
      name: orgName,
      ...(createdByClerkUserId && { createdBy: createdByClerkUserId }),
      publicMetadata: { onboardingComplete: true },
    });
    return { clerkOrgId: org.id, slug: org.slug ?? null };
  } catch (err: unknown) {
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/**
 * Whether Clerk knows this user id. A user row of ours can carry an id Clerk
 * does not have (a staff identity made outside the identity provider); a 404 is
 * that answer, any other failure throws ClerkServiceError.
 */
export async function clerkUserExists(clerkUserId: string, caller: CallerInfo): Promise<boolean> {
  const clerk = await getClerkClient(caller);
  try {
    await clerk.users.getUser(clerkUserId);
    return true;
  } catch (err: unknown) {
    if (isNotFound(err)) return false;
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/** A pending (or just-revoked) invitation into a Clerk organization. */
export interface ClerkOrgInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  url: string | null;
  createdAt: number;
  expiresAt: number;
}

function toInvitation(i: {
  id: string;
  emailAddress: string;
  role: string;
  status?: string;
  url: string | null;
  createdAt: number;
  expiresAt: number;
}): ClerkOrgInvitation {
  return {
    id: i.id,
    email: i.emailAddress,
    role: i.role,
    status: i.status ?? "pending",
    url: i.url,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
  };
}

const MEMBER_INVITATIONS_PATH = "/internal/orgs/:orgId/member-invitations";

/**
 * Every PENDING invitation of a Clerk organization, read live. Any failure
 * throws ClerkServiceError: "could not ask" must never read as "none pending",
 * or a re-invite creates a second invitation.
 */
export async function listClerkPendingInvitations(clerkOrgId: string): Promise<ClerkOrgInvitation[]> {
  const clerk = await getClerkClient({ method: "GET", path: MEMBER_INVITATIONS_PATH });
  const out: ClerkOrgInvitation[] = [];
  try {
    for (let offset = 0; ; offset += CLERK_PAGE_LIMIT) {
      const page = await clerk.organizations.getOrganizationInvitationList({
        organizationId: clerkOrgId,
        status: ["pending"],
        limit: CLERK_PAGE_LIMIT,
        offset,
      });
      for (const i of page.data) out.push(toInvitation(i));
      if (page.data.length < CLERK_PAGE_LIMIT || out.length >= page.totalCount) break;
    }
    return out;
  } catch (err: unknown) {
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/**
 * Invite `email` into a Clerk organization. Clerk stores the invitation and
 * emails it; the returned `url` is the same link, for the inviter to forward
 * by hand. Fail loud: any Clerk failure (a refusal included: already a member,
 * inviter not allowed) throws ClerkServiceError with Clerk's status and words.
 */
export async function createClerkOrgInvitation(input: {
  clerkOrgId: string;
  email: string;
  role: string;
  inviterClerkUserId: string | null;
  redirectUrl: string;
}): Promise<ClerkOrgInvitation> {
  const clerk = await getClerkClient({ method: "POST", path: MEMBER_INVITATIONS_PATH });
  try {
    const invitation = await clerk.organizations.createOrganizationInvitation({
      organizationId: input.clerkOrgId,
      emailAddress: input.email,
      role: input.role,
      ...(input.inviterClerkUserId && { inviterUserId: input.inviterClerkUserId }),
      redirectUrl: input.redirectUrl,
    });
    return toInvitation(invitation);
  } catch (err: unknown) {
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/**
 * Revoke one invitation of a Clerk organization. A 404 (unknown id, or an id
 * of ANOTHER organization) resolves to "not_found". Any other failure throws.
 */
export async function revokeClerkOrgInvitation(
  clerkOrgId: string,
  invitationId: string,
): Promise<ClerkOrgInvitation | "not_found"> {
  const clerk = await getClerkClient({ method: "DELETE", path: `${MEMBER_INVITATIONS_PATH}/:invitationId` });
  try {
    const invitation = await clerk.organizations.revokeOrganizationInvitation({
      organizationId: clerkOrgId,
      invitationId,
    });
    return toInvitation(invitation);
  } catch (err: unknown) {
    if (isNotFound(err)) return "not_found";
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

/** Clerk's own sentence for a refusal, when it gave one. */
export function clerkErrorMessage(body: string): string {
  try {
    const errors = JSON.parse(body) as Array<{ longMessage?: string; message?: string }>;
    const first = Array.isArray(errors) ? errors[0] : undefined;
    return first?.longMessage ?? first?.message ?? body;
  } catch {
    return body;
  }
}

/** Route label key-service records for the signup-fact reconciliation's Clerk reads. */
const SIGNUP_FACTS_CALLER = { method: "GET", path: "/internal/signup-facts" };

/** True for the placeholder address a phone-origin account is keyed on (never a real inbox). */
export function isSyntheticPhoneEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${phoneAccountEmailDomain().toLowerCase()}`);
}

/**
 * Who CREATED each of these Clerk organizations (`createdBy`, a Clerk user id),
 * read in one call per 100 ids. An id Clerk does not know is absent from the
 * map; an org Clerk knows with no creator maps to null. Any failure throws
 * ClerkServiceError: "could not ask" must never read as "nobody created it".
 */
export async function getClerkOrganizationCreators(
  clerkOrgIds: string[],
): Promise<Map<string, string | null>> {
  const creators = new Map<string, string | null>();
  if (clerkOrgIds.length === 0) return creators;
  const clerk = await getClerkClient(SIGNUP_FACTS_CALLER);
  try {
    for (let i = 0; i < clerkOrgIds.length; i += CLERK_ORG_ID_CHUNK) {
      const chunk = clerkOrgIds.slice(i, i + CLERK_ORG_ID_CHUNK);
      const page = await clerk.organizations.getOrganizationList({
        organizationId: chunk,
        limit: CLERK_ORG_ID_CHUNK,
      });
      for (const org of page.data) creators.set(org.id, org.createdBy ?? null);
    }
    return creators;
  } catch (err: unknown) {
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

export interface ClerkUserProfile {
  /** Primary address; null when the user has none. */
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Profiles of a set of Clerk users, one call per 100 ids. An id Clerk does not
 * know is absent from the map. Any failure throws ClerkServiceError.
 */
export async function getClerkUserProfiles(clerkUserIds: string[]): Promise<Map<string, ClerkUserProfile>> {
  const profiles = new Map<string, ClerkUserProfile>();
  if (clerkUserIds.length === 0) return profiles;
  const clerk = await getClerkClient(SIGNUP_FACTS_CALLER);
  try {
    for (let i = 0; i < clerkUserIds.length; i += CLERK_ORG_ID_CHUNK) {
      const chunk = clerkUserIds.slice(i, i + CLERK_ORG_ID_CHUNK);
      const page = await clerk.users.getUserList({ userId: chunk, limit: CLERK_ORG_ID_CHUNK });
      for (const user of page.data) {
        profiles.set(user.id, {
          email: user.primaryEmailAddress?.emailAddress ?? null,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
        });
      }
    }
    return profiles;
  } catch (err: unknown) {
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

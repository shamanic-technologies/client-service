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

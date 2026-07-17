import { createClerkClient, type ClerkClient } from "@clerk/backend";

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

let cached: ClerkClient | null = null;

function getClerkClient(): ClerkClient {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("[client-service] CLERK_SECRET_KEY not configured");
  }
  if (!cached) {
    cached = createClerkClient({ secretKey });
  }
  return cached;
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
 * Create a signup-equivalent Clerk identity for a phone number: a Clerk user
 * that carries the phone as a sign-in identifier, plus a Clerk organization the
 * user administers (createdBy). This mirrors what a dashboard signup produces
 * (user + personal org), so the resulting account behaves identically downstream.
 *
 * Claimability: the phone is a real Clerk identifier, so the same person can
 * later sign in on the dashboard via SMS OTP to this number (Clerk verifies the
 * number at OTP time) and land on the SAME Clerk user + org — then add an
 * email/OAuth identity or a payment card. The account is never a dead end.
 *
 * The Clerk user is created WITHOUT a password (skipPasswordRequirement) since
 * phone-OTP is the sign-in path; a password can be added later on claim.
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
  const clerk = getClerkClient();
  let clerkUserId: string | undefined;
  try {
    const user = await clerk.users.createUser({
      phoneNumber: [phone],
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
  const clerk = getClerkClient();
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
  const clerk = getClerkClient();
  try {
    await clerk.users.deleteUser(clerkUserId);
    return "deleted";
  } catch (err: unknown) {
    if (isNotFound(err)) return "not_found";
    throw new ClerkServiceError(errorStatus(err), errorBody(err));
  }
}

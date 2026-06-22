import { createClerkClient, type ClerkClient } from "@clerk/backend";

/**
 * Error thrown when Clerk returns a non-404 failure deleting a resource
 * (organization or user). Carries the upstream HTTP status + body so the route
 * can fail loud with the real provider error (never a swallowed 200).
 */
export class ClerkServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    resource: string = "org",
  ) {
    super(`[client-service] Clerk ${resource} delete failed (${status}): ${body}`);
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
    throw new ClerkServiceError(errorStatus(err), errorBody(err), "org");
  }
}

/**
 * Delete a Clerk user online, keyed by its Clerk user id (users.external_id).
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
    throw new ClerkServiceError(errorStatus(err), errorBody(err), "user");
  }
}

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgCreations, orgs, users } from "../db/schema.js";
import { createClerkClientOrganization, deleteClerkOrganization } from "./clerk-client.js";

/**
 * An organization created for a NEW CLIENT on a staff member's behalf, so a
 * client account can be set up through the distribute MCP exactly as a client
 * or their agent would (owner rule 2026-10-12, `mcp-first`), with no hand call
 * inside a container.
 *
 * The org is an ordinary customer org from its first second: a Clerk
 * organization the acting user administers (so they keep working in it, and
 * can invite the client next), its onboarding already marked complete (the
 * dashboard never walks the client back through signup), and the internal
 * uuid every other service keys on. Nothing else is touched: no billing, no
 * credit, no first touch. Staff gating is the gateway's: this service only
 * checks that the acting user exists.
 */

export class OrgProvisionError extends Error {
  constructor(
    public readonly code: "user_not_found",
    message: string,
  ) {
    super(message);
    this.name = "OrgProvisionError";
  }
}

export interface CreatedOrg {
  orgId: string;
  name: string;
  slug: string | null;
  clerkOrgId: string;
  createdByUserId: string;
  onboardingComplete: true;
  created: boolean;
}

async function existingForKey(createdByUserId: string, idempotencyKey: string): Promise<CreatedOrg | null> {
  const [row] = await db
    .select({ orgId: orgs.id, name: orgs.name, slug: orgs.slug, clerkOrgId: orgs.externalId })
    .from(orgCreations)
    .innerJoin(orgs, eq(orgCreations.orgId, orgs.id))
    .where(and(eq(orgCreations.createdByUserId, createdByUserId), eq(orgCreations.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (!row || !row.clerkOrgId) return null;
  return {
    orgId: row.orgId,
    name: row.name ?? "",
    slug: row.slug,
    clerkOrgId: row.clerkOrgId,
    createdByUserId,
    onboardingComplete: true,
    created: false,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Create the org. With an `idempotencyKey`, a retry by the same user with the
 * same key returns the org the first call created (`created: false`), even
 * when two calls race; without one, every call creates a new org.
 */
export async function createClientOrg(input: {
  name: string;
  createdByUserId: string;
  idempotencyKey?: string;
}): Promise<CreatedOrg> {
  const { name, createdByUserId, idempotencyKey } = input;

  const [actor] = await db
    .select({ externalId: users.externalId })
    .from(users)
    .where(eq(users.id, createdByUserId))
    .limit(1);
  if (!actor?.externalId) {
    throw new OrgProvisionError("user_not_found", "No user with an identity-provider account has this id.");
  }

  if (idempotencyKey) {
    const replay = await existingForKey(createdByUserId, idempotencyKey);
    if (replay) return replay;
  }

  const clerk = await createClerkClientOrganization(actor.externalId, name);

  try {
    const orgId = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(orgs)
        .values({ externalId: clerk.clerkOrgId, name, slug: clerk.slug })
        .returning({ id: orgs.id });
      await tx.insert(orgCreations).values({ orgId: org.id, createdByUserId, idempotencyKey: idempotencyKey ?? null });
      return org.id;
    });
    return {
      orgId,
      name,
      slug: clerk.slug,
      clerkOrgId: clerk.clerkOrgId,
      createdByUserId,
      onboardingComplete: true,
      created: true,
    };
  } catch (err) {
    // Nothing half-made: the Clerk org goes, so no identity-provider org is left
    // without the row every other service would key on.
    await deleteClerkOrganization(clerk.clerkOrgId).catch((e) =>
      console.error(`[client-service] orphan Clerk org ${clerk.clerkOrgId} cleanup failed:`, e),
    );
    // A concurrent call with the same key won the race: return its org.
    if (idempotencyKey && isUniqueViolation(err)) {
      const winner = await existingForKey(createdByUserId, idempotencyKey);
      if (winner) return winner;
    }
    throw err;
  }
}

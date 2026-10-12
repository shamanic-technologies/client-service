import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentSignupCodes, orgs, users, type AgentSignupCode } from "../db/schema.js";
import {
  AGENT_SIGNUP_SOURCE,
  createClerkEmailAccount,
  createClerkOrganizationFor,
  deleteClerkOrganization,
  deleteClerkUser,
  findClerkUserByEmail,
  listClerkUserMemberships,
} from "./clerk-client.js";
import { recordFirstTouch, readFirstTouch } from "./acquisition.js";
import { resolveIdentity } from "./resolve-identity.js";
import { markAgentApiSignup } from "./billing-service-client.js";
import { notifyOwner } from "./owner-telegram.js";
import { notifyStaffSignup } from "./transactional-email-client.js";

/**
 * An AI agent opens a distribute.you account by itself (owner 2026-10-12: "an
 * API key could be requested just against a valid email ... without a human
 * needing to do anything ... no free credits nor free trial with them to avoid
 * free riders. Everything needs to be paid upfront.").
 *
 * Two steps:
 *  1. start: a 6-digit code is emailed to the address; the phone (urgent
 *     contact, format-checked only) is kept with it. Nothing exists yet.
 *  2. complete: the code comes back, which proves the email. The email's
 *     account is returned, created on first sight.
 *
 * No cap per email or caller (owner: block nothing). What bounds guessing is
 * per code: it expires, it allows MAX_ATTEMPTS wrong guesses, and each new
 * request kills the earlier codes for that email.
 *
 * ZERO free money: billing-service's ordinary welcome path is never called. A
 * created org is marked `agent_api` at billing before anything else can touch
 * billing for it, and carries the first touch `agent_api` / `agent_signup`.
 */

export const CODE_TTL_MINUTES = 15;
export const MAX_ATTEMPTS = 5;
export const AGENT_CHANNEL = "agent_api";

function hashCode(id: string, code: string): string {
  return createHash("sha256").update(`${id}:${code}`).digest("hex");
}

function newCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** A named refusal the route turns into its status code. */
export class AgentSignupError extends Error {
  constructor(
    public readonly code:
      | "no_pending_code"
      | "code_invalid"
      | "code_expired"
      | "too_many_attempts",
    message: string,
    public readonly attemptsLeft?: number,
  ) {
    super(message);
    this.name = "AgentSignupError";
  }
}

/**
 * Step 1. `send` delivers the code; it is injected so the delivery path is the
 * caller's (and a test's) concern. A code that was not delivered is never
 * usable, and earlier codes stay valid until a new one is actually delivered.
 */
export async function startAgentSignup(
  input: { email: string; phone: string },
  send: (email: string, code: string, ttlMinutes: number) => Promise<void>,
): Promise<{ email: string; expiresAt: Date; codeTtlMinutes: number; maxAttempts: number }> {
  const id = randomUUID();
  const code = newCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

  await db.insert(agentSignupCodes).values({
    id,
    email: input.email,
    phone: input.phone,
    codeHash: hashCode(id, code),
    expiresAt,
  });

  try {
    await send(input.email, code, CODE_TTL_MINUTES);
  } catch (err) {
    await db.delete(agentSignupCodes).where(eq(agentSignupCodes.id, id));
    throw err;
  }

  // Delivered: from now on only this code redeems for the email.
  await db
    .update(agentSignupCodes)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(agentSignupCodes.email, input.email),
        ne(agentSignupCodes.id, id),
        isNull(agentSignupCodes.supersededAt),
      ),
    );

  notifyOwner(input.email, `📧 ${input.email} · asked for an API signup code (AI agent) · ${input.phone}`);

  return { email: input.email, expiresAt, codeTtlMinutes: CODE_TTL_MINUTES, maxAttempts: MAX_ATTEMPTS };
}

/** Check `code` against the live code of `email`. Counts a wrong guess. */
async function verifyCode(email: string, code: string): Promise<AgentSignupCode> {
  const [row] = await db
    .select()
    .from(agentSignupCodes)
    .where(and(eq(agentSignupCodes.email, email), isNull(agentSignupCodes.supersededAt)))
    .orderBy(desc(agentSignupCodes.createdAt))
    .limit(1);

  if (!row) {
    throw new AgentSignupError("no_pending_code", "No code is pending for this email. Request one first.");
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new AgentSignupError("code_expired", "This code has expired. Request a new one.");
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new AgentSignupError("too_many_attempts", "Too many wrong codes. Request a new one.");
  }

  const expected = Buffer.from(row.codeHash, "hex");
  const given = Buffer.from(hashCode(row.id, code), "hex");
  if (expected.length === given.length && timingSafeEqual(expected, given)) return row;

  const [counted] = await db
    .update(agentSignupCodes)
    .set({ attempts: sql`${agentSignupCodes.attempts} + 1` })
    .where(and(eq(agentSignupCodes.id, row.id), sql`${agentSignupCodes.attempts} < ${MAX_ATTEMPTS}`))
    .returning({ attempts: agentSignupCodes.attempts });
  if (!counted) {
    throw new AgentSignupError("too_many_attempts", "Too many wrong codes. Request a new one.");
  }
  throw new AgentSignupError("code_invalid", "Wrong code.", MAX_ATTEMPTS - counted.attempts);
}

export interface AgentAccount {
  orgId: string;
  userId: string;
  email: string;
  contactPhone: string | null;
  clerkOrgId: string;
  clerkUserId: string;
  created: boolean;
}

/** One provision at a time per email in this process: a double submit returns one account. */
const inFlight = new Map<string, Promise<AgentAccount>>();

/** Step 2. */
export async function completeAgentSignup(input: { email: string; code: string }): Promise<AgentAccount> {
  const row = await verifyCode(input.email, input.code);

  const pending = inFlight.get(input.email);
  if (pending) return pending;
  const work = provision(input.email, row.phone).finally(() => inFlight.delete(input.email));
  inFlight.set(input.email, work);
  const account = await work;

  await db
    .update(agentSignupCodes)
    .set({ consumedAt: sql`COALESCE(${agentSignupCodes.consumedAt}, now())` })
    .where(eq(agentSignupCodes.id, row.id));

  return account;
}

/** The org display name for a new account: the email's domain. The person renames it on the dashboard. */
function orgNameFor(email: string): string {
  return email.split("@")[1] ?? email;
}

async function provision(email: string, phone: string): Promise<AgentAccount> {
  const existing = await findClerkUserByEmail(email);
  if (existing) return returnExisting(email, phone, existing.clerkUserId, existing.signupSource === AGENT_SIGNUP_SOURCE);
  return createAccount(email, phone);
}

async function createAccount(email: string, phone: string): Promise<AgentAccount> {
  const orgName = orgNameFor(email);
  const clerk = await createClerkEmailAccount(email, orgName);

  let local: { orgId: string; userId: string };
  try {
    local = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(orgs)
        .values({ externalId: clerk.clerkOrgId, name: orgName, slug: clerk.slug })
        .returning({ id: orgs.id });
      const [user] = await tx
        .insert(users)
        .values({ externalId: clerk.clerkUserId, email, contactPhone: phone, orgId: org.id })
        .returning({ id: users.id });
      await recordFirstTouch(tx, org.id, { channel: AGENT_CHANNEL }, "agent_signup");
      return { orgId: org.id, userId: user.id };
    });
  } catch (err) {
    // Nothing half-made: the Clerk identity goes too, so a retry starts clean.
    await deleteClerkOrganization(clerk.clerkOrgId).catch((e) =>
      console.error(`[client-service] orphan Clerk org ${clerk.clerkOrgId} cleanup failed:`, e),
    );
    await deleteClerkUser(clerk.clerkUserId).catch((e) =>
      console.error(`[client-service] orphan Clerk user ${clerk.clerkUserId} cleanup failed:`, e),
    );
    throw err;
  }

  // Before anything else can touch billing for this org (fail loud; a retry
  // takes the "existing" path, which marks again).
  await markAgentApiSignup(local.orgId);

  notifyStaffSignup({ orgId: local.orgId, email });
  notifyOwner(email, `🆕 ${email} · signed up through the API (AI agent) · ${phone}`);

  return {
    orgId: local.orgId,
    userId: local.userId,
    email,
    contactPhone: phone,
    clerkOrgId: clerk.clerkOrgId,
    clerkUserId: clerk.clerkUserId,
    created: true,
  };
}

/**
 * The email already has an identity-provider user: return its account. The
 * org is the one the dashboard last had active for the user; failing that, the
 * user's first Clerk organization; failing that, a new one (an agent-born user
 * whose provision stopped between Clerk and our rows).
 */
async function returnExisting(
  email: string,
  phone: string,
  clerkUserId: string,
  agentBorn: boolean,
): Promise<AgentAccount> {
  let resolved = await currentOrgOf(clerkUserId);
  if (!resolved) {
    const memberships = await listClerkUserMemberships(clerkUserId);
    const first = memberships?.[0];
    const target = first
      ? { clerkOrgId: first.clerkOrgId, name: first.name }
      : { clerkOrgId: (await createClerkOrganizationFor(clerkUserId, orgNameFor(email))).clerkOrgId, name: orgNameFor(email) };
    const identity = await resolveIdentity({
      externalOrgId: target.clerkOrgId,
      externalUserId: clerkUserId,
      email,
      orgName: target.name,
    });
    resolved = { orgId: identity.org.id, userId: identity.user.id, clerkOrgId: target.clerkOrgId };
  }

  await db.update(users).set({ contactPhone: phone, updatedAt: new Date() }).where(eq(users.id, resolved.userId));

  // An agent-born account (marked on the Clerk user at creation, or by its first
  // touch) is kept off free money on every return, so a provision that stopped
  // before billing heard about it converges here. An ordinary customer's account
  // is returned as is: its billing account is never re-labelled.
  const touch = await readFirstTouch(db, resolved.orgId);
  if (agentBorn && !touch) {
    await recordFirstTouch(db, resolved.orgId, { channel: AGENT_CHANNEL }, "agent_signup");
  }
  if (agentBorn || touch?.channel === AGENT_CHANNEL) {
    await markAgentApiSignup(resolved.orgId);
  }

  return {
    orgId: resolved.orgId,
    userId: resolved.userId,
    email,
    contactPhone: phone,
    clerkOrgId: resolved.clerkOrgId,
    clerkUserId,
    created: false,
  };
}

/** Our rows for a Clerk user whose current org we already hold (and is not a shell). */
async function currentOrgOf(
  clerkUserId: string,
): Promise<{ orgId: string; userId: string; clerkOrgId: string } | null> {
  const [row] = await db
    .select({ userId: users.id, orgId: orgs.id, clerkOrgId: orgs.externalId, absorbedAt: orgs.absorbedAt })
    .from(users)
    .innerJoin(orgs, eq(users.orgId, orgs.id))
    .where(eq(users.externalId, clerkUserId))
    .limit(1);
  if (!row || row.absorbedAt || !row.clerkOrgId) return null;
  return { orgId: row.orgId, userId: row.userId, clerkOrgId: row.clerkOrgId };
}

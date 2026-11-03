import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
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
import { orgNameForEmail } from "./org-name.js";
import { notifyOwner } from "./owner-telegram.js";
import { notifyStaffSignup } from "./transactional-email-client.js";

/**
 * An AI agent opens a distribute.you account by itself (owner 2026-10-12: "an
 * API key could be requested just against a valid email ... without a human
 * needing to do anything ... no free credits nor free trial with them to avoid
 * free riders. Everything needs to be paid upfront.").
 *
 * Two steps:
 *  1. start: one email to the address carries a 6-digit code AND an approval
 *     link; the agent gets a poll token. The phone (optional, unverified urgent
 *     contact) is kept with it. Nothing exists yet.
 *  2. complete: the email is proven EITHER by the code coming back, OR by the
 *     poll token once the inbox owner clicked the link. The email's account is
 *     returned, created on first sight.
 *
 * Why two proofs (CLIENT-FRICTION-API-1103): an agent with no inbox access
 * waits on a human, and a human relaying a 6-digit code often misses its
 * 15 minutes. A 6-digit code is guessable, so it MUST stay short-lived and
 * attempt-limited (NIST SP 800-63B 5.1.3: out-of-band secrets ~10 min; OWASP
 * MFA cheat sheet). The link + poll token is the OAuth 2.0 Device
 * Authorization Grant shape (RFC 8628): the human approves from a link while
 * the agent polls with a secret only it holds. Both secrets are 256-bit, so a
 * longer lifetime (APPROVAL_TTL_HOURS) does not make guessing possible; the
 * human's click is a POST on a confirm page (a GET never approves: mail
 * scanners prefetch links).
 *
 * No cap per email or caller (owner: block nothing). What bounds guessing is
 * per code: it expires, it allows MAX_ATTEMPTS wrong guesses, and each new
 * request kills the earlier codes AND links for that email.
 *
 * ZERO free money: billing-service's ordinary welcome path is never called. A
 * created org is marked `agent_api` at billing before anything else can touch
 * billing for it, and carries the first touch `agent_api` / `agent_signup`.
 */

export const CODE_TTL_MINUTES = 15;
export const MAX_ATTEMPTS = 5;
/** How long the approval link (and the poll token's wait for it) lives. */
export const APPROVAL_TTL_HOURS = 24;
/** RFC 8628 3.2 default polling interval. Advice only: nothing is throttled. */
export const POLL_INTERVAL_SECONDS = 5;
const DEFAULT_PUBLIC_API_URL = "https://api.distribute.you";
export const AGENT_CHANNEL = "agent_api";

function hashCode(id: string, code: string): string {
  return createHash("sha256").update(`${id}:${code}`).digest("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The public page (api-service gateway) the human opens from the email. */
export function approveUrlFor(token: string): string {
  const base = (process.env.PUBLIC_API_URL || DEFAULT_PUBLIC_API_URL).replace(/\/+$/, "");
  return `${base}/v1/agent-signups/approve?token=${encodeURIComponent(token)}`;
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
      | "too_many_attempts"
      | "authorization_pending"
      | "approval_expired"
      | "poll_token_unknown",
    message: string,
    public readonly attemptsLeft?: number,
  ) {
    super(message);
    this.name = "AgentSignupError";
  }
}

export interface SignupEmail {
  email: string;
  code: string;
  ttlMinutes: number;
  approveUrl: string;
  approvalTtlHours: number;
}

export interface StartedSignup {
  email: string;
  expiresAt: Date;
  codeTtlMinutes: number;
  maxAttempts: number;
  pollToken: string;
  approvalExpiresAt: Date;
  pollIntervalSeconds: number;
}

/**
 * Step 1. `send` delivers the email; it is injected so the delivery path is the
 * caller's (and a test's) concern. A code or link that was not delivered is
 * never usable, and earlier ones stay valid until a new one is delivered.
 */
export async function startAgentSignup(
  input: { email: string; phone?: string },
  send: (mail: SignupEmail) => Promise<void>,
): Promise<StartedSignup> {
  const id = randomUUID();
  const code = newCode();
  const pollToken = newToken();
  const approvalToken = newToken();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);
  const approvalExpiresAt = new Date(Date.now() + APPROVAL_TTL_HOURS * 3_600_000);
  const phone = input.phone ?? null;

  await db.insert(agentSignupCodes).values({
    id,
    email: input.email,
    phone,
    codeHash: hashCode(id, code),
    expiresAt,
    pollTokenHash: hashToken(pollToken),
    approvalTokenHash: hashToken(approvalToken),
    approvalExpiresAt,
  });

  try {
    await send({
      email: input.email,
      code,
      ttlMinutes: CODE_TTL_MINUTES,
      approveUrl: approveUrlFor(approvalToken),
      approvalTtlHours: APPROVAL_TTL_HOURS,
    });
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

  notifyOwner(input.email, `📧 ${input.email} · asked for an API signup code (AI agent)${phoneSuffix(phone)}`);

  return {
    email: input.email,
    expiresAt,
    codeTtlMinutes: CODE_TTL_MINUTES,
    maxAttempts: MAX_ATTEMPTS,
    pollToken,
    approvalExpiresAt,
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
  };
}

function phoneSuffix(phone: string | null): string {
  return phone ? ` · ${phone} (unverified)` : " · no phone";
}

/** Where an approval link stands, as the human's page shows it. */
export type ApprovalState = "ready" | "approved" | "expired" | "superseded" | "unknown";

export interface ApprovalView {
  state: ApprovalState;
  email: string | null;
  requestedAt: Date | null;
}

async function rowByApprovalToken(token: string): Promise<AgentSignupCode | null> {
  const [row] = await db
    .select()
    .from(agentSignupCodes)
    .where(eq(agentSignupCodes.approvalTokenHash, hashToken(token)))
    .limit(1);
  return row ?? null;
}

function approvalStateOf(row: AgentSignupCode): ApprovalState {
  if (row.approvedAt) return "approved";
  if (row.supersededAt) return "superseded";
  if (!row.approvalExpiresAt || row.approvalExpiresAt.getTime() <= Date.now()) return "expired";
  return "ready";
}

/** Read-only: what the confirm page shows. A GET never approves. */
export async function readApproval(token: string): Promise<ApprovalView> {
  const row = await rowByApprovalToken(token);
  if (!row) return { state: "unknown", email: null, requestedAt: null };
  return { state: approvalStateOf(row), email: row.email, requestedAt: row.createdAt };
}

/**
 * The inbox owner approves (the confirm page's POST). Idempotent: an approved
 * link stays approved. Only a live, latest request can be approved.
 */
export async function approveAgentSignup(token: string): Promise<ApprovalView> {
  const row = await rowByApprovalToken(token);
  if (!row) return { state: "unknown", email: null, requestedAt: null };
  if (approvalStateOf(row) === "ready") {
    await db
      .update(agentSignupCodes)
      .set({ approvedAt: sql`COALESCE(${agentSignupCodes.approvedAt}, now())` })
      .where(and(eq(agentSignupCodes.id, row.id), isNull(agentSignupCodes.supersededAt)));
  }
  const [after] = await db.select().from(agentSignupCodes).where(eq(agentSignupCodes.id, row.id));
  return { state: approvalStateOf(after), email: after.email, requestedAt: after.createdAt };
}

/**
 * The agent's poll (RFC 8628 3.4/3.5): the poll token proves it is the agent
 * that started this request; the approval proves the email. Until the human
 * acts: `authorization_pending`. An approved request redeems again until its
 * approval window ends, returning the same account.
 */
async function verifyPollToken(email: string, pollToken: string): Promise<AgentSignupCode> {
  const [row] = await db
    .select()
    .from(agentSignupCodes)
    .where(eq(agentSignupCodes.pollTokenHash, hashToken(pollToken)))
    .limit(1);
  if (!row || row.email !== email) {
    throw new AgentSignupError("poll_token_unknown", "This poll token does not match a signup request for this email.");
  }
  const expired = !row.approvalExpiresAt || row.approvalExpiresAt.getTime() <= Date.now();
  if (expired) {
    throw new AgentSignupError("approval_expired", "This request expired before it was approved. Start again.");
  }
  if (row.approvedAt) return row;
  if (row.supersededAt) {
    throw new AgentSignupError("no_pending_code", "A newer request replaced this one. Poll with the newest poll token.");
  }
  throw new AgentSignupError(
    "authorization_pending",
    "Waiting for the inbox owner to click the link in the email (or send the 6-digit code instead). Poll again shortly.",
  );
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

/** What binding a verified WhatsApp number to the proven account did. */
export interface WhatsappPhoneBinding {
  whatsappPhone: string;
  /** The user who held the number until now (it no longer resolves to them); null when nobody or this same user. */
  whatsappPhoneMovedFromUserId: string | null;
}

/** One provision at a time per email in this process: a double submit returns one account. */
const inFlight = new Map<string, Promise<AgentAccount>>();

/**
 * Step 2. With `whatsappPhone` (a number the CHANNEL verified: the message came
 * from it, owner 2026-10-18 "the sender's WhatsApp number IS their identity"),
 * the number becomes the account's channel mapping key (`users.phone`) once the
 * code has proved the email. Never the start's `phone`: that one is unverified.
 */
export async function completeAgentSignup(input: {
  email: string;
  code?: string;
  pollToken?: string;
  whatsappPhone?: string;
}): Promise<AgentAccount & Partial<WhatsappPhoneBinding>> {
  const row =
    input.pollToken !== undefined
      ? await verifyPollToken(input.email, input.pollToken)
      : await verifyCode(input.email, input.code!);

  const pending = inFlight.get(input.email);
  if (pending) return pending;
  const work = provision(input.email, row.phone).finally(() => inFlight.delete(input.email));
  inFlight.set(input.email, work);
  const account = await work;

  await db
    .update(agentSignupCodes)
    .set({ consumedAt: sql`COALESCE(${agentSignupCodes.consumedAt}, now())` })
    .where(eq(agentSignupCodes.id, row.id));

  if (input.whatsappPhone === undefined) return account;
  const binding = await bindWhatsappPhone(account.userId, input.whatsappPhone);
  return { ...account, ...binding };
}

/**
 * Makes `phone` resolve to `userId` on GET /internal/phone-accounts from now on.
 * Whoever held it (a July phone-origin shell, another user) loses it in the same
 * transaction, so `idx_users_phone` keeps one holder per number. The user's own
 * earlier number, if any, is replaced: one channel number per user. The previous
 * holder's account itself is untouched. Same number + same user = no-op.
 */
export async function bindWhatsappPhone(userId: string, phone: string): Promise<WhatsappPhoneBinding> {
  try {
    return await bindOnce(userId, phone);
  } catch (err) {
    // Two binds of an UNHELD number race past the row lock (nothing to lock);
    // the unique index refuses the loser, whose second pass sees the winner.
    const e = err as { code?: string; cause?: { code?: string } };
    if ((e.code ?? e.cause?.code) !== "23505") throw err;
    return bindOnce(userId, phone);
  }
}

async function bindOnce(userId: string, phone: string): Promise<WhatsappPhoneBinding> {
  return db.transaction(async (tx) => {
    const holders = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, phone))
      .for("update");
    const previous = holders.find((h) => h.id !== userId);
    if (previous) {
      await tx.update(users).set({ phone: null, updatedAt: new Date() }).where(eq(users.id, previous.id));
    }
    if (holders.length === 0 || previous) {
      await tx.update(users).set({ phone, updatedAt: new Date() }).where(eq(users.id, userId));
    }
    return { whatsappPhone: phone, whatsappPhoneMovedFromUserId: previous?.id ?? null };
  });
}

async function provision(email: string, phone: string | null): Promise<AgentAccount> {
  const existing = await findClerkUserByEmail(email);
  if (existing) return returnExisting(email, phone, existing.clerkUserId, existing.signupSource === AGENT_SIGNUP_SOURCE);
  return createAccount(email, phone);
}

async function createAccount(email: string, phone: string | null): Promise<AgentAccount> {
  const orgName = orgNameForEmail(email);
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
  notifyOwner(email, `🆕 ${email} · signed up through the API (AI agent)${phoneSuffix(phone)}`);

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
  phone: string | null,
  clerkUserId: string,
  agentBorn: boolean,
): Promise<AgentAccount> {
  let resolved = await currentOrgOf(clerkUserId);
  if (!resolved) {
    const memberships = await listClerkUserMemberships(clerkUserId);
    const first = memberships?.[0];
    const target = first
      ? { clerkOrgId: first.clerkOrgId, name: first.name }
      : { clerkOrgId: (await createClerkOrganizationFor(clerkUserId, orgNameForEmail(email))).clerkOrgId, name: orgNameForEmail(email) };
    const identity = await resolveIdentity({
      externalOrgId: target.clerkOrgId,
      externalUserId: clerkUserId,
      email,
      orgName: target.name,
    });
    resolved = { orgId: identity.org.id, userId: identity.user.id, clerkOrgId: target.clerkOrgId };
  }

  // No phone given = keep whatever contact the user already has.
  let contactPhone = phone;
  if (phone) {
    await db.update(users).set({ contactPhone: phone, updatedAt: new Date() }).where(eq(users.id, resolved.userId));
  } else {
    const [u] = await db.select({ contactPhone: users.contactPhone }).from(users).where(eq(users.id, resolved.userId));
    contactPhone = u.contactPhone;
  }

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
    contactPhone,
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

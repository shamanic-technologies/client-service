import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgOwnerTelegram, orgOwnerTelegramLinkCodes, orgs } from "../db/schema.js";

/**
 * One short Telegram line to the OWNER OF AN ORG, through the platform bot
 * (owner 2026-10-14: tell me on Telegram when the social post workflow has
 * published). Any org, the same mechanism: where the owner is reachable is a
 * recorded fact in `org_owner_telegram`, never an org-id branch here.
 *
 *  - `linked_chat`: the owner linked their own chat. The dashboard asks for a
 *    one-time code (`createLinkCode`), the owner taps `t.me/<bot>?start=<code>`,
 *    Telegram sends the bot `/start <code>`, the bot's webhook (landing app)
 *    hands code + chat id to `consumeLinkCode`.
 *  - `platform_owner_chat`: the org's owner is the platform owner, whose chat
 *    the bot already holds (`TELEGRAM_OWNER_CHAT_ID`). distribute.you's own org
 *    carries this row (migration 0024).
 *
 * The caller is an automation reporting what it did, so a staff actor is NOT
 * suppressed here (unlike `owner-telegram.ts`), and the send never throws at
 * the caller: every result is a named outcome.
 */

const SEND_TIMEOUT_MS = 10_000;
const LINK_CODE_TTL_MS = 30 * 60 * 1000;

export class OrgOwnerTelegramError extends Error {
  constructor(
    public code: "org_not_found" | "link_code_unknown" | "link_code_expired" | "link_code_used" | "bot_unavailable",
    message: string,
  ) {
    super(message);
  }
}

function botToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

async function requireOrg(orgId: string): Promise<{ id: string; name: string | null }> {
  const [org] = await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) throw new OrgOwnerTelegramError("org_not_found", `No org ${orgId}`);
  return org;
}

type TelegramSend = { ok: true; messageId: number } | { ok: false; reason: string };

async function telegramSend(token: string, chatId: string, text: string): Promise<TelegramSend> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: { message_id?: number }; description?: string }
      | null;
    if (!res.ok || !json?.ok || typeof json.result?.message_id !== "number") {
      return { ok: false, reason: `Telegram refused (${res.status}): ${json?.description ?? "no description"}` };
    }
    return { ok: true, messageId: json.result.message_id };
  } catch (err) {
    return { ok: false, reason: `Telegram unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type OwnerTelegramTarget = "linked_chat" | "platform_owner_chat";

export type OwnerTelegramSendResult =
  | { outcome: "sent"; target: OwnerTelegramTarget; telegramMessageId: number }
  | { outcome: "not_reachable"; reason: string }
  | { outcome: "delivery_failed"; target: OwnerTelegramTarget; reason: string };

/** Sends `text` to the org's owner. Throws only `org_not_found`. */
export async function sendToOrgOwner(orgId: string, text: string): Promise<OwnerTelegramSendResult> {
  await requireOrg(orgId);
  const [row] = await db.select().from(orgOwnerTelegram).where(eq(orgOwnerTelegram.orgId, orgId)).limit(1);
  if (!row) {
    return { outcome: "not_reachable", reason: "This org's owner has not linked a Telegram chat." };
  }
  const target = row.target as OwnerTelegramTarget;
  const token = botToken();
  const chatId = target === "linked_chat" ? row.chatId : process.env.TELEGRAM_OWNER_CHAT_ID?.trim() || null;
  if (!token || !chatId) {
    const reason = "The platform Telegram bot is not configured on client-service (TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID).";
    console.error(`[client-service] org owner Telegram NOT sent for org ${orgId}: ${reason}`);
    return { outcome: "delivery_failed", target, reason };
  }
  const sent = await telegramSend(token, chatId, text);
  if (!sent.ok) {
    console.error(`[client-service] org owner Telegram NOT sent for org ${orgId}: ${sent.reason}`);
    return { outcome: "delivery_failed", target, reason: sent.reason };
  }
  return { outcome: "sent", target, telegramMessageId: sent.messageId };
}

export type OwnerTelegramStatus =
  | { reachable: false }
  | { reachable: true; target: OwnerTelegramTarget; linkedAt: string };

export async function getOrgOwnerTelegram(orgId: string): Promise<OwnerTelegramStatus> {
  await requireOrg(orgId);
  const [row] = await db.select().from(orgOwnerTelegram).where(eq(orgOwnerTelegram.orgId, orgId)).limit(1);
  if (!row) return { reachable: false };
  return { reachable: true, target: row.target as OwnerTelegramTarget, linkedAt: row.linkedAt.toISOString() };
}

export async function unlinkOrgOwnerTelegram(orgId: string): Promise<{ unlinked: boolean }> {
  await requireOrg(orgId);
  const deleted = await db.delete(orgOwnerTelegram).where(eq(orgOwnerTelegram.orgId, orgId)).returning();
  return { unlinked: deleted.length > 0 };
}

let botUsername: { token: string; username: string } | null = null;

/** The bot's @username for the link, asked once per token. */
async function getBotUsername(token: string): Promise<string> {
  if (botUsername?.token === token) return botUsername.username;
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) }).catch(
    (err: unknown) => {
      throw new OrgOwnerTelegramError("bot_unavailable", `Telegram unreachable: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string }; description?: string } | null;
  if (!res.ok || !json?.ok || !json.result?.username) {
    throw new OrgOwnerTelegramError("bot_unavailable", `Telegram getMe refused (${res.status}): ${json?.description ?? "no description"}`);
  }
  botUsername = { token, username: json.result.username };
  return json.result.username;
}

/** Exported for tests: forget the memoized bot username. */
export function resetBotUsernameCache(): void {
  botUsername = null;
}

/**
 * A one-time code the owner hands to the bot by tapping `linkUrl`. A new code
 * does not void earlier ones; each is good once, for 30 minutes.
 */
export async function createLinkCode(
  orgId: string,
  userId: string,
): Promise<{ code: string; linkUrl: string; expiresAt: string }> {
  await requireOrg(orgId);
  const token = botToken();
  if (!token) throw new OrgOwnerTelegramError("bot_unavailable", "TELEGRAM_BOT_TOKEN is not set on client-service.");
  const username = await getBotUsername(token);
  // Telegram's start parameter allows [A-Za-z0-9_-], up to 64 characters.
  const code = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await db.insert(orgOwnerTelegramLinkCodes).values({ orgId, userId, codeHash: hashCode(code), expiresAt });
  return { code, linkUrl: `https://t.me/${username}?start=${code}`, expiresAt: expiresAt.toISOString() };
}

/**
 * The bot received `/start <code>` from `chatId`: that chat becomes the org's
 * owner chat (replacing any earlier one). Replaying the same code from the
 * same chat answers the same link; another chat is `link_code_used`. A short
 * confirmation goes to the chat; its failure does not undo the link.
 */
export async function consumeLinkCode(
  code: string,
  chatId: string,
): Promise<{ orgId: string; orgName: string | null; linkedAt: string; confirmationSent: boolean }> {
  const now = new Date();
  const linked = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(orgOwnerTelegramLinkCodes)
      .where(eq(orgOwnerTelegramLinkCodes.codeHash, hashCode(code)))
      .for("update")
      .limit(1);
    if (!row) throw new OrgOwnerTelegramError("link_code_unknown", "No such link code.");
    if (row.consumedAt) {
      if (row.consumedChatId !== chatId) throw new OrgOwnerTelegramError("link_code_used", "This link code was already used.");
      const [current] = await tx.select().from(orgOwnerTelegram).where(eq(orgOwnerTelegram.orgId, row.orgId)).limit(1);
      if (!current || current.chatId !== chatId) {
        throw new OrgOwnerTelegramError("link_code_used", "This link code was already used.");
      }
      return { orgId: row.orgId, linkedAt: current.linkedAt, replay: true };
    }
    if (row.expiresAt <= now) throw new OrgOwnerTelegramError("link_code_expired", "This link code has expired.");
    await tx
      .update(orgOwnerTelegramLinkCodes)
      .set({ consumedAt: now, consumedChatId: chatId })
      .where(and(eq(orgOwnerTelegramLinkCodes.id, row.id), isNull(orgOwnerTelegramLinkCodes.consumedAt), gt(orgOwnerTelegramLinkCodes.expiresAt, now)));
    const values = { target: "linked_chat", chatId, linkedByUserId: row.userId, linkedAt: now };
    await tx
      .insert(orgOwnerTelegram)
      .values({ orgId: row.orgId, ...values })
      .onConflictDoUpdate({ target: orgOwnerTelegram.orgId, set: values });
    return { orgId: row.orgId, linkedAt: now, replay: false };
  });
  const org = await requireOrg(linked.orgId);
  let confirmationSent = false;
  const token = botToken();
  if (token && !linked.replay) {
    const sent = await telegramSend(
      token,
      chatId,
      `Connected. Updates about ${org.name ?? "your organization"} on distribute.you will land here.`,
    );
    confirmationSent = sent.ok;
    if (!sent.ok) console.error(`[client-service] owner Telegram link confirmation not sent for org ${org.id}: ${sent.reason}`);
  }
  return { orgId: org.id, orgName: org.name, linkedAt: linked.linkedAt.toISOString(), confirmationSent };
}

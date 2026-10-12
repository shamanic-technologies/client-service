/**
 * One short Telegram line to the owner at each step of an AI agent's signup
 * (owner 2026-10-07: "il faut que je reçoive un message court à chaque étape";
 * 2026-10-12: a message at each signup step of the agent flow too). Same bot and
 * chat as the dashboard's signup pings and billing's owner alerts
 * (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` in this service's env file).
 *
 * Rules, the same as billing's owner alerts:
 *  - never the owner's own actions: a staff address sends nothing;
 *  - never fails the signup it reports: `notifyOwner` never throws and is not
 *    awaited by the request. A failure is logged loudly instead.
 */

const SEND_TIMEOUT_MS = 10_000;

/**
 * Staff, mirrored from billing-service `isStaffEmail` (itself mirrored from
 * api-service STAFF_EMAILS), plus any `@distribute.you` address (our own test
 * accounts). Plus-addressing is ignored.
 */
const STAFF_EMAILS = new Set(["kevin.lourd@gmail.com", "kevin@distribute.you", "kevin@pressbeat.io"]);
const STAFF_DOMAIN = "@distribute.you";

export function isStaffEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith(STAFF_DOMAIN)) return true;
  const [local, domain] = normalized.split("@");
  return STAFF_EMAILS.has(`${local.split("+")[0]}@${domain}`);
}

function getTelegramConfig(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

export type OwnerPingResult = "sent" | "skipped_staff" | "unconfigured" | "failed";

/** The whole delivery, awaited. Exported for tests. Never throws. */
export async function deliverOwnerPing(actorEmail: string, text: string): Promise<OwnerPingResult> {
  if (isStaffEmail(actorEmail)) return "skipped_staff";
  const config = getTelegramConfig();
  if (!config) {
    console.error(`[client-service] TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not set: owner NOT told: ${text}`);
    return "unconfigured";
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[client-service] owner Telegram ping refused ${res.status}: ${await res.text()} (${text})`);
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error(`[client-service] owner Telegram ping failed (${text}):`, err);
    return "failed";
  }
}

/** Fire-and-forget: returns at once, never throws. */
export function notifyOwner(actorEmail: string, text: string): void {
  void deliverOwnerPing(actorEmail, text);
}

import { fetchWithRetry } from "./fetch-retry.js";

/**
 * client-service's calls to transactional-email-service: the agent-signup code
 * email (a template this service owns and registers at boot) and the staff
 * "new signup" email.
 */

export class TransactionalEmailError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`[client-service] transactional-email-service call failed (${status}): ${body}`);
    this.name = "TransactionalEmailError";
  }
}

function getConfig(): { url: string; apiKey: string } {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url) throw new Error("[client-service] TRANSACTIONAL_EMAIL_SERVICE_URL not configured");
  if (!apiKey) throw new Error("[client-service] TRANSACTIONAL_EMAIL_SERVICE_API_KEY not configured");
  return { url: url.replace(/\/$/, ""), apiKey };
}

export const AGENT_SIGNUP_CODE_TEMPLATE = "agent_signup_code";

/**
 * The code email. Plain and short (owner: English, no em dashes). It goes on the
 * transactional stream, which delivers it exactly as registered, so the WHY
 * sign-off is written here rather than added at render.
 */
export const AGENT_SIGNUP_CODE_TEMPLATE_ITEM = {
  name: AGENT_SIGNUP_CODE_TEMPLATE,
  subject: "Your distribute.you code: {{code}}",
  htmlBody: [
    `<p style="font-size:16px;line-height:1.6;color:#1a1a1a;">Your code is:</p>`,
    `<p style="font-size:32px;font-weight:700;letter-spacing:6px;color:#1a1a1a;margin:8px 0 16px 0;">{{code}}</p>`,
    `<p style="font-size:16px;line-height:1.6;color:#4a4a4a;">Use it to finish creating your distribute.you account. It expires in {{expiresInMinutes}} minutes.</p>`,
    `<p style="font-size:16px;line-height:1.6;color:#4a4a4a;">We will send news about your account to this address.</p>`,
    `<p style="font-size:16px;line-height:1.6;color:#4a4a4a;">Did not ask for it? Ignore this email. No account is made without the code.</p>`,
    `<p style="font-size:13px;line-height:1.6;color:#8b8e98;">Revenue made easy.</p>`,
  ].join("\n"),
  textBody: [
    "Your code is: {{code}}",
    "",
    "Use it to finish creating your distribute.you account. It expires in {{expiresInMinutes}} minutes.",
    "",
    "We will send news about your account to this address.",
    "",
    "Did not ask for it? Ignore this email. No account is made without the code.",
    "",
    "Revenue made easy.",
  ].join("\n"),
  stream: "transactional" as const,
};

/**
 * Register (upsert) this service's templates. Called at boot, after listen().
 * Never throws: a failed registration is logged loudly; the next boot retries,
 * and a send against a missing template fails loud on its own.
 */
export async function registerEmailTemplates(): Promise<void> {
  try {
    const { url, apiKey } = getConfig();
    const res = await fetchWithRetry(`${url}/platform-templates`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ templates: [AGENT_SIGNUP_CODE_TEMPLATE_ITEM] }),
    });
    if (!res.ok) {
      console.error(`[client-service] email template registration FAILED (${res.status}): ${await res.text()}`);
      return;
    }
    console.log(`[client-service] email templates registered: ${AGENT_SIGNUP_CODE_TEMPLATE}`);
  } catch (err) {
    console.error("[client-service] email template registration FAILED:", err);
  }
}

/**
 * Send the one-time code to a person who has no account yet, via
 * transactional-email-service `POST /platform-orgless-send`: no org, no user,
 * platform-paid at every hop (no customer org is authorized, created or
 * charged), never deduplicated (a new request delivers a new code).
 *
 * Fail loud: anything but a 2xx throws, and the caller treats the code as never
 * sent.
 */
export async function sendAgentSignupCode(email: string, code: string, ttlMinutes: number): Promise<void> {
  const { url, apiKey } = getConfig();
  const res = await fetchWithRetry(`${url}/platform-orgless-send`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      eventType: AGENT_SIGNUP_CODE_TEMPLATE,
      recipientEmail: email,
      metadata: { code, expiresInMinutes: ttlMinutes },
    }),
  });
  if (!res.ok) throw new TransactionalEmailError(res.status, await res.text());
}

/**
 * The staff "new signup" email, the same one a dashboard signup sends
 * (`signup_notification`, routed to the staff list by transactional-email-service,
 * platform-paid, once per org). Fire-and-forget: a staff notification never fails
 * the signup it reports; a failure is logged loudly.
 */
export function notifyStaffSignup(params: { orgId: string; email: string }): void {
  void (async () => {
    const { url, apiKey } = getConfig();
    const res = await fetchWithRetry(`${url}/platform-send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "x-org-id": params.orgId },
      body: JSON.stringify({
        eventType: "signup_notification",
        metadata: { email: params.email, timestamp: new Date().toISOString(), source: "agent_api" },
      }),
    });
    if (!res.ok) throw new TransactionalEmailError(res.status, await res.text());
  })().catch((err) => {
    console.error(`[client-service] staff signup email FAILED for org ${params.orgId}:`, err);
  });
}

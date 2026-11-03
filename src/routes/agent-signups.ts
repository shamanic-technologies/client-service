import express, { Router, type Request, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { AgentSignupStartBodySchema, AgentSignupCompleteBodySchema, AgentSignupApproveBodySchema } from "../schemas.js";
import {
  AgentSignupError,
  approveAgentSignup,
  completeAgentSignup,
  readApproval,
  startAgentSignup,
  type ApprovalView,
} from "../lib/agent-signup.js";
import { sendAgentSignupCode } from "../lib/transactional-email-client.js";
import { ClerkServiceError } from "../lib/clerk-client.js";
import { BillingServiceError } from "../lib/billing-service-client.js";
import { errorReason } from "../lib/pg-error.js";

/**
 * An AI agent opens an account by itself: email + phone, a code to the email,
 * the account for the code, or for the poll token once the inbox owner clicked
 * the email's link (approve routes below, a human-facing page the gateway
 * serves publicly) (src/lib/agent-signup.ts). The completion can also
 * bind a channel-verified WhatsApp number to that account (`whatsappPhone`). api-service exposes the
 * public routes and calls these with its service key.
 */
const router = Router();

const STATUS: Record<AgentSignupError["code"], number> = {
  no_pending_code: 404,
  code_invalid: 400,
  code_expired: 410,
  too_many_attempts: 429,
  authorization_pending: 400,
  approval_expired: 410,
  poll_token_unknown: 404,
};

function invalid(res: Response, message: string) {
  return res.status(400).json({ error: "invalid_request", message });
}

router.post("/internal/agent-signups/start", requireApiKey, async (req, res) => {
  const parsed = AgentSignupStartBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return invalid(res, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }

  try {
    const sent = await startAgentSignup(parsed.data, sendAgentSignupCode);
    return res.status(200).json({
      ...sent,
      expiresAt: sent.expiresAt.toISOString(),
      approvalExpiresAt: sent.approvalExpiresAt.toISOString(),
    });
  } catch (error) {
    console.error("[client-service] agent signup code email failed:", error);
    return res.status(502).json({
      error: "code_email_failed",
      message: `The code email could not be sent: ${errorReason(error)}`,
    });
  }
});

router.post("/internal/agent-signups/complete", requireApiKey, async (req, res) => {
  const parsed = AgentSignupCompleteBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return invalid(res, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }

  try {
    const account = await completeAgentSignup(parsed.data);
    return res.status(200).json(account);
  } catch (error) {
    if (error instanceof AgentSignupError) {
      return res.status(STATUS[error.code]).json({
        error: error.code,
        message: error.message,
        ...(error.attemptsLeft !== undefined && { attemptsLeft: error.attemptsLeft }),
      });
    }
    if (error instanceof ClerkServiceError) {
      return res.status(502).json({ error: "identity_provider_failed", message: `Clerk: ${error.body}` });
    }
    if (error instanceof BillingServiceError) {
      return res.status(502).json({ error: "billing_unavailable", message: `billing-service: ${error.body}` });
    }
    console.error("[client-service] agent signup completion error:", error);
    return res.status(500).json({
      error: "internal_error",
      message: error instanceof Error ? errorReason(error) : "Agent signup failed",
    });
  }
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${escapeHtml(title)}</title></head>`,
    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;color:#1a1a1a;">',
    `<h1 style="font-size:22px;">${escapeHtml(title)}</h1>`,
    body,
    '<p style="font-size:13px;color:#8b8e98;margin-top:40px;">distribute.you. Revenue made easy.</p>',
    "</body></html>",
  ].join("\n");
}

const P = (text: string) => `<p style="font-size:16px;line-height:1.6;">${text}</p>`;

/** The human page for each state. `confirm` = show the button (GET on a live link). */
function approvalPage(view: ApprovalView, token: string, confirm: boolean): string {
  const email = view.email ? `<strong>${escapeHtml(view.email)}</strong>` : "";
  switch (view.state) {
    case "ready":
      if (!confirm) break;
      return page(
        "Let your AI agent finish your account",
        P(`An AI agent asked to open the distribute.you account of ${email}.`) +
          P("Confirm only if you or your own agent asked for it. Your agent then gets an API key for this account.") +
          `<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="background:#1a1a1a;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:16px;font-weight:600;cursor:pointer;">Confirm</button></form>` +
          P("Did not ask for it? Close this page. Nothing happens without the click."),
      );
    case "approved":
      return page("Done, your agent can finish", P(`The account of ${email} is ready for your agent. You can close this page.`));
    case "expired":
      return page("This link has expired", P("Ask your agent to start again. A new email will arrive."));
    case "superseded":
      return page("A newer email replaced this one", P("Open the latest email from distribute.you and use its button."));
    case "unknown":
      return page("This link is not valid", P("Open the latest email from distribute.you and use its button."));
  }
  return page("This link is not valid", P("Open the latest email from distribute.you and use its button."));
}

function wantsJson(req: Request): boolean {
  return req.is("application/json") === "application/json" || req.accepts(["text/html", "application/json"]) === "application/json";
}

function sendApproval(req: Request, res: Response, view: ApprovalView, token: string, confirm: boolean) {
  if (wantsJson(req)) {
    return res.status(200).json({ ...view, requestedAt: view.requestedAt?.toISOString() ?? null });
  }
  res.set("cache-control", "no-store");
  return res.status(200).type("html").send(approvalPage(view, token, confirm));
}

router.get("/internal/agent-signups/approve", requireApiKey, async (req, res) => {
  const parsed = AgentSignupApproveBodySchema.safeParse({ token: req.query.token });
  if (!parsed.success) return invalid(res, "token: the approval link's token is required");
  try {
    return sendApproval(req, res, await readApproval(parsed.data.token), parsed.data.token, true);
  } catch (error) {
    console.error("[client-service] agent signup approval read error:", error);
    return res.status(500).json({ error: "internal_error", message: errorReason(error) });
  }
});

router.post(
  "/internal/agent-signups/approve",
  requireApiKey,
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const token = (req.body as { token?: unknown } | undefined)?.token ?? req.query.token;
    const parsed = AgentSignupApproveBodySchema.safeParse({ token });
    if (!parsed.success) return invalid(res, "token: the approval link's token is required");
    try {
      return sendApproval(req, res, await approveAgentSignup(parsed.data.token), parsed.data.token, false);
    } catch (error) {
      console.error("[client-service] agent signup approval error:", error);
      return res.status(500).json({ error: "internal_error", message: errorReason(error) });
    }
  },
);

export default router;

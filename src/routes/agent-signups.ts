import { Router, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { AgentSignupStartBodySchema, AgentSignupCompleteBodySchema } from "../schemas.js";
import { AgentSignupError, completeAgentSignup, startAgentSignup } from "../lib/agent-signup.js";
import { sendAgentSignupCode } from "../lib/transactional-email-client.js";
import { ClerkServiceError } from "../lib/clerk-client.js";
import { BillingServiceError } from "../lib/billing-service-client.js";
import { errorReason } from "../lib/pg-error.js";

/**
 * An AI agent opens an account by itself: email + phone, a code to the email,
 * the account for the code (src/lib/agent-signup.ts). The completion can also
 * bind a channel-verified WhatsApp number to that account (`whatsappPhone`). api-service exposes the
 * public routes and calls these with its service key.
 */
const router = Router();

const STATUS: Record<AgentSignupError["code"], number> = {
  no_pending_code: 404,
  code_invalid: 400,
  code_expired: 410,
  too_many_attempts: 429,
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
    return res.status(200).json({ ...sent, expiresAt: sent.expiresAt.toISOString() });
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

export default router;

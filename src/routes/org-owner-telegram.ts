import { Router, type Response } from "express";
import { requireApiKey } from "../middleware/auth.js";
import {
  MemberInvitationsOrgParamsSchema,
  OrgOwnerTelegramMessageBodySchema,
  OrgOwnerTelegramLinkCodeBodySchema,
  OrgOwnerTelegramLinkBodySchema,
} from "../schemas.js";
import {
  OrgOwnerTelegramError,
  consumeLinkCode,
  createLinkCode,
  getOrgOwnerTelegram,
  sendToOrgOwner,
  unlinkOrgOwnerTelegram,
} from "../lib/org-owner-telegram.js";

/**
 * Telegram to an org's OWNER through the platform bot (src/lib/org-owner-telegram.ts).
 * POST .../messages sends one line and always answers a named outcome; the rest
 * is the self-serve link: a code for the dashboard, the bot webhook's consume,
 * a status read and an unlink.
 */
const router = Router();

const STATUS: Record<OrgOwnerTelegramError["code"], number> = {
  org_not_found: 404,
  link_code_unknown: 404,
  link_code_expired: 410,
  link_code_used: 409,
  bot_unavailable: 502,
};

function invalid(res: Response, issues: { path: PropertyKey[]; message: string }[]) {
  return res.status(400).json({
    error: "invalid_request",
    message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  });
}

function fail(res: Response, error: unknown, what: string) {
  if (error instanceof OrgOwnerTelegramError) {
    return res.status(STATUS[error.code]).json({ error: error.code, message: error.message });
  }
  console.error(`[client-service] ${what} failed:`, error);
  return res.status(500).json({ error: "internal_error", message: error instanceof Error ? error.message : `${what} failed` });
}

router.post("/internal/orgs/:orgId/owner-telegram/messages", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  const body = OrgOwnerTelegramMessageBodySchema.safeParse(req.body);
  if (!params.success || !body.success) {
    return invalid(res, [...(params.error?.issues ?? []), ...(body.error?.issues ?? [])]);
  }
  try {
    const result = await sendToOrgOwner(params.data.orgId, body.data.text);
    if (result.outcome !== "sent") {
      console.warn(
        `[client-service] owner Telegram ${result.outcome} for org ${params.data.orgId} (run ${req.header("x-run-id") ?? "none"}): ${result.reason}`,
      );
    }
    return res.json(result);
  } catch (error) {
    return fail(res, error, "send org owner Telegram");
  }
});

router.get("/internal/orgs/:orgId/owner-telegram", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  if (!params.success) return invalid(res, params.error.issues);
  try {
    return res.json(await getOrgOwnerTelegram(params.data.orgId));
  } catch (error) {
    return fail(res, error, "read org owner Telegram");
  }
});

router.delete("/internal/orgs/:orgId/owner-telegram", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  if (!params.success) return invalid(res, params.error.issues);
  try {
    return res.json(await unlinkOrgOwnerTelegram(params.data.orgId));
  } catch (error) {
    return fail(res, error, "unlink org owner Telegram");
  }
});

router.post("/internal/orgs/:orgId/owner-telegram/link-codes", requireApiKey, async (req, res) => {
  const params = MemberInvitationsOrgParamsSchema.safeParse(req.params);
  const body = OrgOwnerTelegramLinkCodeBodySchema.safeParse(req.body);
  if (!params.success || !body.success) {
    return invalid(res, [...(params.error?.issues ?? []), ...(body.error?.issues ?? [])]);
  }
  try {
    return res.status(201).json(await createLinkCode(params.data.orgId, body.data.userId));
  } catch (error) {
    return fail(res, error, "create owner Telegram link code");
  }
});

router.post("/internal/owner-telegram/links", requireApiKey, async (req, res) => {
  const body = OrgOwnerTelegramLinkBodySchema.safeParse(req.body);
  if (!body.success) return invalid(res, body.error.issues);
  try {
    return res.json(await consumeLinkCode(body.data.code, body.data.chatId));
  } catch (error) {
    return fail(res, error, "link owner Telegram chat");
  }
});

export default router;

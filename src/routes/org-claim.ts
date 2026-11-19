import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { OrgClaimParamsSchema, OrgClaimBodySchema } from "../schemas.js";
import { claimOrg } from "../lib/org-claim.js";

const router = Router();

/**
 * POST /internal/orgs/:orgId/claim - An org that came into being without an
 * identity provider now HAS one.
 *
 * The signup wall sits at the END of onboarding: a visitor walks their whole
 * setup signed out, against an ORDINARY org whose external identity is a
 * throwaway id. When they finally sign up they get a real identity-provider
 * organisation, and everything they built — brands, offers, audiences, runs,
 * spend, across five services — is on the throwaway one.
 *
 * This says, once, that the two are the same organisation. The internal uuid is
 * untouched, so every reference taken before the call still resolves; only the
 * external identity is swapped underneath it. There is no copying, no
 * cross-service migration on the signup path, and nothing to lose.
 *
 * It REFUSES rather than guesses, and each refusal is its own `reason` so the
 * caller can show the customer a different thing for each:
 *   404 `org_not_found`      - no such org.
 *   409 `org_not_anonymous`  - this org was never a throwaway one. Anonymity is
 *                              a fact we RECORDED at creation, never something
 *                              inferred from what the external id looks like.
 *   409 `org_already_claimed`- it already carries a different identity.
 *   409 `external_id_taken`  - that identity belongs to another org, and that org
 *                              is somebody's: anonymous, claimed, or holding
 *                              work, money or members of its own.
 *   409 `org_slug_taken`     - the identity's SLUG belongs to another org that
 *                              is somebody's. Only a name is taken, so it is
 *                              never reported as the identity being taken.
 *   502 `identity_holder_unverifiable`
 *                            - another org holds the identity and we could not
 *                              find out whether anything of anybody's sits on
 *                              it. Not knowing is never read as "it is empty".
 *
 * THE SHELL. An identity-provider organisation is ONE organisation, and by the
 * time the claim arrives a SECOND row of ours can already describe it: an
 * authenticated read resolved the identity a second earlier and, as designed,
 * brought an org into being for it. That row was never a decision — nobody
 * declared it anonymous, nobody ever claimed it, and it holds nothing but the
 * person who just signed up. Refusing on its account locks a customer out of ten
 * minutes of their own work, so the claim takes the identity off it and records
 * where it went (`absorbed_into_org_id`). Every other refusal stands untouched:
 * an org that IS anonymous, or HAS been claimed, or that anybody built anything
 * in, keeps its identity and the claim still answers `external_id_taken`.
 * What is handed over is the WHOLE identity — the external id AND the slug,
 * which came from the same identity-provider organisation and is held here
 * under a unique index. A field left on the shell is a field the identity's own
 * org cannot be resolved with, and the next authenticated read 500s on it.
 * Emptiness is CHECKED — members and state here, brands and money at the
 * services that own them — never assumed, and never inferred from what an
 * external id looks like.
 *
 * Idempotent: replaying the exact same claim re-attaches the same person and
 * answers 200 with `alreadyClaimed: true`. A retried signup, or a browser that
 * replays the request, never produces a second organisation nor an error the
 * customer sees.
 *
 * This is NOT an org-merge or org-transfer facility. It is the one transition
 * anonymous -> identified, and that narrowness is what makes it safe.
 */
router.post("/internal/orgs/:orgId/claim", requireApiKey, async (req, res) => {
  const parsedParams = OrgClaimParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: "Invalid parameters",
      reason: "invalid_request",
      details: parsedParams.error.flatten(),
    });
  }

  const parsedBody = OrgClaimBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Invalid request body",
      reason: "invalid_request",
      details: parsedBody.error.flatten(),
    });
  }

  // The transition itself lives in `src/lib/org-claim.ts`, shared with the
  // agent-signup completion that names an unclaimed org: one way to claim.
  const outcome = await claimOrg(parsedParams.data.orgId, parsedBody.data);
  return res.status(outcome.status).json(outcome.body);
});

export default router;

import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Shared schemas ---

const ErrorResponseSchema = z
  .object({
    error: z.string(),
  })
  .openapi("ErrorResponse");

// --- Health ---

const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi("HealthResponse");

// --- Resolve ---

export const ResolveBodySchema = z
  .object({
    externalOrgId: z.string().min(1),
    externalUserId: z.string().min(1),
    email: z.string().email().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    imageUrl: z.string().url().optional(),
    orgName: z.string().optional(),
    orgSlug: z.string().min(1).optional(),
    anonymous: z.boolean().optional().openapi({
      description:
        "This org is coming into being WITHOUT an identity provider — the signed-out phase of onboarding, where the caller mints `externalOrgId` itself. Recorded on the row we CREATE and never re-derived afterwards, because it is what decides whether the org may later be claimed by a real identity. An existing org keeps whatever it already is: a real organisation can never be re-labelled anonymous by a later resolve.",
    }),
  })
  .openapi("ResolveBody");

const ResolveResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    userId: z.string().uuid(),
    orgCreated: z.boolean(),
    userCreated: z.boolean(),
  })
  .openapi("ResolveResponse");

// --- Phone Accounts (channel-origin signup) ---

// E.164: leading '+', country digit 1-9, then up to 14 more digits.
const E164Phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164 format, e.g. +15551234567");

export const ProvisionPhoneAccountBodySchema = z
  .object({
    phone: E164Phone,
  })
  .openapi("ProvisionPhoneAccountBody");

export const ResolvePhoneAccountQuerySchema = z
  .object({
    phone: E164Phone,
  })
  .openapi("ResolvePhoneAccountQuery");

const PhoneAccountResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    userId: z.string().uuid(),
    phone: z.string(),
    clerkOrgId: z.string(),
    clerkUserId: z.string(),
    created: z.boolean(),
  })
  .openapi("PhoneAccountResponse");

// --- Get User by ID ---

export const GetUserParamsSchema = z
  .object({
    userId: z.string().uuid(),
  })
  .openapi("GetUserParams");

const GetUserResponseSchema = z
  .object({
    user: z.object({
      id: z.string().uuid(),
      email: z.string().nullable(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
    }),
  })
  .openapi("GetUserResponse");

// --- List Users ---

export const ListUsersQuerySchema = z
  .object({
    orgId: z.string().uuid().optional(),
    externalOrgId: z.string().min(1).optional(),
    email: z.string().optional(),
    limit: z.coerce.number().int().min(1).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListUsersQuery");

const ListUsersUserSchema = z
  .object({
    id: z.string().uuid(),
    externalId: z.string().nullable(),
    email: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    imageUrl: z.string().nullable(),
    phone: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("ListUsersUser");

const ListUsersResponseSchema = z
  .object({
    users: z.array(ListUsersUserSchema),
    total: z.number().int(),
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
  })
  .openapi("ListUsersResponse");

// --- Org Membership Check ---

export const OrgMemberCheckParamsSchema = z
  .object({
    orgId: z.string().uuid(),
    userId: z.string().uuid(),
  })
  .openapi("OrgMemberCheckParams");

// --- Org Get ---

export const OrgGetParamsSchema = z
  .object({
    orgId: z.string().uuid(),
  })
  .openapi("OrgGetParams");

const OrgRecordResponseSchema = z
  .object({
    id: z.string().uuid(),
    externalId: z.string().nullable(),
    name: z.string().nullable(),
  })
  .openapi("OrgRecordResponse");

// --- Org Claim (anonymous org -> identity-provider org) ---

export const OrgClaimParamsSchema = z
  .object({
    orgId: z.string().uuid().openapi({
      description:
        "The internal uuid of the anonymous org — the one every brand, funnel, audience, run and cost was written against while the visitor was signed out. It does not change; only the external identity does.",
    }),
  })
  .openapi("OrgClaimParams");

export const OrgClaimBodySchema = z
  .object({
    externalOrgId: z.string().min(1).openapi({
      description: "The identity-provider organisation id the visitor just created (the Clerk `org_...`).",
    }),
    externalUserId: z.string().min(1).openapi({
      description:
        "The identity-provider user id of the person signing up. They end up attached to the org the way any member is.",
    }),
    email: z.string().email().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    imageUrl: z.string().url().optional(),
    orgName: z.string().optional(),
    orgSlug: z.string().min(1).optional(),
  })
  .openapi("OrgClaimBody");

const OrgClaimResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    userId: z.string().uuid(),
    externalOrgId: z.string(),
    claimedAt: z.string(),
    alreadyClaimed: z.boolean().openapi({
      description:
        "true when this exact claim had already been made — a retried signup or a replayed request. The answer is the same either way; nothing is created twice.",
    }),
  })
  .openapi("OrgClaimResponse");

const OrgClaimRefusalSchema = z
  .object({
    error: z.string(),
    reason: z.enum([
      "org_not_found",
      "org_not_anonymous",
      "org_already_claimed",
      "external_id_taken",
      "invalid_request",
      "internal_error",
    ]),
  })
  .openapi("OrgClaimRefusal");

// --- Org reality (is this org a real one, or an abandoned anonymous walk?) ---

export const OrgRealityBodySchema = z
  .object({
    orgIds: z
      .array(z.string().uuid())
      .max(500)
      .openapi({
        description:
          "Internal org uuids to ask about. A domain can be owned by more than one org, so the question is asked for several at once.",
      }),
  })
  .openapi("OrgRealityBody");

const OrgRealityResponseSchema = z
  .object({
    realOrgIds: z.array(z.string().uuid()).openapi({
      description:
        "The subset of the submitted ids that name a REAL organisation. Ids that are anonymous-and-unclaimed, and ids that name no org at all, are absent.",
    }),
  })
  .openapi("OrgRealityResponse");

// --- Reward tasks (bronze / silver / gold ledger) ---

export const BrandRewardTasksParamsSchema = z
  .object({
    brandId: z.string().uuid(),
  })
  .openapi("BrandRewardTasksParams");

export const BrandRewardTasksHeadersSchema = z
  .object({
    "x-org-id": z.string().uuid().optional().openapi({
      description:
        "Whose reward ledger to read. Optional when exactly one org claims the brand; REQUIRED when several do — we will not guess whose money a reward is.",
    }),
  })
  .openapi("BrandRewardTasksHeaders");

const RewardTaskScopeSchema = z
  .object({
    type: z.literal("sales_funnel").openapi({
      description:
        "The granularity the task belongs to. The first reward task lives on ONE sales funnel of one offer of one brand.",
    }),
    brandId: z.string().uuid(),
    offerId: z.string().uuid(),
    funnelKey: z.string().openapi({
      description: "brand-service's funnel key, e.g. `website_purchases`.",
    }),
  })
  .openapi("RewardTaskScope");

const RewardTaskSchema = z
  .object({
    taskKey: z.literal("sales_funnel_refresh").openapi({
      description:
        "Refresh this funnel's own money numbers: its conversion rates, the lifetime revenue of a client won through it, and where it sends people. Every money figure the product shows this customer is computed from them, so stale inputs make every one of them quietly wrong.",
    }),
    scope: RewardTaskScopeSchema,
    rewardCents: z.number().int().openapi({
      description: "What completing this task pays the customer, in cents. billing-service grants it; client-service holds no money.",
    }),
    due: z.boolean().openapi({ description: "True when the refresh is currently owed." }),
    dueAt: z.string().openapi({
      description:
        "The instant this task becomes due — 30 days after its numbers last genuinely changed. While `due` is false it is in the future; when `due` is true it is SINCE WHEN the refresh has been owed.",
    }),
    lastCompletedAt: z.string().nullable().openapi({
      description: "When this task was last completed, or null if never.",
    }),
    completedCount: z.number().int().openapi({
      description: "How many times this task has been completed and paid, ever.",
    }),
    contentChangedAt: z.string().openapi({
      description: "When this funnel's money content last genuinely changed. The clock the 30 days run from.",
    }),
    contentChangedProvenance: z.enum(["observed", "producer_ts"]).openapi({
      description:
        "`observed`: we compared two readings of the numbers and they differed — ours, certain. `producer_ts`: the first time we ever saw this funnel, so the baseline is brand-service's own last-touched timestamp. That timestamp also moves when a funnel is merely switched off or on, so it is an UPPER bound on the real change time: the task comes due no EARLIER than it should, never sooner.",
    }),
  })
  .openapi("RewardTask");

const RewardTaskRollupSchema = z
  .object({
    dueCount: z.number().int(),
    taskCount: z.number().int(),
  })
  .openapi("RewardTaskRollup");

export const BrandRewardTasksResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    orgId: z.string().uuid().nullable().openapi({
      description: "Whose ledger this is. Null only when no org claims the brand — there is then nobody to reward.",
    }),
    status: z.enum(["ok", "no_org_claims_brand"]).openapi({
      description:
        "`no_org_claims_brand`: brand-service reports no org claiming this id (unknown brand, or an unclaimed global brand row), so no customer can earn on it. It is a determinate answer, not a failure and not a silent nothing-is-due — an upstream we could not reach is a 502 instead.",
    }),
    rewardCentsPerTask: z.number().int(),
    tasks: z.array(RewardTaskSchema).openapi({
      description:
        "One entry per CURRENTLY ACTIVE sales funnel of this brand. A funnel switched off is not listed: nobody can refresh numbers on a funnel that is off. Its refresh clock is kept, so switching it back on does not reset anything.",
    }),
    rollup: z
      .object({
        brand: RewardTaskRollupSchema,
        offers: z.array(z.object({ offerId: z.string().uuid() }).extend(RewardTaskRollupSchema.shape)),
      })
      .openapi({
        description:
          "How many children a superior scope has with something due, without restating the children's tasks: a brand page renders `brand`, an offer page renders its entry in `offers`.",
      }),
  })
  .openapi("BrandRewardTasksResponse");

// --- Brand checkout status ---

export const BrandCheckoutParamsSchema = z
  .object({
    brandId: z.string().uuid(),
  })
  .openapi("BrandCheckoutParams");

export const OrgBrandCheckoutParamsSchema = z
  .object({
    orgId: z.string().uuid(),
    brandId: z.string().uuid(),
  })
  .openapi("OrgBrandCheckoutParams");

const OrgPaymentTotalSchema = z
  .object({
    currency: z.string().openapi({ description: "Stripe currency code, e.g. 'usd'." }),
    amountReceivedCents: z.number().int().openapi({
      description:
        "Gross minor units this org paid in, over its `succeeded` Stripe PaymentIntents. Never netted against refunds or lost disputes — a refund does not un-happen the checkout.",
    }),
  })
  .openapi("OrgPaymentTotal");

const OrgBrandCheckoutSchema = z
  .object({
    orgId: z.string().uuid(),
    brandId: z.string().uuid(),
    checkedOut: z.boolean().openapi({
      description:
        "True when this org both paid real money in AND committed this brand to spend (per-brand daily budget configured).",
    }),
    reason: z.enum(["checked_out", "no_brand_budget", "org_never_paid"]).openapi({
      description:
        "Why the verdict is what it is. `no_brand_budget`: this org set no daily budget for the brand, so it never committed it (reported first — it is the brand-specific miss). `org_never_paid`: the brand is committed but the org has no succeeded Stripe payment.",
    }),
    brandDailyBudgetCents: z.string().nullable().openapi({
      description:
        "billing-service's stored per-(org, brand) daily spend ceiling, verbatim, or null when this org configured none. Null is a real unset state, never a defaulted zero.",
    }),
    orgPayments: z.array(OrgPaymentTotalSchema).openapi({
      description:
        "Gross paid in per currency, from stripe-service. Empty when the org has no mirrored payments — never a fabricated zero row. Currencies are never summed together.",
    }),
  })
  .openapi("OrgBrandCheckout");

const BrandCheckoutResponseSchema = z
  .object({
    brandId: z.string().uuid(),
    status: z.enum(["checked_out", "not_checked_out", "no_org_claims_brand"]).openapi({
      description:
        "`checked_out`: at least one claiming org completed checkout. `not_checked_out`: the brand IS claimed by one or more orgs and none of them completed checkout — a truthful 'nobody paid for this brand'. `no_org_claims_brand`: brand-service reports no org claiming this id (unknown brand, or an unclaimed global brand row), so nobody can have paid on it.",
    }),
    checkedOut: z.boolean(),
    orgs: z.array(OrgBrandCheckoutSchema).openapi({
      description:
        "One entry per org claiming this brand, each with its own verdict. Empty only when status is `no_org_claims_brand`. The orgs that paid are the entries with `checkedOut: true`.",
    }),
  })
  .openapi("BrandCheckoutResponse");

// --- Org Teardown ---

export const OrgTeardownParamsSchema = z
  .object({
    orgId: z.string().uuid(),
  })
  .openapi("OrgTeardownParams");

export const OrgTeardownByExternalParamsSchema = z
  .object({
    externalOrgId: z.string().min(1),
  })
  .openapi("OrgTeardownByExternalParams");

const OrgTeardownResponseSchema = z
  .object({
    orgId: z.string().uuid(),
    clientService: z.object({
      orgs: z.number().int(),
      users: z.number().int(),
      invites: z.number().int(),
      rewardTasks: z.number().int().openapi({
        description:
          "Reward-task ledger rows removed for this org. The ledger is keyed on the org uuid rather than by FK, so it is cleared explicitly; each state's completions cascade with it.",
      }),
    }),
    billing: z.literal("deleted"),
    campaign: z.literal("deleted"),
    runs: z.literal("deleted"),
    key: z.literal("deleted"),
    stripe: z.literal("deleted"),
    clerk: z.enum(["deleted", "not_found"]),
    clerkUsers: z.object({
      deleted: z.number().int(),
      notFound: z.number().int(),
    }),
  })
  .openapi("OrgTeardownResponse");

const UpstreamErrorResponseSchema = z
  .object({
    error: z.string(),
    provider: z.enum(["billing", "campaign", "runs", "key", "stripe", "clerk"]),
    upstreamStatus: z.number().int(),
    upstreamBody: z.string(),
  })
  .openapi("UpstreamErrorResponse");

// --- Public Stats ---

const MonthlyGrowthEntrySchema = z
  .object({
    month: z.string(),
    newOrgs: z.number().int(),
    newUsers: z.number().int(),
  })
  .openapi("MonthlyGrowthEntry");

const PublicStatsResponseSchema = z
  .object({
    totalOrgs: z.number().int(),
    totalUsers: z.number().int(),
    monthlyGrowth: z.array(MonthlyGrowthEntrySchema),
  })
  .openapi("PublicStatsResponse");

// --- Invites ---

export const ValidateInviteBodySchema = z
  .object({
    code: z.string().min(1),
  })
  .openapi("ValidateInviteBody");

const ValidateInviteResponseSchema = z
  .object({
    valid: z.boolean(),
    inviterOrgName: z.string().optional(),
  })
  .openapi("ValidateInviteResponse");

export const ClaimInviteBodySchema = z
  .object({
    code: z.string().min(1),
    inviteeOrgId: z.string().uuid(),
  })
  .openapi("ClaimInviteBody");

const ClaimInviteResponseSchema = z
  .object({
    ok: z.boolean(),
    inviterOrgId: z.string().uuid(),
  })
  .openapi("ClaimInviteResponse");

export const InviteStatusParamsSchema = z
  .object({
    orgId: z.string().uuid(),
  })
  .openapi("InviteStatusParams");

const InviteStatusResponseSchema = z
  .object({
    signups: z
      .number()
      .int()
      .describe("How many orgs have signed up through this org's invite code. Uncapped."),
    code: z.string().nullable(),
  })
  .openapi("InviteStatusResponse");

// --- Waitlist ---

export const WaitlistRequestBodySchema = z
  .object({
    email: z.string().email(),
    brandUrl: z.string().min(1),
  })
  .openapi("WaitlistRequestBody");

const WaitlistRequestResponseSchema = z
  .object({
    ok: z.literal(true),
    position: z.number().int(),
  })
  .openapi("WaitlistRequestResponse");

export const WaitlistPositionQuerySchema = z
  .object({
    email: z.string().email(),
  })
  .openapi("WaitlistPositionQuery");

const WaitlistPositionResponseSchema = z
  .object({
    position: z.number().int(),
  })
  .openapi("WaitlistPositionResponse");

// --- Security schemes ---

registry.registerComponent("securitySchemes", "ApiKeyAuth", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
});

// --- Register endpoints ---

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/users/{userId}",
  summary: "Get a user by internal UUID",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: GetUserParamsSchema,
  },
  responses: {
    200: {
      description: "User found",
      content: { "application/json": { schema: GetUserResponseSchema } },
    },
    404: {
      description: "User not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/users",
  summary: "List users filtered by org",
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: ListUsersQuerySchema,
  },
  responses: {
    200: {
      description: "Users list",
      content: { "application/json": { schema: ListUsersResponseSchema } },
    },
    400: {
      description: "Invalid query parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/orgs/{orgId}",
  summary: "Get an org record (id, external Clerk org id, name) by internal UUID",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: OrgGetParamsSchema,
  },
  responses: {
    200: {
      description: "Org found",
      content: { "application/json": { schema: OrgRecordResponseSchema } },
    },
    400: {
      description: "Invalid orgId",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Org not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/orgs/{orgId}/claim",
  summary: "An org that came into being without an identity provider now has one",
  description:
    "The signup wall sits at the END of onboarding. A visitor types their website and walks their entire setup — services, funnels, audiences, conversion rates, offer — signed out, and only then creates an account and pays. That signed-out phase is an ORDINARY organisation: one whose external identity is a throwaway id the dashboard mints instead of an identity-provider id. Brands, funnels, audiences, runs and spend are all written against it exactly as for any customer, because it IS an org.\n\nAt signup the visitor gets a brand-new identity-provider organisation, and everything they built is on the throwaway one. This endpoint says, once, that the two are the same organisation. The internal uuid is UNTOUCHED, so every reference taken before the call still resolves; only the external identity is swapped underneath it. Nothing is copied: there is no cross-service migration on the signup path, and therefore no failure mode that loses a customer's work right after they paid.\n\nIDEMPOTENT. Replaying the exact same claim re-attaches the same person and answers 200 with `alreadyClaimed: true`. A retried signup, or a browser that replays the request, produces neither a second organisation nor an error the customer sees.\n\nIT REFUSES RATHER THAN GUESSES, and each refusal carries its own `reason` so the caller can show the customer a different thing for each: `org_not_found`, `org_not_anonymous` (this org was never a throwaway one), `org_already_claimed` (it already carries a different identity), `external_id_taken` (that identity belongs to another org). Anonymity is a fact we RECORDED when the org was created (`anonymous: true` on /internal/resolve), never something inferred by inspecting what the external id looks like — a wrong guess would hand a stranger an organisation.\n\nThis is NOT an org-merge or org-transfer facility. It is the one transition anonymous -> identified, and that narrowness is what makes it safe.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: OrgClaimParamsSchema,
    body: {
      content: { "application/json": { schema: OrgClaimBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "The org now resolves by its new identity-provider id, and the signing-up person is a member of it. `alreadyClaimed: true` when this was a replay.",
      content: { "application/json": { schema: OrgClaimResponseSchema } },
    },
    400: {
      description: "Invalid orgId or body (`invalid_request`)",
      content: { "application/json": { schema: OrgClaimRefusalSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No such org (`org_not_found`)",
      content: { "application/json": { schema: OrgClaimRefusalSchema } },
    },
    409: {
      description:
        "Refused, distinguishably: `org_not_anonymous` (never a throwaway org), `org_already_claimed` (already carries a different identity), `external_id_taken` (that identity belongs to another org).",
      content: { "application/json": { schema: OrgClaimRefusalSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: OrgClaimRefusalSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/orgs/real",
  summary: "Which of these organisations are real ones?",
  description:
    "An organisation can come into being WITHOUT an identity provider: the signed-out phase of onboarding mints one before anything else exists, and brands, funnels and audiences are written against it exactly as for any customer. Nearly every such walk is abandoned, and the org then stays anonymous and unclaimed forever — a ghost with no person, no signup and no payment behind it.\n\nThis endpoint tells a caller which of the orgs it already holds are REAL. REAL means anything that is not an anonymous org still awaiting a claim: an ordinary org that was never anonymous is real, and an anonymous org that HAS since been claimed is real, because somebody signed up and it is theirs.\n\nBoth facts are recorded by this service — anonymity at creation, on the caller's declaration (`anonymous: true` on /internal/resolve), and the claim at POST /internal/orgs/{orgId}/claim. Neither is ever inferred from what an external org id looks like: the record exists precisely so nobody has to read a prefix, and a wrong guess would hand a stranger an organisation.\n\nThe answer carries NOTHING about an org beyond its id. The caller is typically acting on behalf of a visitor with no account, so no name, external identity or timestamp crosses the boundary — and an id naming no org is simply absent from the answer rather than distinguished, which is the same verdict (nobody real owns it) and leaks nothing about whether the id exists.\n\nFAIL LOUD. A read that could not be performed is a 500, never an empty list: a caller must be able to tell 'none of these are real' from 'we could not find out', or a real customer's domain could be handed away on a defaulted answer.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: OrgRealityBodySchema } },
    },
  },
  responses: {
    200: {
      description: "The subset of the submitted ids that are real organisations",
      content: { "application/json": { schema: OrgRealityResponseSchema } },
    },
    400: {
      description: "Body is not { orgIds: uuid[] }",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description:
        "The read failed. Fail loud — never a defaulted 'none of these are real'.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/orgs/{orgId}/members/{userId}",
  summary: "Check if a user is a member of an org",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: OrgMemberCheckParamsSchema,
  },
  responses: {
    200: {
      description: "User is a member of the org",
    },
    404: {
      description: "User is not a member of the org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/checkout-status",
  summary: "Has ANY org gone through checkout for this brand?",
  description:
    "Answers, for one brand, whether any organization has actually gone through checkout on it — and which. client-service owns the user journey and sits between brand identity (brand-service) and money (billing-service / stripe-service), so it owns this join; consumers must not reconstruct it.\n\nAn (org, brand) pair counts as CHECKED OUT when BOTH legs hold: (1) MONEY — the org paid real money in (stripe-service reports a positive gross `amount_received` over its succeeded PaymentIntents); (2) BRAND COMMITMENT — the org configured a per-brand daily spend ceiling for THIS brand (a billing-service brand daily-budget row). Stripe carries no brand on any Checkout Session or PaymentIntent in the fleet, so the money leg alone cannot tell one brand from another; the budget leg is what makes the answer brand-specific, and in the product it is written by the post-payment launch step — an onboarding abandoned before paying never reaches it.\n\nBoth legs are read live from their owning service. client-service stores no copy and derives no fallback: an unset budget stays null, an org with no mirrored payments stays unpaid.\n\nThe never-paid case is a truthful 200, never a 404: `not_checked_out` means the brand IS claimed by orgs and none of them paid, while `no_org_claims_brand` means brand-service reports no org claiming this id at all (unknown brand, or an unclaimed global brand row).",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: BrandCheckoutParamsSchema,
  },
  responses: {
    200: {
      description: "Brand checkout status across every org claiming the brand",
      content: { "application/json": { schema: BrandCheckoutResponseSchema } },
    },
    400: {
      description: "brandId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        "An upstream owner (brand-service, billing-service or stripe-service) failed. Fail loud — never a partial or defaulted verdict.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/orgs/{orgId}/brands/{brandId}/checkout-status",
  summary: "Has THIS org gone through checkout for this brand?",
  description:
    "Single-pair verdict, same definition of 'checked out' as GET /internal/brands/{brandId}/checkout-status: the org must have paid real money in AND configured a per-brand daily spend ceiling for this brand.\n\nUse this when the caller already knows which org to ask about — it skips the brand-service membership lookup entirely. Because no brand lookup happens, this route cannot report `no_org_claims_brand`: an (org, brand) pair with no evidence returns `checkedOut: false` with the reason that applies.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: OrgBrandCheckoutParamsSchema,
  },
  responses: {
    200: {
      description: "Checkout verdict for this (org, brand) pair",
      content: { "application/json": { schema: OrgBrandCheckoutSchema } },
    },
    400: {
      description: "orgId or brandId is not a valid UUID",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        "An upstream owner (billing-service or stripe-service) failed. Fail loud — never a partial or defaulted verdict.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/internal/orgs/{orgId}",
  summary: "Cascade-teardown an org across spend/security producers, Stripe, Clerk, and client-service",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: OrgTeardownParamsSchema,
  },
  responses: {
    200: {
      description: "Teardown result (idempotent: re-run reports zero rows)",
      content: { "application/json": { schema: OrgTeardownResponseSchema } },
    },
    400: {
      description: "Invalid orgId",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        "Upstream producer/provider (billing, campaign, runs, key, stripe-service, or Clerk) failed — fail loud, no partial success",
      content: { "application/json": { schema: UpstreamErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/internal/orgs/by-external/{externalOrgId}",
  summary:
    "Cascade-teardown an org by its external Clerk org id (resolves external_id -> internal UUID read-only, 404 if unknown)",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: OrgTeardownByExternalParamsSchema,
  },
  responses: {
    200: {
      description: "Teardown result (idempotent: re-run reports zero rows)",
      content: { "application/json": { schema: OrgTeardownResponseSchema } },
    },
    400: {
      description: "Invalid externalOrgId",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No org found for the given external id (nothing created)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        "Upstream producer/provider (billing, campaign, runs, key, stripe-service, or Clerk) failed — fail loud, no partial success",
      content: { "application/json": { schema: UpstreamErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/stats/users",
  summary: "Get platform-wide stats (total orgs, users, monthly growth)",
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      description: "Platform stats",
      content: { "application/json": { schema: PublicStatsResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/resolve",
  summary: "Resolve external org/user IDs to internal UUIDs (idempotent upsert)",
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ResolveBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Identity resolved",
      content: { "application/json": { schema: ResolveResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/phone-accounts",
  summary:
    "Provision (or return) a full signup-equivalent account for a phone number — idempotent per phone",
  description:
    "Turns an unauthenticated phone number into a first-class platform account: creates a Clerk user keyed on a synthetic placeholder email (NOT the phone — Clerk's phone identifier is globally country-restricted, e.g. France/+33) + Clerk organization, maps them to internal UUIDs, persists the phone as the channel's mapping key, and triggers billing-service's welcome path (welcome credit + Stripe customer). Works for any country's phone. Idempotent per phone: a repeat call returns the existing identity with created=false and no side effects. Claimable later on the dashboard by linking the person's real email/OAuth to the same Clerk user.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ProvisionPhoneAccountBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Account resolved (created=false) or newly provisioned (created=true)",
      content: { "application/json": { schema: PhoneAccountResponseSchema } },
    },
    400: {
      description: "Invalid phone (not E.164)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upstream provider (Clerk or billing-service) failed — fail loud, no partial account",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/phone-accounts",
  summary: "Resolve a KNOWN phone number to its account identity (never creates)",
  description:
    "Read-only lookup: resolves a phone number to its existing org/user identity. 404 when no account exists for the phone (use POST to provision).",
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: ResolvePhoneAccountQuerySchema,
  },
  responses: {
    200: {
      description: "Account identity for the phone (created=false)",
      content: { "application/json": { schema: PhoneAccountResponseSchema } },
    },
    400: {
      description: "Invalid or missing phone (not E.164)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "No account exists for the phone number",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/public/invites/validate",
  summary: "Validate an invite code (slug + cap check)",
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ValidateInviteBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Validation result (valid=false means no org owns this code — there is no cap)",
      content: { "application/json": { schema: ValidateInviteResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/invites/claim",
  summary:
    "Claim an invite code for a freshly-created org (idempotent) and tell billing-service who referred whom",
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ClaimInviteBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Invite claimed (or already claimed by same invitee)",
      content: { "application/json": { schema: ClaimInviteResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Unknown invite code or invitee org",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        "Invite recorded but billing-service could not be notified — retry the same claim (idempotent; it will re-send the notification and not duplicate it)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/orgs/{orgId}/invites/status",
  summary: "Get invite usage status for an org",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: InviteStatusParamsSchema,
  },
  responses: {
    200: {
      description: "Invite status",
      content: { "application/json": { schema: InviteStatusResponseSchema } },
    },
    400: {
      description: "Invalid orgId",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Org not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/public/waitlist/request-access",
  summary: "Request waitlist access (idempotent on email)",
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: WaitlistRequestBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Waitlist entry created or existing position returned",
      content: { "application/json": { schema: WaitlistRequestResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/public/waitlist/position",
  summary: "Get waitlist position for an email",
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: WaitlistPositionQuerySchema,
  },
  responses: {
    200: {
      description: "Position found",
      content: { "application/json": { schema: WaitlistPositionResponseSchema } },
    },
    400: {
      description: "Invalid email",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Email not on waitlist",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/reward-tasks",
  summary: "The reward tasks of this brand's sales funnels: what is due, since when, and when it was last done",
  description:
    "client-service owns the customer's reward-task ledger, because it is the identity root and nothing else in the fleet remembers this. The ledger is layered: BRONZE is what brand-service actually served us for a funnel, SILVER is the canonical per-task state derived from it, GOLD is the view this endpoint answers from.\n\nThe first granularity is the SALES FUNNEL and the first task is `sales_funnel_refresh`. A funnel's own money numbers — its conversion rates, the lifetime revenue of a client won through it, its destination and booking links — go stale, and every money figure the product shows that customer is computed from them, so we ask for a refresh roughly every 30 days. Completing one pays the customer $1.\n\nHOW A REAL REFRESH IS TOLD FROM A NO-OP. brand-service serves a last-touched timestamp with those numbers, but it is NOT a confirmation: it also moves when a funnel is merely switched off or back on, with nobody having looked at a single number. So a completion is judged on the money CONTENT itself — a fingerprint over the rates, the lifetime revenue and the links, with `active` and the timestamp deliberately excluded. Switching a funnel off and on again therefore completes nothing and pays nothing.\n\nTHIS READ OBSERVES, and there is no background job. The customer is on the funnel's page when they save their numbers and the dashboard re-reads this immediately after, so the read that matters always happens; a sweep nobody reads would be worse than none. A refresh that completes a task is paid inside this call — client-service tells billing-service, on the request path, and writes its delivery marker only once billing acknowledges, so a failed notification retries on the next call and a repeat never pays twice. client-service grants no credit and opens no promise: the money is billing's.\n\nFail loud everywhere: an upstream that could not answer is a 502, never a defaulted 'nothing is due'.",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: BrandRewardTasksParamsSchema,
    headers: BrandRewardTasksHeadersSchema,
  },
  responses: {
    200: {
      description: "This brand's sales-funnel reward tasks, with per-offer and per-brand due counts",
      content: { "application/json": { schema: BrandRewardTasksResponseSchema } },
    },
    400: {
      description:
        "brandId is not a valid UUID, x-org-id is not a valid UUID, or several orgs claim the brand and none was named (`ORG_REQUIRED`)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        "An upstream owner failed: brand-service could not serve the offers or funnels, or billing-service could not be told about a completion. Never a partial or defaulted answer — a completion that billing has not acknowledged stays undelivered and retries.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

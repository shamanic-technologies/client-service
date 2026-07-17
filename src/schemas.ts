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

const ClaimInviteCappedResponseSchema = z
  .object({
    error: z.string(),
    used: z.number().int(),
    total: z.number().int(),
  })
  .openapi("ClaimInviteCappedResponse");

export const InviteStatusParamsSchema = z
  .object({
    orgId: z.string().uuid(),
  })
  .openapi("InviteStatusParams");

const InviteStatusResponseSchema = z
  .object({
    used: z.number().int(),
    total: z.number().int(),
    code: z.string().nullable(),
    expired: z.boolean(),
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
    "Turns an unauthenticated phone number into a first-class platform account: creates a Clerk user (phone identifier) + Clerk organization, maps them to internal UUIDs, and triggers billing-service's welcome path (welcome credit + Stripe customer). Idempotent per phone: a repeat call returns the existing identity with created=false and no side effects. The account is claimable later on the dashboard via SMS OTP to the same number.",
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
      description: "Validation result (valid=false covers unknown-slug and capped-org)",
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
  summary: "Claim an invite code for a freshly-created org (idempotent)",
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
    409: {
      description: "Invite cap reached (3 successful signups already)",
      content: { "application/json": { schema: ClaimInviteCappedResponseSchema } },
    },
    500: {
      description: "Internal server error",
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

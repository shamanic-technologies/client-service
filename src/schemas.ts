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

const UserSchema = z
  .object({
    id: z.string().uuid(),
    clerkUserId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("User");

const OrgSchema = z
  .object({
    id: z.string().uuid(),
    clerkOrgId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Org");

// --- Health ---

const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi("HealthResponse");

// --- Users ---

const UserSyncResponseSchema = z
  .object({
    user: UserSchema,
    created: z.boolean(),
  })
  .openapi("UserSyncResponse");

const UserGetResponseSchema = z
  .object({
    user: UserSchema,
  })
  .openapi("UserGetResponse");

export const ClerkUserIdParamSchema = z
  .object({
    clerkUserId: z.string(),
  })
  .openapi("ClerkUserIdParam");

// --- Orgs ---

const OrgSyncResponseSchema = z
  .object({
    org: OrgSchema,
    created: z.boolean(),
  })
  .openapi("OrgSyncResponse");

const OrgGetResponseSchema = z
  .object({
    org: OrgSchema,
  })
  .openapi("OrgGetResponse");

export const ClerkOrgIdParamSchema = z
  .object({
    clerkOrgId: z.string(),
  })
  .openapi("ClerkOrgIdParam");

// --- Anonymous Orgs ---

const AnonymousOrgSchema = z
  .object({
    id: z.string().uuid(),
    appId: z.string(),
    name: z.string(),
    clerkOrgId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("AnonymousOrg");

export const UpdateAnonymousOrgBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    clerkOrgId: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("UpdateAnonymousOrgBody");

export const AnonymousOrgIdParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .openapi("AnonymousOrgIdParam");

export const AnonymousOrgListQuerySchema = z
  .object({
    appId: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("AnonymousOrgListQuery");

const AnonymousOrgGetResponseSchema = z
  .object({
    anonymousOrg: AnonymousOrgSchema,
  })
  .openapi("AnonymousOrgGetResponse");

const AnonymousOrgListResponseSchema = z
  .object({
    anonymousOrgs: z.array(AnonymousOrgSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .openapi("AnonymousOrgListResponse");

// --- Anonymous Users ---

const AnonymousUserSchema = z
  .object({
    id: z.string().uuid(),
    appId: z.string(),
    email: z.string().email(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    phone: z.string().nullable(),
    clerkUserId: z.string().nullable(),
    clerkOrgId: z.string().nullable(),
    anonymousOrgId: z.string().uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("AnonymousUser");

export const CreateAnonymousUserBodySchema = z
  .object({
    appId: z.string().min(1),
    email: z.string().email(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    clerkUserId: z.string().optional(),
    clerkOrgId: z.string().optional(),
    anonymousOrgId: z.string().uuid().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateAnonymousUserBody");

export const UpdateAnonymousUserBodySchema = z
  .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    clerkUserId: z.string().nullable().optional(),
    clerkOrgId: z.string().nullable().optional(),
    anonymousOrgId: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("UpdateAnonymousUserBody");

export const AnonymousUserIdParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .openapi("AnonymousUserIdParam");

export const AnonymousUserListQuerySchema = z
  .object({
    appId: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("AnonymousUserListQuery");

const AnonymousUserCreateResponseSchema = z
  .object({
    anonymousUser: AnonymousUserSchema,
    anonymousOrg: AnonymousOrgSchema,
    created: z.boolean(),
  })
  .openapi("AnonymousUserCreateResponse");

const AnonymousUserGetResponseSchema = z
  .object({
    anonymousUser: AnonymousUserSchema,
  })
  .openapi("AnonymousUserGetResponse");

const AnonymousUserListResponseSchema = z
  .object({
    anonymousUsers: z.array(AnonymousUserSchema),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  })
  .openapi("AnonymousUserListResponse");

// --- Security schemes ---

registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
});

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
  method: "post",
  path: "/users/sync",
  summary: "Get or create user from Clerk ID",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "User synced",
      content: { "application/json": { schema: UserSyncResponseSchema } },
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
  path: "/users/me",
  summary: "Get current user by Clerk ID",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "User found",
      content: { "application/json": { schema: UserGetResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "User not found",
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
  path: "/users/by-clerk/{clerkUserId}",
  summary: "Get internal user ID from Clerk ID (service-to-service)",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: ClerkUserIdParamSchema,
  },
  responses: {
    200: {
      description: "User found",
      content: { "application/json": { schema: UserGetResponseSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "User not found",
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
  path: "/orgs/sync",
  summary: "Get or create org from Clerk Org ID",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Org synced",
      content: { "application/json": { schema: OrgSyncResponseSchema } },
    },
    400: {
      description: "No organization context",
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
  path: "/orgs/me",
  summary: "Get current org by Clerk Org ID",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Org found",
      content: { "application/json": { schema: OrgGetResponseSchema } },
    },
    400: {
      description: "No organization context",
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
  path: "/orgs/by-clerk/{clerkOrgId}",
  summary: "Get internal org ID from Clerk Org ID (service-to-service)",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: ClerkOrgIdParamSchema,
  },
  responses: {
    200: {
      description: "Org found",
      content: { "application/json": { schema: OrgGetResponseSchema } },
    },
    400: {
      description: "Invalid parameters",
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

// --- Anonymous Users endpoints ---

registry.registerPath({
  method: "post",
  path: "/anonymous-users",
  summary: "Create or upsert anonymous user",
  security: [{ ApiKeyAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: CreateAnonymousUserBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Anonymous user created or updated",
      content: { "application/json": { schema: AnonymousUserCreateResponseSchema } },
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
  path: "/anonymous-users",
  summary: "List anonymous users by app ID",
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: AnonymousUserListQuerySchema,
  },
  responses: {
    200: {
      description: "List of anonymous users",
      content: { "application/json": { schema: AnonymousUserListResponseSchema } },
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
  path: "/anonymous-users/{id}",
  summary: "Get anonymous user by ID",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: AnonymousUserIdParamSchema,
  },
  responses: {
    200: {
      description: "Anonymous user found",
      content: { "application/json": { schema: AnonymousUserGetResponseSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Anonymous user not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/anonymous-users/{id}",
  summary: "Update anonymous user",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: AnonymousUserIdParamSchema,
    body: {
      content: { "application/json": { schema: UpdateAnonymousUserBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Anonymous user updated",
      content: { "application/json": { schema: AnonymousUserGetResponseSchema } },
    },
    400: {
      description: "Invalid parameters or body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Anonymous user not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Anonymous Orgs endpoints ---

registry.registerPath({
  method: "get",
  path: "/anonymous-orgs",
  summary: "List anonymous orgs by app ID",
  security: [{ ApiKeyAuth: [] }],
  request: {
    query: AnonymousOrgListQuerySchema,
  },
  responses: {
    200: {
      description: "List of anonymous orgs",
      content: { "application/json": { schema: AnonymousOrgListResponseSchema } },
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
  path: "/anonymous-orgs/{id}",
  summary: "Get anonymous org by ID",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: AnonymousOrgIdParamSchema,
  },
  responses: {
    200: {
      description: "Anonymous org found",
      content: { "application/json": { schema: AnonymousOrgGetResponseSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Anonymous org not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "patch",
  path: "/anonymous-orgs/{id}",
  summary: "Update anonymous org",
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: AnonymousOrgIdParamSchema,
    body: {
      content: { "application/json": { schema: UpdateAnonymousOrgBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Anonymous org updated",
      content: { "application/json": { schema: AnonymousOrgGetResponseSchema } },
    },
    400: {
      description: "Invalid parameters or body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Anonymous org not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

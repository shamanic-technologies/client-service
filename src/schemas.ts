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

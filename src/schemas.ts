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

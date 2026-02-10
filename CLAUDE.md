# Project: client-service

User and organization management service with Clerk authentication and PostgreSQL storage.

## Commands

- `npm test` — run all tests (unit + integration)
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server with hot reload
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas
- `npm run test:unit` — run unit tests only
- `npm run test:integration` — run integration tests only
- `npm run db:generate` — generate Drizzle migration after schema change
- `npm run db:migrate` — run database migrations
- `npm run db:push` — push schema directly (dev only)

## Architecture

- `src/schemas.ts` — Zod schemas + OpenAPI registry (source of truth for validation + API docs)
- `src/routes/` — Express route handlers (`health.ts`, `users.ts`, `orgs.ts`)
- `src/middleware/auth.ts` — Clerk JWT auth (`requireAuth`) and API key auth (`requireApiKey`)
- `src/db/schema.ts` — Drizzle ORM table definitions (users, orgs)
- `src/db/index.ts` — Database connection (PostgreSQL via `postgres` driver)
- `src/instrument.ts` — Sentry initialization (must be imported first)
- `src/index.ts` — Express app setup, middleware, routes, auto-migration on startup
- `tests/` — Test files (`unit/`, `integration/`, `helpers/`)
- `openapi.json` — Auto-generated from Zod schemas, do NOT edit manually

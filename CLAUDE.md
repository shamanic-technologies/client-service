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

## Conventions / invariants

- **Identifiers: internal endpoints key on the internal org UUID (`orgs.id`), NEVER the Clerk org id.** `orgs.id` is the internal UUID used as `x-org-id` across the whole platform; `orgs.external_id` holds the Clerk org id. client-service owns this mapping — resolve `external_id` from the row when an external provider (Clerk) needs the Clerk id. A `:orgId` path param is the internal UUID (validate `z.string().uuid()`).
- **No run-tracking / cost-declaration in this service.** Unlike other backend services, client-service is the identity root and does NOT use `@distribute/runs-client` (the `requireRunId` middleware was deliberately removed — see commit `eb28567`). Do NOT add run tracking or cost declaration to its routes.
- **CI uses pnpm** (`pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build`) — `pnpm-lock.yaml` is authoritative. A `package-lock.json` is also tracked; keep it in sync when adding deps (`npm install --package-lock-only`) even though CI ignores it.
- **Cross-service calls** follow the `<SERVICE>_SERVICE_URL` / `<SERVICE>_SERVICE_API_KEY` env convention with `x-api-key` auth (e.g. `STRIPE_SERVICE_URL` + `STRIPE_SERVICE_API_KEY` for the org-teardown → stripe-service call). New external-provider/service secrets are env vars read lazily at call time (no boot-time throw), set in Railway.

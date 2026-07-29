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
- **Brand checkout status: client-service owns the (org, brand) ↔ money join, and it is DERIVED LIVE — never stored here.** `GET /internal/brands/:brandId/checkout-status` and `GET /internal/orgs/:orgId/brands/:brandId/checkout-status` (`src/lib/checkout-status.ts`) answer "has this org actually gone through checkout for this brand?". Definition, do not weaken it: CHECKED OUT = **money** (stripe-service `/internal/payment_summary/by-org/{orgId}` reports a positive gross `amount_received` — never `amount_net`: a later refund does not un-happen a checkout) **AND brand commitment** (billing-service `/internal/brands/{brandId}/daily-budget` returns a non-null `dailyBudgetCents` for that org). Stripe carries **no brand id** on any Checkout Session or PaymentIntent anywhere in the fleet, so the money leg alone cannot distinguish brands; the per-brand daily budget is the only per-brand money signal that exists, and the product writes it only in the post-payment launch step — an onboarding abandoned before paying never reaches it. A null budget stays null (billing's documented unset state) and an org with no mirrored payments stays unpaid: no default, no fallback, no local mirror. Any upstream failure is a **502**, never a defaulted "nobody paid" — a consumer must be able to tell "nobody paid" from "we could not find out".
- **Brand → org resolution uses brand-service `GET /internal/brands/all` ONLY.** It is the sole endpoint exposing the brand↔org claim edge (one row per membership; a brand claimed by N orgs yields N rows) and it is deterministic. Do NOT switch to `GET /internal/brands/{id}` or the batch `GET /internal/brands?ids=`: neither returns the owning org, and both LAZY-FILL the brand name via a platform-billed extract-fields LLM call — a status read must never trigger paid enrichment. Consequence: a brand id with zero claims returns `no_org_claims_brand`, which deliberately merges "unknown brand" with "unclaimed global brand row" (brand-service creates global brand rows without a claim). Both mean nobody can have paid on it. If brand-service ever ships a by-brand membership endpoint, swap the full-list call for it.
- **The Clerk secret comes from key-service, NEVER from this service's env.** `src/lib/clerk-client.ts` resolves it per operation via `getPlatformKey("clerk", caller)` (`src/lib/key-service-client.ts`) — there is no `CLERK_SECRET_KEY` env var and adding one back is a regression. Clerk is a shared platform secret like every other in the fleet: the dashboard app owns it in its Vercel env and registers it into key-service at startup; backends read it from there. The `x-caller-method` / `x-caller-path` each function passes are REQUIRED (key-service 400s without them) and record which of our routes depend on Clerk, so keep them accurate when adding a Clerk call. The client is memoized against the resolved secret, not cached unconditionally — a rotation must swap it rather than pin the dead key.
- **Outbound calls to Neon-backed siblings go through `fetchWithRetry`** (`src/lib/fetch-retry.ts`). Those services scale to zero; the first request after a suspend rejects with a transient connect code on `err.cause`. Only a THROWN rejection is retried (250/500/1000ms) — a completed HTTP response, 5xx included, is the service's real answer and is returned untouched.
- **CI uses pnpm** (`pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build`) — `pnpm-lock.yaml` is authoritative. A `package-lock.json` is also tracked; keep it in sync when adding deps (`npm install --package-lock-only`) even though CI ignores it.
- **Cross-service calls** follow the `<SERVICE>_SERVICE_URL` / `<SERVICE>_SERVICE_API_KEY` env convention with `x-api-key` auth (e.g. `STRIPE_SERVICE_URL` + `STRIPE_SERVICE_API_KEY` for the org-teardown → stripe-service call). New external-provider/service secrets are env vars read lazily at call time (no boot-time throw), set in Railway.
- **Migrations are HAND-WRITTEN, not `drizzle-kit generate`d.** The `drizzle/meta` snapshots are stale relative to the live schema (past columns were renamed/dropped via custom SQL — `0005_external_id_rename`, `0006_remove_appid`), so `drizzle-kit generate` drops into an interactive "is X created or renamed?" prompt and would emit a bogus full-diff migration. Instead: write `drizzle/00NN_<name>.sql` by hand (idempotent `CREATE ... IF NOT EXISTS`, `--> statement-breakpoint` between statements) and append a matching entry to `drizzle/meta/_journal.json` (incrementing `idx` + `tag`). The runtime migrator (`migrate()` in `src/index.ts`) only reads `_journal.json` + the `.sql` files — snapshot JSONs are `generate`-only, so a hand-written migration applies cleanly. Verify locally against a FRESH DB (`DROP`/`CREATE DATABASE` then `drizzle-kit migrate`) — a stale `__drizzle_migrations` table causes misleading "column does not exist" replays.
- **A new column-level invariant (unique index, NOT NULL, CHECK) can break the `migration-0006 dedup` regression test** (`tests/integration/migration-dedup.test.ts`), which reproduces the pre-0006 schema by inserting duplicate/legacy rows. It `DROP INDEX`es the constraints that didn't exist in the 0006 era in `beforeEach` (and recreates in `afterEach`) — add any NEW unique index there too, or its transient intermediate state (0006's dedup does UPDATE-keep-then-DELETE-dupes) will trip it.

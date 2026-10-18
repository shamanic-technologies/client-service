# Client Service

User and organization management service with Clerk authentication and PostgreSQL storage.

## Features

- User sync and lookup via Clerk JWT
- Organization sync and lookup via Clerk JWT
- PostgreSQL with Drizzle ORM
- Auto-migration on startup
- Sentry error tracking

## API Endpoints

### Health
- `GET /health` - Health check

### Users (requires auth)
- `POST /users/sync` - Get or create user from Clerk JWT
- `GET /users/me` - Get authenticated user
- `GET /users/by-clerk/:clerkUserId` - Lookup by Clerk ID (no auth)

### Organizations (requires auth)
- `POST /orgs/sync` - Get or create org from Clerk JWT
- `GET /orgs/me` - Get authenticated org
- `GET /orgs/by-clerk/:clerkOrgId` - Lookup by Clerk org ID (no auth)

### Internal (service-to-service, `x-api-key`)
- `DELETE /internal/orgs/:orgId` - Cascade-teardown an org (`:orgId` = internal org UUID). Calls billing-service, campaign-service, runs-service, key-service, stripe-service, Clerk, then deletes client-service data. Fail-loud per step (non-2xx with the real upstream error on any failure), idempotent re-run.
- `GET /internal/phone-accounts?phone=` - Resolve a WhatsApp number (E.164) to the account it identifies (`users.phone`, unique per number). 404 when unknown.
- `POST /internal/agent-signups/complete` with optional `whatsappPhone` - Once the emailed code proves the email, a CHANNEL-verified WhatsApp number becomes that account's identity: `GET /internal/phone-accounts` returns this user + org from then on, the previous holder (old phone-origin account or another user) stops resolving for it (its account is otherwise untouched), and the response names it in `whatsappPhoneMovedFromUserId`. Same number + same user = no-op. Never the start's unverified `phone` (that stays `contact_phone`). Without the field the completion is unchanged.

## Environment Variables

```bash
CLIENT_SERVICE_DATABASE_URL   # PostgreSQL connection string (required)
CLERK_SECRET_KEY              # Clerk SDK secret (required)
BILLING_SERVICE_URL           # billing-service base URL (required for org teardown)
BILLING_SERVICE_API_KEY       # billing-service API key (required for org teardown)
CAMPAIGN_SERVICE_URL          # campaign-service base URL (required for org teardown)
CAMPAIGN_SERVICE_API_KEY      # campaign-service API key (required for org teardown)
RUNS_SERVICE_URL              # runs-service base URL (required for org teardown)
RUNS_SERVICE_API_KEY          # runs-service API key (required for org teardown)
KEY_SERVICE_URL               # key-service base URL (required for org teardown)
KEY_SERVICE_API_KEY           # key-service API key (required for org teardown)
STRIPE_SERVICE_URL            # stripe-service base URL (required for org teardown)
STRIPE_SERVICE_API_KEY        # stripe-service API key (required for org teardown)
PORT                          # Server port (default: 3002)
SENTRY_DSN                    # Sentry error tracking (optional)
NODE_ENV                      # development|production|test
```

## Development

```bash
# Install dependencies
pnpm install

# Run development server
pnpm dev

# Run tests
pnpm test

# Build for production
pnpm build
pnpm start
```

## Database

```bash
# Generate migration after schema change
pnpm db:generate

# Run migrations
pnpm db:migrate

# Push schema directly (dev only)
pnpm db:push

# Open Drizzle Studio GUI
pnpm db:studio
```

## Docker

```bash
docker build -t client-service .
docker run -p 3002:3002 \
  -e CLIENT_SERVICE_DATABASE_URL="postgres://..." \
  -e CLERK_SECRET_KEY="sk_..." \
  client-service
```

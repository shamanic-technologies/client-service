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

## Environment Variables

```bash
CLIENT_SERVICE_DATABASE_URL   # PostgreSQL connection string (required)
CLERK_SECRET_KEY              # Clerk SDK secret (required)
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

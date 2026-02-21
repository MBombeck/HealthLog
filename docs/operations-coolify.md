# Operations — Coolify Deployment

## Overview

HealthLog is deployed as a Docker container alongside PostgreSQL (and later Redis).
It's designed to run on [Coolify](https://coolify.io/) or any Docker-based PaaS.

## Environment Variables

| Variable                  | Required | Default                 | Description                            |
| ------------------------- | -------- | ----------------------- | -------------------------------------- |
| `DATABASE_URL`            | Yes      | —                       | PostgreSQL connection string           |
| `SESSION_SECRET`          | Yes      | —                       | 64-char hex string for session signing |
| `ENCRYPTION_KEY`          | Yes      | —                       | 64-char hex string for AES-256-GCM     |
| `APP_URL`                 | Yes      | `http://localhost:3000` | Server base URL (webhooks/callbacks)   |
| `NEXT_PUBLIC_APP_URL`     | Yes      | `http://localhost:3000` | Public URL of the app                  |
| `NODE_ENV`                | No       | `production`            | Environment mode                       |
| `WITHINGS_CLIENT_ID`      | No       | —                       | Withings OAuth client ID (M5)          |
| `WITHINGS_CLIENT_SECRET`  | No       | —                       | Withings OAuth client secret (M5)      |
| `WITHINGS_REDIRECT_URI`   | No       | —                       | Withings OAuth redirect URI (M5)       |
| `WITHINGS_WEBHOOK_SECRET` | No       | —                       | Shared secret for securing webhook URL |
| `TELEGRAM_WEBHOOK_SECRET` | No       | —                       | Secret token for Telegram webhook      |

### Generating Secrets

```bash
# Generate SESSION_SECRET
openssl rand -hex 32

# Generate ENCRYPTION_KEY
openssl rand -hex 32
```

## Coolify Setup

1. **Create a new service** with Docker Compose
2. **Upload or link** the repository
3. **Set environment variables** in the Coolify dashboard
4. **Database**: Use Coolify's built-in PostgreSQL service, or the one from docker-compose
5. **Domain**: Configure your domain in Coolify's proxy settings
6. **Health check**: Coolify will use the Docker HEALTHCHECK (`/api/health`)
7. **No manual migration step needed**: each new container run applies pending Prisma migrations automatically before app start.
8. **Do not override Entrypoint/Command** in Coolify, otherwise automatic migrations on startup are skipped.

### Ready-to-use Values for `hard-healthlog.bombeck.io`

Use `docs/coolify-hard-healthlog.env.example` as template.

Minimum required values in Coolify:

```env
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://hard-healthlog.bombeck.io
APP_URL=https://hard-healthlog.bombeck.io
DATABASE_URL=postgresql://healthlog:<DB_PASSWORD>@<DB_HOST>:5432/healthlog?schema=public
SESSION_SECRET=<64-hex>
ENCRYPTION_KEY=<64-hex>
```

Generate required secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Telegram/Withings webhooks only work with a **public HTTPS domain**.
`localhost` and `http://` will fail.

## Docker Compose (local / self-hosted)

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f app

# Run migrations manually
docker compose exec app npx prisma migrate deploy

# Access database
docker compose exec db psql -U healthlog
```

## Migrations

Migrations run automatically on container startup via `docker-entrypoint.sh` (`prisma migrate deploy`).
This is the default production path for Coolify and requires no manual command execution after deployment.

Manual migration commands are only for local development or recovery:

```bash
# Create a new migration (development)
pnpm db:migrate

# Apply pending migrations (production)
pnpm db:migrate:deploy
```

## Backup & Restore

```bash
# Backup
docker compose exec db pg_dump -U healthlog healthlog > backup_$(date +%Y%m%d).sql

# Restore
docker compose exec -T db psql -U healthlog healthlog < backup_20250101.sql
```

## Health Check

```
GET /api/health

Response:
{
  "status": "ok",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "database": "connected"
}
```

Status codes: `200` = healthy, `503` = degraded (DB unreachable).

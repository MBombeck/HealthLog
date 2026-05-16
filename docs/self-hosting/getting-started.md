# Getting started — self-host HealthLog

This walkthrough takes a fresh host from `git clone` to a running
instance with a working first user. About fifteen minutes if Docker is
already installed, longer if a TLS-fronted public hostname is in scope
(see the reverse-proxy guide for that).

## Prerequisites

- **Docker 24+ with Compose v2.** The bundled `docker-compose.yml`
  pulls a multi-arch image from GitHub Container Registry (linux/amd64
  + linux/arm64), so a Raspberry Pi 5 or an x86 VPS both work
  unchanged.
- **2 GB RAM, 10 GB free disk.** The Postgres data volume grows with
  measurement history; the Apple Health import worker can briefly
  hold a 1.5 GB upload in `/tmp` while it parses.
- **Outbound HTTPS** to `ghcr.io` (image pulls) plus whichever
  integration endpoints you plan to enable (Withings, OpenAI, etc.).
- **Optional but recommended:** a reverse proxy that terminates TLS
  and forwards to `http://localhost:3000` (Caddy, Traefik, Nginx
  Proxy Manager, Coolify, or bare Nginx — see `reverse-proxy.md`).

## 1. Clone the repository

```bash
git clone https://github.com/MBombeck/HealthLog.git
cd HealthLog
cp .env.example .env
```

`.env.example` is the canonical reference for every env var the app
reads. Anything you do not uncomment falls back to a sane default or
disables the optional subsystem.

## 2. Generate the three required secrets

HealthLog needs three secrets before it will boot. Generate them with
`openssl` and append to `.env`:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"       >> .env
echo "API_TOKEN_HMAC_KEY=$(openssl rand -hex 32)"   >> .env
```

| Variable | Purpose | Rotation cost |
| -------- | ------- | ------------- |
| `POSTGRES_PASSWORD` | Bundled Postgres password — used by both the `db` service and `DATABASE_URL` | Database restart + connection-string update |
| `ENCRYPTION_KEY` | AES-256-GCM key for at-rest secrets (Withings tokens, AI provider keys, VAPID secrets) | Coordinated; see `docs/ops/encryption-key-rotation.md` |
| `API_TOKEN_HMAC_KEY` | HMAC-SHA256 key for hashing Bearer API tokens before storage | Invalidates every issued `hlk_*` token |

Then open `.env` and confirm `DATABASE_URL` includes the password you
just generated. The default template (`postgresql://healthlog:CHANGE-ME@db:5432/healthlog`)
references the literal string `CHANGE-ME`; replace it with the value
you put in `POSTGRES_PASSWORD`, or rewrite the URL to substitute
explicitly.

## 3. Bring the stack up

```bash
docker compose up -d
```

Compose starts two services:

- `db` — PostgreSQL 16 with a named volume for persistence.
- `app` — HealthLog itself, listening on `localhost:3000`. The image
  runs `prisma migrate deploy` on boot so the schema lands
  automatically; subsequent restarts no-op when the database is
  already current.

The first boot pulls the image (a few hundred megabytes) and runs
migrations. Once `docker compose logs -f app` shows the Next.js
banner, the instance is live.

## 4. Create the first user

Open `http://localhost:3000` in a browser. The registration flow asks
for a username, email, and password. **The first user that registers
is promoted to admin automatically.** Every subsequent registration
creates a regular user.

After the first user lands, you can:

- Open `/admin` to review the worker status, audit log, and any
  optional channels you want to configure (Telegram bot, ntfy, Web
  Push VAPID keys, AI fallback key).
- Open `/measurements` and add a weight or blood pressure to confirm
  the data path is wired end-to-end.

## 5. Point the instance at a public hostname

Local-only is fine for a single-user trial. For anything more — and
to unlock OAuth callbacks, webhook deliveries, and Web Push — set the
public URL pair before restarting:

```env
NEXT_PUBLIC_APP_URL="https://your-instance.example.com"
APP_URL="https://your-instance.example.com"
```

Both vars must match. `NEXT_PUBLIC_APP_URL` lands in the client bundle
at build time and drives every absolute URL the UI emits (OAuth
redirects, share links, manifest icons). `APP_URL` is the server-side
mirror used by background jobs that have no request context.

Restart the app container after editing:

```bash
docker compose up -d
```

The pre-built image reads both values at startup; no rebuild needed.

## 6. Pick a reverse-proxy

The bundled stack exposes plain HTTP on `localhost:3000`. Production
deployments terminate TLS in front of the container. The
`docs/self-hosting/reverse-proxy.md` guide carries copy-paste
configurations for Caddy, Traefik, Nginx Proxy Manager, Coolify, and
bare Nginx — including the `X-Forwarded-For` chain shape that the
rate-limiter trusts and the `TRUST_PROXY_HOPS` env var that pins how
many hops to read back.

## 7. Where to go next

| Next step | File |
| --------- | ---- |
| TLS + reverse-proxy configuration | `docs/self-hosting/reverse-proxy.md` |
| Web/worker process split for horizontal scale | `docs/self-hosting/scaling.md` |
| Off-host encrypted backups to S3/R2/B2 | `docs/ops/backup-restore.md` |
| Encryption-key rotation procedure | `docs/ops/encryption-key-rotation.md` |
| Withings device sync | `docs/integrations/withings.md` |
| Apple Health `export.zip` import | `docs/integrations/apple-health.md` |
| AI provider setup (OpenAI / Anthropic / local / ChatGPT OAuth) | `docs/integrations/ai-providers.md` |

## Troubleshooting

- **`app` container exits with a Prisma migration error.** The
  Postgres healthcheck races the migration on slow disks. Run
  `docker compose restart app` once the database has stabilised —
  migrations are idempotent.
- **First-user registration shows "registration disabled".** The
  bundled image ships with registration enabled; the toggle lives in
  `app_settings.singleton.registrationEnabled`. The admin panel can
  flip it back if a previous owner closed it.
- **Service unreachable on `localhost:3000`.** Check `docker compose
  ps` — the `app` healthcheck polls `/api/version` every 30 seconds
  and will mark the container unhealthy if Postgres is still
  starting. Tail `docker compose logs db` to confirm Postgres came up
  cleanly.
- **OAuth callbacks loop back to localhost.** Confirm `APP_URL` and
  `NEXT_PUBLIC_APP_URL` both point at the public hostname, not at
  `localhost`, and restart `app` after the change.

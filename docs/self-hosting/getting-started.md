# Getting started — self-host HealthLog

This walkthrough takes a fresh host from `git clone` to a running
instance with a working first user. About fifteen minutes if Docker is
already installed, longer if a TLS-fronted public hostname is in scope
(see the reverse-proxy guide for that).

## Prerequisites

- **Docker 24+ with Compose v2.** The bundled `docker-compose.yml`
  pulls a multi-arch image from GitHub Container Registry (linux/amd64
  - linux/arm64), so a Raspberry Pi 5 or an x86 VPS both work
    unchanged.
- **2 GB RAM, 10 GB free disk.** The Postgres data volume grows with
  measurement history; the Apple Health import worker can briefly
  hold a 1.5 GB upload in `/tmp` while it parses. The app container is
  capped at `APP_MEMORY_LIMIT`, `1536m` by default (Node then sizes its
  heap at about 792 MB). On a 2 GB host that leaves too little for
  Postgres and the system, so set `APP_MEMORY_LIMIT=1g` in `.env`
  (a heap of about 524 MB); a long-used account then runs closer to
  that heap, and the weekly backup with it.
- **Outbound HTTPS** to `ghcr.io` (image pulls) plus whichever
  integration endpoints you plan to enable (Withings, OpenAI, etc.).
  The opt-in environmental-context module additionally reaches
  `archive-api.open-meteo.com` and `geocoding-api.open-meteo.com` for
  weather and daylight; it stays off until you
  enable it and set a home location, and every outbound call goes
  through the SSRF-guarded egress wrapper.
  Three requests happen by default without anything connected: the
  HaveIBeenPwned range query when a password is set (only the first five
  characters of the password's SHA-1 are sent), a daily check of the
  GitHub releases API for the update badge, and the online IP
  geolocation lookup for login events. `PASSWORD_BREACH_CHECK_DISABLED`,
  `UPDATE_CHECK_DISABLED` and `IP_GEO_LOOKUP_DISABLED` turn each off; see
  `.env.production.example`.
- **Optional but recommended:** a reverse proxy that terminates TLS
  and forwards to `http://localhost:3000` (Caddy, Traefik, Nginx
  Proxy Manager, Coolify, or bare Nginx — see `reverse-proxy.md`).

## 1. Clone the repository

```bash
git clone https://github.com/MBombeck/HealthLog.git
cd HealthLog
cp .env.example .env
```

`.env.example` is a short starter with the variables most self-hosts
touch. The complete reference, with every variable the app reads and what
it does, is `.env.production.example`; CI checks that file against
`scripts/env-manifest.json`. Anything you do not set falls back to a sane
default or leaves the optional subsystem off.

## 2. Generate the three required secrets

HealthLog needs three secrets before it will boot. Generate them with
`openssl` and append to `.env`:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"       >> .env
echo "API_TOKEN_HMAC_KEY=$(openssl rand -hex 32)"   >> .env
```

| Variable             | Purpose                                                                                | Rotation cost                                                              |
| -------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | Bundled Postgres password — used by both the `db` service and `DATABASE_URL`           | Database restart + connection-string update                                |
| `ENCRYPTION_KEY`     | AES-256-GCM key for at-rest secrets (Withings tokens, AI provider keys, VAPID secrets) | Coordinated; see `docs/ops/encryption-key-rotation.md`                     |
| `API_TOKEN_HMAC_KEY` | HMAC-SHA256 key for hashing Bearer API tokens and web session cookies before storage   | Invalidates every issued `hlk_*` token and signs out every browser session |

You do **not** edit `DATABASE_URL` on the bundled `docker-compose.yml`
stack: compose constructs the connection string inside the `app`
service from `${POSTGRES_PASSWORD}` (its `environment:` block overrides
any `DATABASE_URL` in `.env`), so the `openssl` line above is the only
password step. `DATABASE_URL` only matters if you run a **bare Node**
process (`pnpm dev` against a host Postgres) or a **custom compose** that
does not derive it — in that case uncomment and set `DATABASE_URL`
explicitly in `.env` (see the commented example there).

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

> **Close public registration if you expose the instance to the
> internet.** Registration stays **open** after the first admin so you
> can invite the rest of your household — but on a publicly reachable
> host that means strangers can still sign up. Once everyone who needs
> an account has one, turn it off in **`/admin` → registration toggle**
> (or keep it open and hand out invite links instead). The admin
> settings show a reminder underneath the toggle while registration is
> open.

> **No email is configured out of the box** — a deliberate first-boot
> simplicity win, but it also means password reset has no self-service
> path until you set SMTP (see `docs/self-hosting/notifications.md`). If
> you are the sole admin, **save your password in a manager now**: a
> locked-out solo admin with no SMTP recovers only via the CLI script in
> `docs/ops/password-reset.md`.

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

## Build-time feature toggles

A small number of toggles are `NEXT_PUBLIC_*` variables: the framework
inlines them into the client bundle at **build time**, so the pre-built
GHCR image cannot read them at runtime. Setting them in `.env` or the
compose `environment:` block has no effect — they only take hold when
you build your own image. They are intentionally absent from the
compose runtime whitelist for that reason.

| Variable                         | Default | Effect when set                                                                                                                                                                                                                                   |
| -------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_DASHBOARD_SNAPSHOT` | on      | The dashboard hydrates every above-the-fold tile from the single `GET /api/dashboard/snapshot` cell so the whole strip shares one completion moment. Build with `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false` to fall back to the legacy four-cell path. |

To flip one, rebuild the image with the variable exported:

```bash
NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false pnpm build
# or pass it as a Dockerfile build ARG / Docker build --build-arg
```

## 7. Where to go next

| Next step                                                           | File                                  |
| ------------------------------------------------------------------- | ------------------------------------- |
| TLS + reverse-proxy configuration                                   | `docs/self-hosting/reverse-proxy.md`  |
| Tailnet-only HTTPS via `tailscale serve` (no reverse proxy)         | `docs/self-hosting/tailscale.md`      |
| Push notifications — Web Push, Telegram, ntfy, webhook, email, APNs | `docs/self-hosting/notifications.md`  |
| Web/worker process split for horizontal scale                       | `docs/self-hosting/scaling.md`        |
| Off-host encrypted backups to S3/R2/B2                              | `docs/ops/backup-restore.md`          |
| Encryption-key rotation procedure                                   | `docs/ops/encryption-key-rotation.md` |
| Withings device sync                                                | `docs/integrations/withings.md`       |
| WHOOP device sync (per-user BYO-keys)                               | `docs/integrations/whoop.md`          |
| Google Health sync — Fitbit & Pixel (per-user BYO-keys)             | `docs/integrations/google-health.md`  |
| Apple Health `export.zip` import                                    | `docs/integrations/apple-health.md`   |
| AI provider setup (OpenAI / Anthropic / local / ChatGPT OAuth)      | `docs/integrations/ai-providers.md`   |

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
ps` — the `app` healthcheck polls `/api/health` every 30 seconds
  (it returns 503 while the database or worker is down) and will mark
  the container unhealthy if Postgres is still
  starting. Tail `docker compose logs db` to confirm Postgres came up
  cleanly.
- **The login page says "Signing in cannot complete on this page".** The
  server sets its session cookie with the `Secure` flag (the production
  default) and the page was opened over plain `http://`, where the browser
  would drop it. Set `SESSION_COOKIE_SECURE=false` for a server reached only
  over HTTP on a private network, or open the `https://` address (behind a TLS
  proxy, make sure it forwards `X-Forwarded-Proto: https`). The sign-in is
  refused before any password, code or ticket is used.
- **OAuth callbacks loop back to localhost.** Confirm `APP_URL` and
  `NEXT_PUBLIC_APP_URL` both point at the public hostname, not at
  `localhost`, and restart `app` after the change.
- **An env var in `.env` seems ignored / a feature stays "off".** The
  compose `environment:` block is a **whitelist** — a variable set in
  `.env` only reaches the container if `docker-compose.yml` lists it
  under `environment:`. Vars not listed never propagate, even with
  `${VAR}` substitution at compose-up. If a setting looks configured but
  is silently dead, check the var is in that block (add it if you run a
  custom compose); the supported alternative for most secrets (VAPID,
  GitHub token, GlitchTip DSN) is the **admin panel**, which stores them
  in the database and sidesteps the whitelist entirely.
- **A new image doesn't pick up / `:latest` looks stale.** `docker-compose.yml`
  sets `pull_policy: always`, which is load-bearing: without it Docker
  re-uses the cached `:latest` digest and silently skips the registry
  round-trip on `compose up`. If you pin a custom compose, keep
  `pull_policy: always` on the `app` service, and verify the running
  build with `GET /api/version` (it returns `version` + `buildSha`).

## Back up your encryption key

`ENCRYPTION_KEY` (or the `ENCRYPTION_KEYS` map) is not stored in the database.
Without it, the encrypted parts of the database and every in-database backup
cannot be read. Keep a copy outside the server, then confirm it under Admin,
Encryption: the step shows the key id and a fingerprint (the first 12 hex
characters of SHA-256 over the key) and can check a pasted copy without
storing it. Admins see a dashboard reminder until the active key is confirmed.

| Platform  | Where the key is set                                            |
| --------- | --------------------------------------------------------------- |
| Compose   | `.env` next to `docker-compose.yml`                             |
| TrueNAS   | Apps, HealthLog, Edit, Environment                              |
| Coolify   | the application's Environment Variables                         |
| Unraid    | the container template (Docker tab, Edit) or the Compose `.env` |
| Portainer | the stack's Environment variables                               |

Set `HEALTHLOG_PLATFORM` (`compose`, `truenas`, `coolify`, `unraid`,
`portainer`) to open the step on your platform's instructions.

To compute the fingerprint of your copy:

```bash
echo -n "<your key>" | xxd -r -p | sha256sum | cut -c1-12
```

**HealthLog refuses to serve: encryption key does not match this database.**
At start the app checks that its key opens the stored data. If it does not,
every API request answers `503` with `meta.errorCode`
`encryption.key_mismatch`, `/api/health` answers `503` with
`reason: "encryption_key_mismatch"`, and background jobs are not started.
Restore the original key, point `DATABASE_URL` at the matching database, or
start with an empty database; then restart.

The check remembers the key it first saw for each key id in the table
`encryption_key_canaries`. Before it records a key, it reads the oldest
encrypted values in the database and records the key only if they open, or
if the database holds no encrypted value under that key id at all. When the
stored data proves neither (a single unreadable value, the oldest values
failing while newer ones open, or a probe that ran out of time), the app
keeps serving, records nothing, logs a warning that starts with
`[boot] Encryption key check inconclusive`, and checks again at the next
start.

If you are certain the configured key is the one your data was written
with, and the check still refuses because it recorded a different key
earlier, reset the check for that key id and restart. The refusal in the log
prints the exact statement; for the default key id it is:

```bash
docker compose exec -T db psql -U healthlog healthlog \
  -c "DELETE FROM encryption_key_canaries WHERE key_id = 'v1';"
docker compose restart app
```

The next start probes the stored data again and records the key only if
that data opens with it. Do this only when you are sure: if the key is in
fact wrong, the app serves errors on every encrypted value instead of the
one clear refusal. After a key rotation the rotation script removes the
record of a retired key id itself, once it reports that no values remain
under that id.

At a first start there is no record yet, so there is nothing to reset. If
the check refuses there and you are certain the key is right, the last
resort is `ENCRYPTION_KEY_CHECK=warn` (default `enforce`): the check still
runs and logs its full result, `/api/health` names it as
`warning: "encryption_key_mismatch"` without failing, requests are served,
and no key is recorded while the check does not pass. This disables a
safety check. With a wrong key every encrypted value fails and new rows are
written under that key, so remove the setting once the key is confirmed.

## Backup and restore

Your database is the only stateful piece — back it up, and back up the
key that decrypts it.

**Local snapshot (the common single-box case).** Dump the `db` service
with `pg_dump`:

```bash
# The bundled db service uses user `healthlog` and database `healthlog`.
docker compose exec -T db pg_dump -U healthlog healthlog \
  | gzip > healthlog-$(date +%F).sql.gz
```

Restore into a fresh database the same way:

```bash
gunzip -c healthlog-2026-01-01.sql.gz \
  | docker compose exec -T db psql -U healthlog healthlog
```

> **Back up your `ENCRYPTION_KEYS` / `ENCRYPTION_KEY` alongside the dump.**
> HealthLog encrypts sensitive columns at rest (AES-256-GCM). A database
> dump **without the encryption key is unrecoverable** — the encrypted
> data cannot be read back. Store the key (and any retired keys still in
> the rotation map) somewhere separate from the dump but equally durable.
> Losing the key means losing the encrypted data, full stop.

For off-host encrypted backups to S3/R2/B2 see
[`docs/ops/backup-restore.md`](../ops/backup-restore.md); for rotating the
encryption key safely (keep the old key until zero rows remain on it) see
[`docs/ops/encryption-key-rotation.md`](../ops/encryption-key-rotation.md).

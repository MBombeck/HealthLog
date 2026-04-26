<p align="center">
  <img src="public/logo-readme.svg" alt="HealthLog Logo" width="120" height="120" />
</p>

<h1 align="center">HealthLog</h1>

<p align="center">
  <strong>Your health data belongs to you. Track it on your own terms.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/Self--Hosted-yes-success" alt="Self-Hosted" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

<p align="center">
  A self-hosted, privacy-first health tracking PWA.<br/>
  Weight, blood pressure, mood, medications, AI insights -- all under your control.
</p>

<p align="center">
  <a href="https://healthlog.dev">Website</a> &middot;
  <a href="https://demo.healthlog.dev">Live Demo</a> &middot;
  <a href="https://docs.healthlog.dev">Documentation</a>
</p>

---

## Why HealthLog?

Most health apps lock your data behind proprietary clouds, push subscriptions, and sell your metrics to advertisers. HealthLog takes a different approach: your data stays on your server, encrypted at rest, accessible only to you.

---

## Key Features

**Health Metrics** -- Track weight, blood pressure, pulse, body fat, sleep, steps, and blood glucose (fasting/postprandial/random/bedtime, mg/dL ↔ mmol/L) with interactive trend charts, moving averages, and traffic-light ranges based on ESC/ESH 2018 and ADA 2024 guidelines.

**Custom Thresholds** -- Override the computed default ranges per metric with the targets your clinician set. Audit-logged. Doctor Report PDF prints both your target and the standard reference.

**Customizable Dashboard** -- Show, hide, and drag-to-reorder every widget. Per-user layout with reset-to-defaults.

**Mood Logging** -- 5-point scale with tags, notes, and trend analytics. Syncs automatically from moodLog.app via webhook.

**Medication Compliance** -- Flexible scheduling with time windows, recurrence patterns, intake logging (take/skip/snooze), and compliance heatmaps. External API for iOS Shortcuts integration.

**Withings Integration** -- OAuth2 device sync for scales, blood pressure monitors, and activity trackers with automatic deduplication.

**Multi-Provider AI Insights** -- Pick OpenAI, Anthropic Claude, or any local OpenAI-compatible endpoint (Ollama, LM Studio, vLLM). BYOK or admin-shared key. Cached daily. Local endpoints keep all data on your network.

**Doctor Report PDF Export** -- Generate professional medical reports client-side. Locale-aware (English/German), with vital sign summaries, BP/BMI/glucose classification, compliance rates, custom-threshold badges, and optional AI analysis.

**Built-in Feedback** -- Send bug reports and feature requests from inside the app. Stored in your HealthLog database — no GitHub config required. Optional GitHub escalation for admins.

**PWA with Offline Support** -- Installable on iOS and Android. Service worker with intelligent caching strategies for reliable offline access.

**Multi-Channel Notifications** -- Telegram (with inline action buttons), ntfy (self-hostable), and Web Push. Medication reminders with late/missed escalation.

**Gamification** -- 30+ persistent achievements across intake streaks, compliance milestones, and healthy metric streaks.

**Internationalization** -- English (default) and German UI with 1000+ translation keys. Numbers, dates, units, and AI prompts all locale-aware via `useFormatters()`. Browser-based detection with per-user override.

---

## Quick Start

Plan ~5 minutes for a working install. The bundled `docker-compose.yml` builds the app from source — pre-built images on GHCR are coming in a separate release.

```bash
git clone https://github.com/MBombeck/HealthLog.git
cd HealthLog
cp .env.example .env
```

Generate the four required secrets and paste them into `.env`:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" >> .env
echo "SESSION_SECRET=$(openssl rand -hex 32)"       >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"       >> .env
echo "API_TOKEN_HMAC_KEY=$(openssl rand -hex 32)"   >> .env
```

Then bring the stack up:

```bash
docker compose up -d
```

Open **http://localhost:3000**. The first registered user becomes admin.

> Behind a reverse proxy (Caddy / Traefik / Nginx) for TLS, set `NEXT_PUBLIC_APP_URL` and `APP_URL` to your public URL in `.env` before starting. See [Self-Hosting → Reverse Proxy](https://docs.healthlog.dev/self-hosting/reverse-proxy/) for examples.

---

## Tech Stack

| Layer         | Technology                                        |
| ------------- | ------------------------------------------------- |
| Framework     | Next.js 16 (App Router, React Server Components)  |
| Language      | TypeScript (strict mode)                          |
| Database      | PostgreSQL 16 + Prisma 7 (23 models)              |
| Job Queue     | pg-boss 12 (reminders, insights, backups)         |
| UI            | shadcn/ui, Tailwind CSS 4, Radix UI, Lucide Icons |
| Charts        | Recharts 3                                        |
| Data Fetching | TanStack Query 5                                  |
| Forms         | React Hook Form 7 + Zod 4                         |
| Auth          | SimpleWebAuthn 13, Argon2id                       |
| Notifications | Telegram Bot API, ntfy, Web Push (VAPID)          |
| PDF           | jsPDF (client-side generation)                    |
| Testing       | Vitest 4                                          |
| Deployment    | Docker (multi-stage Alpine)                       |

---

## Security and Privacy

HealthLog is designed for people who take data ownership seriously.

- **Self-hosted** -- Your data never leaves your server. No telemetry, no third-party tracking.
- **AES-256-GCM encryption** -- All stored secrets (OAuth tokens, API keys, VAPID keys) are encrypted at rest.
- **Passkey authentication** -- WebAuthn as primary auth with password fallback (Argon2id + zxcvbn strength validation).
- **Server-side sessions** -- PostgreSQL-backed with 30-day sliding expiry, HttpOnly/SameSite=Strict cookies.
- **Security headers** -- CSP with nonces, HSTS, X-Frame-Options DENY, Permissions-Policy, Referrer-Policy.
- **Rate limiting** -- Sliding window on auth and API endpoints.
- **HMAC-SHA256 API tokens** -- Bearer tokens are hashed before storage.
- **Audit logging** -- All sensitive operations tracked with IP addresses.

---

## Environment Variables

### Required

| Variable             | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | Password for the bundled Postgres service (Docker Compose)    |
| `DATABASE_URL`       | PostgreSQL connection string (uses `POSTGRES_PASSWORD` above) |
| `SESSION_SECRET`     | 64-char hex string for session signing                        |
| `ENCRYPTION_KEY`     | 64-char hex string for AES-256-GCM                            |
| `API_TOKEN_HMAC_KEY` | 64-char hex string for API token hashing                      |

### Optional

| Variable                  | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`     | Public-facing URL (default: `http://localhost:3000`) |
| `WITHINGS_CLIENT_ID`      | Withings OAuth2 client ID                            |
| `WITHINGS_CLIENT_SECRET`  | Withings OAuth2 client secret                        |
| `WITHINGS_REDIRECT_URI`   | OAuth callback URL                                   |
| `WITHINGS_WEBHOOK_SECRET` | Webhook URL hardening secret                         |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram bot webhook secret                          |

Telegram bot token, ntfy settings, Web Push VAPID keys, Umami, and GlitchTip URLs are configured in the **Admin Panel** and stored encrypted in the database.

---

## Architecture

```
src/
├── app/                    # Next.js App Router pages & API routes
│   ├── api/                # REST API endpoints (~60 route files)
│   ├── admin/              # Admin panel
│   ├── medications/        # Medication management
│   ├── measurements/       # Health metric entry
│   ├── insights/           # AI-powered analytics
│   ├── achievements/       # Gamification page
│   ├── onboarding/         # 4-step guided setup
│   └── settings/           # User preferences
├── components/
│   ├── ui/                 # shadcn/ui primitives
│   ├── layout/             # Shell (sidebar, topbar, bottom nav)
│   ├── medications/        # Medication cards, forms, timeline
│   ├── measurements/       # Measurement form, list
│   ├── mood/               # Mood form, mood list
│   └── charts/             # Recharts wrappers
├── lib/
│   ├── auth/               # Session, audit, passkey logic
│   ├── notifications/      # Dispatcher + channel senders
│   ├── jobs/               # pg-boss worker
│   ├── analytics/          # Trend calculations, compliance
│   ├── withings/           # OAuth client, sync service
│   ├── i18n/               # Translations context & config
│   ├── validations/        # Shared Zod schemas
│   ├── crypto.ts           # AES-256-GCM encrypt/decrypt
│   ├── db.ts               # Prisma singleton
│   └── doctor-report-pdf.ts # Client-side PDF generation
├── hooks/                  # React hooks
└── generated/prisma/       # Generated Prisma client
```

### Key Patterns

- **RSC by default** -- `"use client"` only for interactive components
- **API envelope** -- All responses follow `{ data, error, meta }` shape
- **Encrypted secrets** -- Withings tokens, API keys, VAPID keys, notification credentials
- **Timezone-aware** -- `Europe/Berlin` for display, UTC in database
- **Route protection** -- `proxy.ts` checks session cookie, redirects unauthenticated requests
- **Client-side PDF** -- Doctor reports generated in browser via jsPDF

---

## API Reference

All mutations require authentication via session cookie. External ingest uses Bearer tokens.

<details>
<summary><strong>Health Data</strong></summary>

| Method   | Endpoint                | Description                               |
| -------- | ----------------------- | ----------------------------------------- |
| `GET`    | `/api/measurements`     | List measurements (paginated, filterable) |
| `POST`   | `/api/measurements`     | Create measurement                        |
| `DELETE` | `/api/measurements/:id` | Delete measurement                        |
| `GET`    | `/api/analytics`        | Trend summaries (7d/30d)                  |
| `GET`    | `/api/export`           | Export as CSV or JSON                     |
| `POST`   | `/api/import`           | Import from JSON                          |
| `POST`   | `/api/doctor-report`    | Aggregated data for PDF                   |

</details>

<details>
<summary><strong>Mood</strong></summary>

| Method   | Endpoint                            | Description          |
| -------- | ----------------------------------- | -------------------- |
| `GET`    | `/api/mood-entries`                 | List mood entries    |
| `POST`   | `/api/mood-entries`                 | Create mood entry    |
| `DELETE` | `/api/mood-entries/:id`             | Delete mood entry    |
| `GET`    | `/api/mood/analytics`               | Mood trend analytics |
| `POST`   | `/api/integrations/moodlog/webhook` | moodLog.app webhook  |

</details>

<details>
<summary><strong>Medications</strong></summary>

| Method   | Endpoint                          | Description              |
| -------- | --------------------------------- | ------------------------ |
| `GET`    | `/api/medications`                | List all medications     |
| `POST`   | `/api/medications`                | Create medication        |
| `PUT`    | `/api/medications/:id`            | Update medication        |
| `DELETE` | `/api/medications/:id`            | Delete medication        |
| `POST`   | `/api/medications/:id/intake`     | Log intake event         |
| `GET`    | `/api/medications/:id/compliance` | Compliance stats         |
| `POST`   | `/api/ingest/medication`          | External intake (Bearer) |

</details>

<details>
<summary><strong>Auth and Integrations</strong></summary>

| Method | Endpoint                         | Description             |
| ------ | -------------------------------- | ----------------------- |
| `POST` | `/api/auth/register`             | Create account          |
| `POST` | `/api/auth/login`                | Password login          |
| `POST` | `/api/auth/logout`               | Destroy session         |
| `GET`  | `/api/auth/me`                   | Current user profile    |
| `POST` | `/api/auth/passkey/*`            | WebAuthn flows          |
| `GET`  | `/api/withings/connect`          | Initiate Withings OAuth |
| `POST` | `/api/insights/generate`         | Regenerate AI insights  |
| `GET`  | `/api/gamification/achievements` | Achievement progress    |
| `GET`  | `/api/health`                    | Docker health check     |

</details>

---

## Integrations

| Integration     | Setup         | Purpose                                  |
| --------------- | ------------- | ---------------------------------------- |
| **Withings**    | Env vars      | Auto-sync weight, BP, and activity       |
| **Telegram**    | Admin Panel   | Medication reminders with inline buttons |
| **ntfy**        | User Settings | Self-hosted push notifications           |
| **Web Push**    | Admin Panel   | Browser-native VAPID notifications       |
| **OpenAI**      | User Settings | AI health insights (BYOK)                |
| **moodLog.app** | User Settings | Mood tracking sync                       |
| **Umami**       | Admin Panel   | Privacy-friendly analytics               |
| **GlitchTip**   | Admin Panel   | Sentry-compatible error tracking         |

---

## Local Development

```bash
# Prerequisites: Node.js 20+, pnpm, PostgreSQL

cp .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

### Scripts

```bash
pnpm dev              # Development server
pnpm build            # Production build
pnpm lint             # ESLint
pnpm typecheck        # TypeScript strict check
pnpm test             # Vitest
pnpm format           # Prettier

pnpm db:generate      # Generate Prisma client
pnpm db:migrate       # Create & apply migration
pnpm db:migrate:deploy # Apply migrations (production)
pnpm db:studio        # Prisma Studio GUI
```

---

## Deployment

The included `docker-compose.yml` runs the app and PostgreSQL. The entrypoint automatically waits for the database, runs pending migrations, and starts the server.

The app listens on port **3000**. Place it behind Nginx, Caddy, or Traefik for TLS termination. Works out of the box with [Coolify](https://coolify.io/).

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- Code style: `pnpm format && pnpm lint`
- Type safety: `pnpm typecheck` must pass
- Tests: `pnpm test`
- UI language: English by default, German selectable per user. Code, comments, and commits: English.

---

## License

HealthLog is licensed under the [GNU Affero General Public License v3.0](LICENSE).

---

<p align="center">
  <a href="https://healthlog.dev">healthlog.dev</a> &middot;
  <a href="https://demo.healthlog.dev">Live Demo</a> &middot;
  <a href="https://docs.healthlog.dev">Docs</a>
</p>

<p align="center">
  <img src="public/logo-readme.svg" alt="HealthLog Logo" width="120" height="120" />
</p>

<h1 align="center">HealthLog</h1>

<p align="center">
  <strong>Personal health tracking with medication compliance, Withings integration, and AI-powered insights.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white" alt="Prisma 7" />
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/Theme-Dracula-bd93f9" alt="Dracula Theme" />
</p>

---

## Overview

HealthLog is a self-hosted, mobile-first health tracking app for monitoring weight, blood pressure, pulse, body fat, sleep, and activity — combined with a full medication management system including scheduling, compliance analytics, and automated reminders.

Built with a Dracula-themed dark UI, it supports passkey authentication, three notification channels (Telegram, ntfy, Web Push), Withings device sync, AI health insights via OpenAI, and a gamification system with 30 achievements.

---

## Features

### Health Metrics
- **Weight, Blood Pressure, Pulse, Body Fat, Sleep, Steps** — manual entry or automatic Withings sync
- **Trend Charts** — interactive Recharts visualizations with moving averages, linear trend lines, and target range bands
- **Traffic-Light Ranges** — personalized green/orange/red zones based on age, gender, and height (ESC/ESH 2018 guidelines for BP)
- **BMI** — auto-calculated from weight and height with WHO classification bands

### Medication Management
- **Flexible Scheduling** — time windows (e.g. 08:00–10:00), custom labels, per-window dose overrides
- **Recurrence** — daily, specific weekdays, or intervals (every 1–4 weeks)
- **Intake Logging** — take, skip, or snooze; full CRUD history per medication
- **Compliance Analytics** — 7/30-day rates, streaks, taken/skipped/missed counts, heatmap calendars
- **External API Ingest** — log intake from iOS Shortcuts or other tools via Bearer token with idempotency

### Notifications
| Channel | Features |
|---------|----------|
| **Telegram** | Bot reminders with inline buttons (Take / Skip / Snooze) |
| **ntfy** | Self-hostable push service, custom server + topic + auth |
| **Web Push** | Browser-native notifications via VAPID, service worker included |

Events: medication reminders (with late/missed escalation), measurement anomalies, low compliance alerts, sync failures.

### Withings Integration
- OAuth2 device linking with encrypted token storage (AES-256-GCM)
- Automatic + webhook-triggered sync with deduplication
- Supports scales, BP monitors, and activity trackers

### AI-Powered Insights (Optional)
- Powered by user-provided OpenAI API keys (BYOK)
- Sections: general health, blood pressure analysis, weight trends, pulse, BMI, medication compliance
- Privacy modes: aggregated (default) or raw data
- Daily caching via pg-boss to minimize API calls
- Generated in user's language

### Gamification
- 30 dynamic achievements across intake streaks, compliance milestones, healthy metric streaks, auth challenges
- Real-time unlock notifications
- Progress tracking with percentages

### Admin Panel
- User management (roles, password reset)
- Global service toggles (Telegram, ntfy, Web Push, API, registration)
- Monitoring integration (Umami analytics, GlitchTip error tracking)
- API token overview, audit log viewer, data export
- Reminder thresholds configuration

### Security
- **Passkeys** (WebAuthn) as primary auth, password fallback with Argon2id + zxcvbn strength validation
- **Server-side sessions** in PostgreSQL (30-day sliding expiry, HttpOnly/SameSite=Strict)
- **AES-256-GCM encryption** for all stored secrets (OAuth tokens, API keys)
- **HMAC-SHA256** hashed API tokens
- **Rate limiting** on auth and API endpoints
- **Audit logging** with IP tracking

### Internationalization
- Full German and English UI (1000+ translation keys)
- Browser-based locale detection with per-user override
- Admin-configurable default language

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, RSC) |
| Language | TypeScript (strict mode) |
| Database | PostgreSQL 16 + Prisma 7 ORM |
| Job Queue | pg-boss 12 (medication reminders, insight caching) |
| UI | Tailwind CSS 4, shadcn/ui, Radix UI, Lucide icons |
| Charts | Recharts 3 |
| Data Fetching | TanStack Query 5 |
| Forms | React Hook Form 7 + Zod 4 |
| Auth | SimpleWebAuthn 13, Argon2id |
| Notifications | web-push, Telegram Bot API, ntfy |
| Testing | Vitest 4 |
| Package Manager | pnpm |
| Deployment | Docker (multi-stage Alpine) |

---

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/MBombeck/HealthLog.git
cd HealthLog
cp .env.example .env
```

Generate the three required secrets:

```bash
# Linux / macOS
openssl rand -hex 32  # → SESSION_SECRET
openssl rand -hex 32  # → ENCRYPTION_KEY
openssl rand -hex 32  # → API_TOKEN_HMAC_KEY
```

Edit `.env` and set the secrets, then:

```bash
docker compose up -d
```

The app starts at **http://localhost:3000**. The first registered user automatically becomes admin.

### Local Development

```bash
# Prerequisites: Node.js 20+, pnpm, PostgreSQL

cp .env.example .env
# Edit .env with your DATABASE_URL and secrets

pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Open **http://localhost:3000**.

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | 64-char hex string for session signing |
| `ENCRYPTION_KEY` | 64-char hex string for AES-256-GCM encryption |
| `API_TOKEN_HMAC_KEY` | 64-char hex string for API token hashing |

### Optional — App

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | Public-facing URL (used in OAuth redirects) |
| `APP_URL` | `http://localhost:3000` | Internal URL |
| `NODE_ENV` | `development` | `development` or `production` |

### Optional — Withings

| Variable | Description |
|----------|-------------|
| `WITHINGS_CLIENT_ID` | OAuth2 client ID from [Withings Developer](https://developer.withings.com/) |
| `WITHINGS_CLIENT_SECRET` | OAuth2 client secret |
| `WITHINGS_REDIRECT_URI` | Callback URL (e.g. `https://your-domain/api/withings/callback`) |
| `WITHINGS_WEBHOOK_SECRET` | Random secret for webhook URL hardening |

### Optional — Notifications

| Variable | Description |
|----------|-------------|
| `TELEGRAM_WEBHOOK_SECRET` | Webhook hardening secret for Telegram bot |

> Telegram bot token, ntfy settings, Web Push VAPID keys, and monitoring URLs (Umami, GlitchTip) are configured in the **Admin Panel** and stored encrypted in the database.

---

## Architecture

```
src/
├── app/                    # Next.js App Router pages & API routes
│   ├── api/                # REST API endpoints
│   ├── admin/              # Admin panel
│   ├── medications/        # Medication management
│   ├── measurements/       # Health metric entry
│   ├── insights/           # AI-powered analytics
│   ├── settings/           # User preferences
│   └── ...
├── components/
│   ├── ui/                 # shadcn/ui primitives
│   ├── layout/             # Shell (sidebar, topbar, mobile nav)
│   ├── medications/        # Medication cards, forms, timeline
│   ├── charts/             # Recharts wrappers
│   └── monitoring/         # Umami, GlitchTip bootstrap
├── lib/
│   ├── auth/               # Session, audit, passkey logic
│   ├── notifications/      # Dispatcher + channel senders
│   ├── jobs/               # pg-boss worker (reminders, insights)
│   ├── analytics/          # Trend calculations, compliance
│   ├── withings/           # OAuth client, sync service
│   ├── i18n/               # Translations context & config
│   ├── validations/        # Shared Zod schemas
│   ├── crypto.ts           # AES-256-GCM encrypt/decrypt
│   └── db.ts               # Prisma singleton
├── hooks/                  # React hooks (useAuth)
└── generated/prisma/       # Generated Prisma client
```

### Key Patterns
- **RSC by default** — `"use client"` only for interactive components
- **API envelope** — all responses follow `{ data, error, meta }` shape
- **Encrypted secrets** — Withings tokens, API keys, notification credentials
- **Opt-out notifications** — all events enabled by default, users disable individually
- **Timezone-aware** — `Europe/Berlin` for display, UTC in database

---

## API

All mutations require authentication via session cookie. External ingest uses Bearer tokens.

<details>
<summary><strong>Health Data</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/measurements` | List measurements (paginated, filterable by type) |
| `POST` | `/api/measurements` | Create measurement |
| `DELETE` | `/api/measurements/:id` | Delete measurement |
| `GET` | `/api/analytics` | Trend summaries (7d/30d averages, slopes) |
| `GET` | `/api/export` | Export data as CSV or JSON |

</details>

<details>
<summary><strong>Medications</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/medications` | List all medications with schedules |
| `POST` | `/api/medications` | Create medication |
| `PUT` | `/api/medications/:id` | Update medication |
| `DELETE` | `/api/medications/:id` | Delete medication |
| `POST` | `/api/medications/:id/intake` | Log intake event |
| `GET` | `/api/medications/:id/compliance` | 7/30-day compliance stats |
| `POST` | `/api/ingest/medication` | External intake (Bearer auth) |

</details>

<details>
<summary><strong>Auth</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Password login |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/auth/me` | Current user profile |
| `POST` | `/api/auth/passkey/*` | WebAuthn registration/login |

</details>

<details>
<summary><strong>Notifications & Withings</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET/PUT` | `/api/notifications/preferences` | Event/channel preferences |
| `POST` | `/api/notifications/web-push` | Subscribe browser |
| `GET` | `/api/withings/connect` | Initiate Withings OAuth |
| `POST` | `/api/withings/sync` | Manual data sync |
| `GET` | `/api/health` | Docker health check |

</details>

---

## Scripts

```bash
pnpm dev                # Development server
pnpm build              # Production build
pnpm lint               # ESLint
pnpm typecheck          # TypeScript strict check
pnpm test               # Run tests (Vitest)
pnpm format             # Prettier format

pnpm db:generate        # Generate Prisma client
pnpm db:migrate         # Create & apply migration (dev)
pnpm db:migrate:deploy  # Apply migrations (production)
pnpm db:studio          # Prisma Studio GUI
```

---

## Deployment

### Docker Compose (Production)

The included `docker-compose.yml` runs the app + PostgreSQL:

```yaml
services:
  app:
    build: .
    environment:
      DATABASE_URL: "postgresql://healthlog:healthlog@db:5432/healthlog"
      SESSION_SECRET: "${SESSION_SECRET}"
      ENCRYPTION_KEY: "${ENCRYPTION_KEY}"
      API_TOKEN_HMAC_KEY: "${API_TOKEN_HMAC_KEY}"
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
```

The entrypoint script automatically:
1. Waits for PostgreSQL to be ready
2. Runs pending Prisma migrations
3. Starts the Node.js server

### Reverse Proxy

The app listens on port **3000**. Put it behind Nginx, Caddy, or Traefik for TLS termination. Works out of the box with [Coolify](https://coolify.io/).

---

## External Integrations

| Integration | Setup | Purpose |
|-------------|-------|---------|
| **Withings** | Env vars (`WITHINGS_CLIENT_*`) | Auto-sync weight, BP, and activity from Withings devices |
| **Telegram** | Admin Panel → Integrations | Medication reminders with inline action buttons |
| **ntfy** | User Settings → Notifications | Self-hosted push notifications |
| **Web Push** | Admin Panel → VAPID Keys | Browser-native push notifications |
| **OpenAI** | User Settings → AI Insights | AI-powered health analysis (user brings own key) |
| **Umami** | Admin Panel → Integrations | Privacy-friendly web analytics |
| **GlitchTip** | Admin Panel → Integrations | Error tracking and monitoring |
| **GitHub** | Admin Panel → Bug Report | User-submitted bug reports create GitHub issues |

---

## Contributing

```bash
git clone https://github.com/MBombeck/HealthLog.git
cd HealthLog
cp .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

- **Code style**: Prettier + ESLint (run `pnpm format && pnpm lint`)
- **Type safety**: `pnpm typecheck` must pass
- **Tests**: `pnpm test`
- **UI language**: German. Code, comments, and docs: English.

---

<p align="center">
  <sub>Built with Next.js, Prisma, and a lot of coffee.</sub>
</p>

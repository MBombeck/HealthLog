# AGENTS.md

Instructions for AI coding agents (OpenAI Codex, Claude Code, Cursor, etc.) working on this repository.

## Project

**HealthLog** — a personal health-tracking web app (weight, blood pressure, pulse, mood, medication compliance) with Withings integration, moodLog.app sync, Dracula-themed UI, mobile-first PWA design.

**Status**: v1.4.0 (released) → v1.4.1 in progress. v1.4.0 shipped
the UI guidelines + Skeleton/EmptyState primitives, medical-citations
consolidation, the per-route `/settings/[section]` split, the
status-first admin grid + aggregator endpoint, five new "Test
connection" buttons, AI insights with inline charts via allowlisted
metric tokens, off-host encrypted S3 backup, encryption-key
versioning + rotation CLI, optional `HEALTHLOG_PROCESS_TYPE` worker /
web split, and short-lived 24h access tokens with refresh-token
rotation for native API clients. v1.4.1 follows up with per-section
admin component extraction (the inner monolith into one file per
panel), a Postgres testcontainers integration test suite, and a
Playwright + axe-core E2E foundation. See GitHub Releases +
CHANGELOG.md for the full feature timeline.

## Tech Stack

| Layer           | Technology           | Version | Notes                                                                   |
| --------------- | -------------------- | ------- | ----------------------------------------------------------------------- |
| Framework       | Next.js (App Router) | 16      | TypeScript strict, RSC default, `"use client"` only for interactivity   |
| ORM             | Prisma               | 7.8     | Uses `PrismaPg` adapter, **not** `url` in schema — see gotchas below    |
| Database        | PostgreSQL           | 16      | Docker Compose service, port 5432, user `healthlog`                     |
| UI              | shadcn/ui (new-york) | latest  | Components in `src/components/ui/`                                      |
| Theme           | Dracula              | —       | CSS variables in `globals.css`, dark mode default, `--dracula-*` tokens |
| CSS             | Tailwind             | 4       | CSS-first config (`@import "tailwindcss"` syntax)                       |
| Data fetching   | TanStack Query       | 5       | Provider in `src/components/providers.tsx`                              |
| Validation      | Zod                  | v4      | Import as `zod/v4` (not `zod`)                                          |
| Testing         | Vitest               | latest  | Config in `vitest.config.mts`                                           |
| Package manager | pnpm                 | latest  | **Not** npm or yarn                                                     |
| Node            | 20.x                 | via nvm |                                                                         |
| Job queue       | pg-boss              | 12      | Named import `{ PgBoss }`, see gotchas                                  |
| Auth            | SimpleWebAuthn       | 13      | Passkeys primary, password fallback                                     |
| i18n            | Custom context-based | —       | `useTranslations()` hook, `messages/de.json` + `messages/en.json`       |
| PDF             | jsPDF + autotable    | latest  | Client-side doctor report generation                                    |

## Commands

```bash
# Development
pnpm dev              # Start dev server (http://localhost:3000)
pnpm build            # Production build
pnpm lint             # ESLint
pnpm format           # Prettier format
pnpm format:check     # Prettier check
pnpm typecheck        # TypeScript strict check

# Tests
pnpm test             # Run all tests (vitest)
pnpm test:watch       # Watch mode

# Database
pnpm db:generate      # Generate Prisma client
pnpm db:migrate       # Create & apply migration (dev)
pnpm db:migrate:deploy # Apply migrations (production)
pnpm db:push          # Push schema without migration (prototyping)
pnpm db:studio        # Prisma Studio GUI

# Docker
docker compose up -d          # Start app + postgres
docker compose logs -f app    # Tail app logs

# Verification (run before completing tasks)
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build
```

## File Layout

```
src/
├── app/                          # Pages and API routes (App Router)
│   ├── layout.tsx                # Root layout (viewport-fit: cover for PWA)
│   ├── page.tsx                  # Dashboard (/) with quick entry dropdown
│   ├── globals.css               # Dracula theme CSS variables
│   ├── admin/page.tsx            # Admin shell — 77 LOC, mounts the per-section components from src/components/admin/
│   ├── auth/login/page.tsx       # Login
│   ├── auth/register/page.tsx    # Registration
│   ├── achievements/page.tsx     # Gamification achievements
│   ├── bugreport/page.tsx        # Bug report → GitHub issue
│   ├── insights/page.tsx         # Health insights + correlations + AI (7 sections with sticky nav)
│   ├── measurements/page.tsx     # Measurements CRUD table
│   ├── medications/page.tsx      # Medications management
│   ├── notifications/page.tsx    # Notification preferences matrix
│   ├── onboarding/page.tsx       # 4-step guided onboarding
│   ├── settings/page.tsx         # 308-redirects /settings → /settings/account
│   ├── settings/[section]/page.tsx  # Per-section route shell (account, integrations, notifications, dashboard, ai, api, advanced, about)
│   ├── mood/page.tsx             # Mood tracking
│   ├── targets/page.tsx          # Target values dashboard
│   └── api/                      # 100+ API route files (admin, auth, measurements, medications, mood, insights, integrations, ingest, dashboard, feedback, tokens, notifications, monitoring, …)
│       ├── mood-entries/         # Mood CRUD
│       ├── import/               # JSON data import
│       ├── doctor-report/        # Doctor report data aggregation
│       ├── gamification/         # Achievements (persistent)
│       ├── integrations/moodlog/ # moodLog.app webhook + sync + status
│       └── ...
├── components/
│   ├── ui/                       # shadcn/ui primitives
│   ├── layout/                   # Shell: sidebar-nav, topbar, mobile-nav, bottom-nav
│   ├── medications/              # Medication form, card, timeline
│   ├── measurements/             # Measurement form, list
│   ├── mood/                     # Mood form, mood list
│   ├── charts/                   # Recharts wrappers, compliance charts
│   ├── insights/                 # AI insights cards (status, advisor)
│   ├── gamification/             # Achievement cards, progress
│   ├── settings/                 # Per-route Settings section components (one per /settings/[section])
│   ├── admin/                    # Per-route Admin section components (system-status, integrations, monitoring, reminders, users, audit, danger-zone, feedback)
│   └── monitoring/               # Umami, GlitchTip bootstrap
├── lib/
│   ├── db.ts                     # Prisma client singleton
│   ├── crypto.ts                 # AES-256-GCM encryption
│   ├── gravatar.ts               # Gravatar URL from email (SHA-256)
│   ├── api-response.ts           # { data, error, meta } envelope helpers
│   ├── rate-limit.ts             # In-memory sliding window rate limiter
│   ├── export.ts                 # CSV/JSON export formatting (incl. mood)
│   ├── doctor-report-pdf.ts      # Client-side PDF generation (jsPDF)
│   ├── auth/session.ts           # getSession() → { session, user } | null
│   ├── analytics/                # Trend calculations, compliance, correlations
│   ├── i18n/                     # I18n context + config
│   ├── notifications/            # Dispatcher, types, senders (telegram, ntfy, web-push)
│   ├── jobs/                     # pg-boss worker (reminders, insights, backups)
│   ├── validations/              # Zod schemas (shared between API + client)
│   ├── ai/                       # Multi-provider client (OpenAI, Anthropic, local OpenAI-compat)
│   ├── feedback/                 # In-app feedback + optional GitHub escalation
│   ├── gamification/             # Achievement definitions + progress
│   ├── insights/                 # Insight pipeline + prompts
│   ├── logging/                  # Wide Events: builder, context, sampler, transports, background
│   ├── moodlog/                  # moodLog.app webhook + sync
│   ├── monitoring/               # Umami / GlitchTip server-side hooks
│   └── withings/                 # Withings OAuth client + sync service
├── hooks/
│   └── use-auth.ts               # useAuth(), useLogout() hooks
├── generated/prisma/client/      # Generated Prisma client (DO NOT EDIT)
messages/
├── de.json                       # German translations (primary UI language)
└── en.json                       # English translations
prisma/
├── schema.prisma                 # Database schema (26 models)
└── migrations/                   # Migration files (0001–0025; latest: refresh_tokens + user_locale_drift_fix)
prisma.config.ts                  # Prisma config (DB URL lives here, NOT in schema)
public/
├── sw.js                         # Service worker (Web Push + offline caching)
├── manifest.json                 # PWA manifest
└── ...                           # Static assets
docs.healthlog.dev                # External documentation site
```

## Key Conventions

- **Default locale is English**. All code-level strings in English. UI text via i18n (`t()` calls) with German + English translations.
- **i18n**: Use `useTranslations()` hook → `t("section.key")`. Supports parameter interpolation: `t("key", { count: 5 })`. Messages in `messages/de.json` + `messages/en.json`.
- **API response format**: Always `{ data, error, meta }` via `apiSuccess(data)` / `apiError(message, status)` from `src/lib/api-response.ts`.
- **Auth check pattern**: `const session = await getSession(); if (!session) return apiError("Not authenticated", 401);`
- **Timezone**: `Europe/Berlin` for display, UTC in database.
- **Encryption**: Sensitive data (Withings tokens, API keys, VAPID private keys) encrypted with AES-256-GCM via `src/lib/crypto.ts`.
- **Dracula colors**: Use CSS variables `var(--dracula-purple)`, `var(--dracula-cyan)`, `var(--dracula-green)`, `var(--dracula-orange)`, `var(--dracula-pink)`, `var(--dracula-red)`, `var(--dracula-yellow)`, `var(--dracula-fg)`, `var(--dracula-comment)` for chart/graph elements.
- **Proxy route protection**: `src/proxy.ts` checks `healthlog_session` cookie on all non-public paths. Unauthenticated page requests → redirect `/auth/login`. API routes keep their own `getSession()` auth. Public paths defined in `PUBLIC_PATHS` array.
- **PWA safe area**: Root layout uses `viewportFit: "cover"`. Bottom-nav has `pb-[env(safe-area-inset-bottom)]`. Auth-shell uses `pb-[calc(5rem+env(safe-area-inset-bottom,0px))]`.
- **PDF generation**: Client-side via `src/lib/doctor-report-pdf.ts` using jsPDF. Data fetched from `POST /api/doctor-report`. European medical format with German terminology.
- **Data backup**: pg-boss weekly job (`data-backup` queue, Sundays 03:00), stores compressed JSON in `DataBackup` model.
- **Achievements**: Persistent in `UserAchievement` table. API at `/api/gamification/achievements` computes current state, compares with DB, persists new unlocks. `unlockedAt` timestamp is stable once set.

## Critical Gotchas

These are hard-won lessons. Ignoring them will cause errors:

### Prisma 7

- **No `url` in schema.prisma** — The database URL is configured in `prisma.config.ts`, not in the `datasource` block.
- **Import path**: `import { ... } from "@/generated/prisma/client"` (with `/client` suffix, not `@/generated/prisma`).
- **Adapter required**: PrismaClient needs `PrismaPg` adapter from `@prisma/adapter-pg`. See `src/lib/db.ts`.
- **No `earlyAccess`** in defineConfig — causes TypeScript errors.

### Next.js 16

- **Proxy, not middleware**: Next.js 16 renamed middleware to proxy. The file is `src/proxy.ts` (not `middleware.ts`). Having both causes a build error: "Both middleware file and proxy file detected".

### Libraries

- **SimpleWebAuthn v13**: No `@simplewebauthn/server/script/deps` — define Transport type inline.
- **zxcvbn-typescript**: Default export only. `zxcvbnAsync` and `zxcvbnOptions` do not exist as named exports.
- **pg-boss v12**: `{ PgBoss }` named import (not default), use `localConcurrency` (not `teamSize`), handler receives `Job<T>[]` array.
- **Zod v4**: Import from `"zod/v4"`, not `"zod"`.
- **jsPDF**: Client-side only. Import dynamically in browser context. Used with `jspdf-autotable` plugin.

### Settings & Admin (per-route layout, v1.4)

- **Settings**: 8 routes under `/settings/[section]` — `account`, `integrations`, `notifications`, `dashboard`, `ai`, `api`, `advanced`, `about`. The legacy `/settings` 308-redirects to `/settings/account`. Sidebar deep-links and the `<a href="/settings#anchor">` patterns from 1.3 still resolve via the redirect.
- **Admin**: `src/app/admin/page.tsx` is now a 77-LOC shell that mounts the per-section components in `src/components/admin/`. Status-card grid lives in `status-card-grid.tsx`. The aggregator endpoint `/api/admin/status-overview` returns the six-card summaries in one batched query.
- ESLint `react-hooks/set-state-in-effect` is **strict** now (was non-blocking when the settings monolith carried inline-effect state-setters). Use lazy `useState(() => …)` for localStorage reads, TanStack Query for data fetches.

### Insights Page

- Large file (~1750 lines), 7 content sections with AI summaries.
- Sticky horizontal chip navigation (`InsightsSectionNav` component) with IntersectionObserver for active state tracking.
- Section IDs: `general`, `bp`, `weight`, `pulse`, `mood`, `meds`, `bmi`.
- Each section has `scroll-mt-28` for header offset on scroll.

### Sidebar

- Collapsible (icons-only mode, `w-16`). State persisted in localStorage (`healthlog-sidebar-collapsed`).
- User section at bottom: Avatar (Gravatar if email, initials fallback) + username + three-dot MoreVertical menu (right side).
- Three-dot menu: Admin link, Notifications, Theme picker, Logout.
- ESLint enforces `react-hooks/set-state-in-effect` — use lazy `useState(() => ...)` for localStorage reads, NOT `useEffect` + `setState`.

### Gravatar

- `src/lib/gravatar.ts` generates Gravatar URL server-side (SHA-256 hash of email, `?d=404` fallback).
- Returned in `/api/auth/me` response as `gravatarUrl` field. Used by `AvatarImage` component with `AvatarFallback` for initials.

### Notification System

- **Channels**: `telegram`, `ntfy`, `web_push` — stored as plain `String` on `NotificationChannel.type` (no Prisma enum; the canonical list lives in `src/lib/notifications/types.ts`).
- **Event types**: `medication_reminder`, `measurement_anomaly`, `compliance_low`, `withings_sync_failed`, `system_alert` — also `String` on `NotificationPreference.eventType`. Source of truth is the discriminated union in `src/lib/notifications/types.ts`.
- **Opt-out model**: Preferences default to ON (enabled) when no `NotificationPreference` row exists.
- **Dispatcher**: `src/lib/notifications/dispatcher.ts` checks channel enabled + preference per event type.
- **Telegram**: Inline buttons (Take/Skip/Snooze 1h/Snooze 3h), pre-end window reminders (30 min before), message auto-cleanup after 24h.

### Onboarding

- 4-step guided flow: Profile → Medications → Notifications teaser → Target values.
- Optional steps 2-4 have "Skip" buttons.
- Progress indicator bar at top.
- Located at `/onboarding`, linked from proxy as public path.

## Database Models (Prisma)

26 models: `User`, `Passkey`, `Session`, `AuthChallenge`, `Measurement`, `Medication`, `MedicationSchedule`, `MedicationIntakeEvent`, `ReminderPhaseConfig`, `TelegramReminderMessage`, `TelegramScheduledDeletion`, `ApiToken`, `RefreshToken`, `WithingsConnection`, `MoodEntry`, `AppSettings`, `Feedback`, `AuditLog`, `NotificationChannel`, `NotificationPreference`, `PushSubscription`, `DataBackup`, `UserAchievement`, `RateLimit`, `Device`, `IdempotencyKey`. (`RefreshToken` added in v1.4.0 alongside the native-client 24h access-token / refresh-token rotation flow.)

## When Making Changes

1. **Read before modifying** — understand the existing code patterns.
2. **Run verification** after changes: `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build`
3. **German UI text** — all user-facing strings go through `t("key")` with translations in both `messages/de.json` and `messages/en.json`.
4. **Don't over-engineer** — keep changes focused. No speculative abstractions.
5. **Update `docs/STATUS.md`** when completing tasks.

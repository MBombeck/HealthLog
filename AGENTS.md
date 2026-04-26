# AGENTS.md

Instructions for AI coding agents (OpenAI Codex, Claude Code, Cursor, etc.) working on this repository.

## Project

**HealthLog** — a personal health-tracking web app (weight, blood pressure, pulse, mood, medication compliance) with Withings integration, moodLog.app sync, Dracula-themed UI, mobile-first PWA design.

**Status**: v1.2.0 (Custom Thresholds, Blood Glucose, Dashboard Customization, Built-in Feedback, Multi-Provider AI). See GitHub Issues for open tasks.

## Tech Stack

| Layer           | Technology           | Version | Notes                                                                   |
| --------------- | -------------------- | ------- | ----------------------------------------------------------------------- |
| Framework       | Next.js (App Router) | 16      | TypeScript strict, RSC default, `"use client"` only for interactivity   |
| ORM             | Prisma               | 7.4     | Uses `PrismaPg` adapter, **not** `url` in schema — see gotchas below    |
| Database        | PostgreSQL           | 16      | Docker Compose service, port 5432, user `healthlog`                     |
| UI              | shadcn/ui (new-york) | latest  | Components in `src/components/ui/`                                      |
| Theme           | Dracula              | —       | CSS variables in `globals.css`, dark mode default, `--dracula-*` tokens |
| CSS             | Tailwind             | 4       | CSS-first config (`@import "tailwindcss"` syntax)                       |
| Data fetching   | TanStack Query       | 5       | Provider in `src/components/providers.tsx`                              |
| Validation      | Zod                  | v4      | Import as `zod/v4` (not `zod`)                                          |
| Testing         | Vitest               | latest  | Config in `vitest.config.ts`                                            |
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
│   ├── admin/page.tsx            # Admin panel
│   ├── auth/login/page.tsx       # Login
│   ├── auth/register/page.tsx    # Registration
│   ├── achievements/page.tsx     # Gamification achievements
│   ├── bugreport/page.tsx        # Bug report → GitHub issue
│   ├── insights/page.tsx         # Health insights + correlations + AI (7 sections with sticky nav)
│   ├── measurements/page.tsx     # Measurements CRUD table
│   ├── medications/page.tsx      # Medications management
│   ├── notifications/page.tsx    # Notification preferences matrix
│   ├── onboarding/page.tsx       # 4-step guided onboarding
│   ├── settings/page.tsx         # All settings (13 sections, ~2100 lines)
│   ├── mood/page.tsx             # Mood tracking
│   ├── targets/page.tsx          # Target values dashboard
│   └── api/                      # ~60 API route files (see docs/api.md)
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
│   ├── insights/                 # AI insights card
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
│   └── withings/                 # Withings OAuth client + sync service
├── hooks/
│   └── use-auth.ts               # useAuth(), useLogout() hooks
├── generated/prisma/client/      # Generated Prisma client (DO NOT EDIT)
messages/
├── de.json                       # German translations (primary UI language)
└── en.json                       # English translations
prisma/
├── schema.prisma                 # Database schema (23 models)
└── migrations/                   # Migration files (0001–0018)
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

### Settings Page

- One large file (~2100 lines), 13 sections. Sidebar switches to "settings mode" showing section shortcuts.
- Sections scroll-to with highlight animation (`section-highlight` CSS class).
- Section IDs: `profil`, `sprache`, `sicherheit`, `telegram`, `ntfy`, `web-push`, `insights`, `withings`, `api`, `export`, `protokoll`, `daten`.

### Insights Page

- Large file (~1800+ lines), 7 content sections with AI summaries.
- Sticky horizontal chip navigation (`InsightsSectionNav` component) with IntersectionObserver for active state tracking.
- Section IDs: `general`, `bp`, `weight`, `pulse`, `mood`, `medications`, `bmi`.
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

- **Channels**: `TELEGRAM`, `NTFY`, `WEB_PUSH` (DB: `NotificationChannel`).
- **Event types**: `MEDICATION_REMINDER`, `MEASUREMENT_ANOMALY`, `COMPLIANCE_LOW`, `WITHINGS_SYNC_FAILED`, `SYSTEM_ALERT`.
- **Opt-out model**: Preferences default to ON (enabled) when no `NotificationPreference` row exists.
- **Dispatcher**: `src/lib/notifications/dispatcher.ts` checks channel enabled + preference per event type.
- **Telegram**: Inline buttons (Take/Skip/Snooze 1h/Snooze 3h), pre-end window reminders (30 min before), message auto-cleanup after 24h.

### Onboarding

- 4-step guided flow: Profile → Medications → Notifications teaser → Target values.
- Optional steps 2-4 have "Skip" buttons.
- Progress indicator bar at top.
- Located at `/onboarding`, linked from proxy as public path.

## Database Models (Prisma)

23 models: `User`, `Passkey`, `Session`, `AuthChallenge`, `Measurement`, `Medication`, `MedicationSchedule`, `MedicationIntakeEvent`, `ReminderPhaseConfig`, `TelegramReminderMessage`, `TelegramScheduledDeletion`, `ApiToken`, `WithingsConnection`, `MoodEntry`, `AppSettings`, `Feedback`, `AuditLog`, `NotificationChannel`, `NotificationPreference`, `PushSubscription`, `DataBackup`, `UserAchievement`, `RateLimit`.

## When Making Changes

1. **Read before modifying** — understand the existing code patterns.
2. **Run verification** after changes: `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build`
3. **German UI text** — all user-facing strings go through `t("key")` with translations in both `messages/de.json` and `messages/en.json`.
4. **Don't over-engineer** — keep changes focused. No speculative abstractions.
5. **Update `docs/STATUS.md`** when completing tasks.

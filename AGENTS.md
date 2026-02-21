# AGENTS.md

Instructions for AI coding agents (OpenAI Codex, Claude Code, Cursor, etc.) working on this repository.

## Project

**HealthLog** — a personal health-tracking web app (weight, blood pressure, pulse, medication compliance) with Withings integration, Dracula-themed UI, mobile-first design.

**Status**: Feature-complete through 6 milestones. Now in polish/extension phase. See `docs/STATUS.md` for open tasks.

## Tech Stack

| Layer           | Technology           | Version | Notes                                                                   |
| --------------- | -------------------- | ------- | ----------------------------------------------------------------------- |
| Framework       | Next.js (App Router) | 16      | TypeScript strict, RSC default, `"use client"` only for interactivity   |
| ORM             | Prisma               | 7.4     | Uses `PrismaPg` adapter, **not** `url` in schema — see gotchas below    |
| Database        | PostgreSQL           | 16      | Docker container `hardcore_elgamal`, port 5432, user `healthlog`        |
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
│   ├── layout.tsx                # Root layout
│   ├── page.tsx                  # Dashboard (/)
│   ├── globals.css               # Dracula theme CSS variables
│   ├── admin/page.tsx            # Admin panel
│   ├── auth/login/page.tsx       # Login
│   ├── auth/register/page.tsx    # Registration
│   ├── bugreport/page.tsx        # Bug report → GitHub issue
│   ├── charts/page.tsx           # Recharts visualizations
│   ├── insights/page.tsx         # Health insights + correlations + AI
│   ├── measurements/page.tsx     # Measurements CRUD table
│   ├── medications/page.tsx      # Medications management
│   ├── notifications/page.tsx    # Notification preferences matrix
│   ├── onboarding/page.tsx       # First-login onboarding
│   ├── settings/page.tsx         # All settings (13 sections, ~2100 lines)
│   ├── zielwerte/page.tsx        # Target values dashboard
│   └── api/                      # ~55 API route files (see docs/api.md)
├── components/
│   ├── ui/                       # shadcn/ui primitives
│   ├── layout/                   # Shell: sidebar-nav, topbar, mobile-nav
│   ├── medications/              # Medication form, card, timeline
│   ├── measurements/             # Measurement form, list
│   ├── charts/                   # Recharts wrappers, compliance charts
│   └── insights/                 # AI insights card
├── lib/
│   ├── db.ts                     # Prisma client singleton
│   ├── crypto.ts                 # AES-256-GCM encryption
│   ├── gravatar.ts               # Gravatar URL from email (SHA-256)
│   ├── api-response.ts           # { data, error, meta } envelope helpers
│   ├── rate-limit.ts             # In-memory sliding window rate limiter
│   ├── auth/session.ts           # getSession() → { session, user } | null
│   ├── analytics/                # Trend calculations, compliance
│   ├── i18n/                     # I18n context + config
│   ├── notifications/            # Dispatcher, types, senders (telegram, ntfy, web-push)
│   ├── jobs/                     # pg-boss reminder worker
│   ├── validations/              # Zod schemas (shared between API + client)
│   └── withings/                 # Withings OAuth client + sync service
├── hooks/
│   └── use-auth.ts               # useAuth(), useLogout() hooks
├── generated/prisma/client/      # Generated Prisma client (DO NOT EDIT)
messages/
├── de.json                       # German translations (primary UI language)
└── en.json                       # English translations
prisma/
├── schema.prisma                 # Database schema (15 models)
├── prisma.config.ts              # Prisma config (DB URL lives here, NOT in schema)
└── migrations/                   # Migration files
docs/
├── STATUS.md                     # Current project status + open tasks
├── architecture.md               # Architecture overview
├── security.md                   # Security documentation
├── api.md                        # API documentation
├── assumptions.md                # Design assumptions
├── operations-coolify.md         # Deployment (Coolify)
└── adr/                          # Architecture Decision Records
```

## Key Conventions

- **UI language is German**. All user-facing text in German. Code, comments, docs in English.
- **i18n**: Use `useTranslations()` hook → `t("section.key")`. Supports parameter interpolation: `t("key", { count: 5 })`. Messages in `messages/de.json` + `messages/en.json`.
- **API response format**: Always `{ data, error, meta }` via `apiSuccess(data)` / `apiError(message, status)` from `src/lib/api-response.ts`.
- **Auth check pattern**: `const session = await getSession(); if (!session) return apiError("Nicht angemeldet", 401);`
- **Timezone**: `Europe/Berlin` for display, UTC in database.
- **Encryption**: Sensitive data (Withings tokens, API keys) encrypted with AES-256-GCM via `src/lib/crypto.ts`.
- **Dracula colors**: Use CSS variables `var(--dracula-purple)`, `var(--dracula-cyan)`, `var(--dracula-green)`, `var(--dracula-orange)`, `var(--dracula-pink)`, `var(--dracula-red)`, `var(--dracula-yellow)`, `var(--dracula-fg)`, `var(--dracula-comment)` for chart/graph elements.

## Critical Gotchas

These are hard-won lessons. Ignoring them will cause errors:

### Prisma 7

- **No `url` in schema.prisma** — The database URL is configured in `prisma.config.ts`, not in the `datasource` block.
- **Import path**: `import { ... } from "@/generated/prisma/client"` (with `/client` suffix, not `@/generated/prisma`).
- **Adapter required**: PrismaClient needs `PrismaPg` adapter from `@prisma/adapter-pg`. See `src/lib/db.ts`.
- **No `earlyAccess`** in defineConfig — causes TypeScript errors.

### Libraries

- **SimpleWebAuthn v13**: No `@simplewebauthn/server/script/deps` — define Transport type inline.
- **zxcvbn-typescript**: Default export only. `zxcvbnAsync` and `zxcvbnOptions` do not exist as named exports.
- **pg-boss v12**: `{ PgBoss }` named import (not default), use `localConcurrency` (not `teamSize`), handler receives `Job<T>[]` array.
- **Zod v4**: Import from `"zod/v4"`, not `"zod"`.

### Settings Page

- One large file (~2100 lines), 13 sections. Sidebar switches to "settings mode" showing section shortcuts.
- Sections scroll-to with highlight animation (`section-highlight` CSS class).
- Section IDs: `profil`, `sprache`, `sicherheit`, `telegram`, `ntfy`, `web-push`, `insights`, `withings`, `api`, `export`, `protokoll`, `daten`.

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

## Database Models (Prisma)

15 models: `User`, `Passkey`, `Session`, `AuthChallenge`, `Measurement`, `Medication`, `MedicationSchedule`, `MedicationIntakeEvent`, `ApiToken`, `WithingsConnection`, `AppSettings`, `AuditLog`, `NotificationChannel`, `NotificationPreference`, `PushSubscription`.

## When Making Changes

1. **Read before modifying** — understand the existing code patterns.
2. **Run verification** after changes: `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build`
3. **German UI text** — all user-facing strings go through `t("key")` with translations in both `messages/de.json` and `messages/en.json`.
4. **Don't over-engineer** — keep changes focused. No speculative abstractions.
5. **Update `docs/STATUS.md`** when completing tasks.

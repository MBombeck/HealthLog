# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HealthLog — a personal health-tracking web app (weight, blood pressure, pulse, medication compliance) with Withings integration, Dracula-themed UI, mobile-first design.

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
```

## Architecture

- **Next.js 16** App Router with TypeScript strict. Pages are RSC by default; `"use client"` only for interactivity.
- **Prisma 7** ORM with PostgreSQL. Uses `PrismaPg` adapter from `@prisma/adapter-pg`. Client singleton at `src/lib/db.ts`. Generated client at `src/generated/prisma/client` (note the `/client` suffix). Prisma config in `prisma.config.ts` (not in schema.prisma).
- **shadcn/ui** components (new-york style) in `src/components/ui/`. Add new ones via `pnpm dlx shadcn@latest add <component>`.
- **Dracula theme** via CSS variables in `globals.css`. Dark mode is default. Use `--dracula-*` tokens for chart colors.
- **TanStack Query** for client-side data fetching. Provider in `src/components/providers.tsx`.
- **Zod v4** (`zod/v4`) for all input validation (API routes and forms).
- **API response envelope**: `{ data, error, meta }` via helpers in `src/lib/api-response.ts`.
- **Vitest** for unit testing. Config in `vitest.config.ts`.
- **pg-boss** (PostgreSQL-native) for job queue / medication reminders.

## Key Conventions

- UI text is **German**. Code, comments, docs are **English**.
- Timezone: `Europe/Berlin` for display, UTC in database.
- Sensitive data (Withings tokens, API keys) encrypted with AES-256-GCM (`src/lib/crypto.ts`) before DB storage.
- Passkeys are primary auth (SimpleWebAuthn v13). Sessions stored server-side in PostgreSQL.
- All API mutations require authentication. External ingest uses Bearer token (hashed with SHA-256).
- Rate limiting (in-memory sliding window) on external-facing endpoints.

## File Layout

- `src/app/` — pages and API routes (App Router)
- `src/components/ui/` — shadcn/ui primitives
- `src/components/layout/` — shell (sidebar-nav, topbar, mobile-nav)
- `src/components/medications/` — medication form, card, timeline
- `src/components/measurements/` — measurement form, list
- `src/components/charts/` — Recharts wrappers
- `src/lib/` — server utilities (db, crypto, auth, analytics, export, rate-limit, gravatar)
- `src/lib/withings/` — Withings OAuth client and sync service
- `src/lib/notifications/` — dispatcher, types, senders (telegram, ntfy, web-push)
- `src/lib/jobs/` — pg-boss reminder worker
- `src/lib/analytics/` — trend calculations, compliance, correlations
- `src/lib/i18n/` — i18n context, config, locale detection
- `src/lib/validations/` — Zod schemas shared between API + client
- `src/hooks/` — React hooks (`use-auth`)
- `messages/de.json` + `messages/en.json` — i18n translations
- `prisma/schema.prisma` — database schema (15 models)
- `prisma.config.ts` — Prisma config (DB URL here, not in schema)
- `public/sw.js` — Service worker for Web Push notifications
- `docs/` — architecture, security, assumptions, ops, API docs, ADRs
- `docs/STATUS.md` — Current project status + open tasks
- `AGENTS.md` — AI agent instructions (Codex, Cursor, etc.)

## Important Patterns

- Import Prisma client from `@/generated/prisma/client` (not `@/generated/prisma`)
- Prisma 7 does NOT support `url = env("...")` in schema.prisma — use `prisma.config.ts`
- SimpleWebAuthn v13 has no `@simplewebauthn/server/script/deps` — define Transport type inline
- `zxcvbn-typescript` uses default export only (no named `zxcvbnAsync`/`zxcvbnOptions`)
- pg-boss v12: `{ PgBoss }` named import, `localConcurrency` instead of `teamSize`, handler receives `Job<T>[]` array
- **i18n**: All UI text uses `useTranslations()` hook with `t("section.key")`. Messages in `messages/de.json` (German, primary) + `messages/en.json`
- **Notifications**: 3 channels (Telegram, ntfy, Web Push). Dispatcher at `src/lib/notifications/dispatcher.ts`. Opt-out model (all events enabled by default)
- **Gravatar**: Server-side SHA-256 hash via `src/lib/gravatar.ts`. URL returned in `/api/auth/me` response as `gravatarUrl` field
- **Sidebar**: Collapsible (localStorage-persisted). Settings mode with section shortcuts. User section at bottom with three-dot dropdown menu
- **ESLint**: Strict `react-hooks/set-state-in-effect` rule — avoid `setState` inside `useEffect`. Use lazy `useState()` initializer for localStorage reads

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HealthLog — a personal health-tracking PWA (weight, blood pressure, pulse, mood, medication compliance) with Withings integration, moodLog.app sync, Dracula-themed UI, mobile-first design, offline caching, and doctor report PDF export.

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
- **Prisma 7** ORM with PostgreSQL (23 models). Uses `PrismaPg` adapter from `@prisma/adapter-pg`. Client singleton at `src/lib/db.ts`. Generated client at `src/generated/prisma/client` (note the `/client` suffix). Prisma config in `prisma.config.ts` (not in schema.prisma).
- **shadcn/ui** components (new-york style) in `src/components/ui/`. Add new ones via `pnpm dlx shadcn@latest add <component>`.
- **Dracula theme** via CSS variables in `globals.css`. Dark mode is default. Use `--dracula-*` tokens for chart colors.
- **TanStack Query** for client-side data fetching. Provider in `src/components/providers.tsx`.
- **Zod v4** (`zod/v4`) for all input validation (API routes and forms).
- **API response envelope**: `{ data, error, meta }` via helpers in `src/lib/api-response.ts`.
- **apiHandler** wraps ALL API route handlers (`src/lib/api-handler.ts`) — error handling, Wide Event logging, x-request-id propagation.
- **Structured Logging** (Wide Events) in `src/lib/logging/` — one JSON event per request/operation via `WideEventBuilder` + `AsyncLocalStorage`. Tail sampling, stdout JSON + optional Loki Push.
- **Vitest** for unit testing. Config in `vitest.config.mts`.
- **pg-boss** (PostgreSQL-native) for job queue: medication reminders, insight caching, weekly data backups.
- **jsPDF** + jspdf-autotable for client-side doctor report PDF generation (`src/lib/doctor-report-pdf.ts`).
- **PWA offline** via service worker caching strategies in `public/sw.js` (cache-first for static, network-first for pages, network-only for API).
- **Proxy route protection** — `src/proxy.ts` checks session cookie, enforces auth on all non-public paths. Next.js 16 uses proxy.ts (not middleware.ts).

## Key Conventions

- Default locale is **English**. All code-level strings in English. UI text via i18n `t()` with German + English translations.
- Timezone: `Europe/Berlin` for display, UTC in database.
- Sensitive data (Withings tokens, API keys, VAPID private keys) encrypted with AES-256-GCM (`src/lib/crypto.ts`) before DB storage.
- Passkeys are primary auth (SimpleWebAuthn v13). Sessions stored server-side in PostgreSQL.
- All API mutations require authentication. External ingest uses Bearer token (hashed with HMAC-SHA256 keyed by `API_TOKEN_HMAC_KEY`).
- Rate limiting (in-memory sliding window) on auth and external-facing endpoints.

## File Layout

- `src/app/` — pages and API routes (App Router)
- `src/components/ui/` — shadcn/ui primitives
- `src/components/layout/` — shell (sidebar-nav, topbar, mobile-nav, bottom-nav)
- `src/components/medications/` — medication form, card, timeline
- `src/components/measurements/` — measurement form, list
- `src/components/mood/` — mood form, mood list
- `src/components/charts/` — Recharts wrappers
- `src/lib/logging/` — Wide Events structured logging (types, config, event-builder, context, sampler, transports, background)
- `src/lib/api-handler.ts` — apiHandler wrapper, requireAuth(), requireAdmin(), HttpError
- `src/lib/` — server utilities (db, crypto, auth, analytics, export, rate-limit, gravatar)
- `src/lib/export.ts` — CSV/JSON export formatting (measurements, medications, mood)
- `src/lib/doctor-report-pdf.ts` — client-side PDF generation (jsPDF, European medical format)
- `src/lib/withings/` — Withings OAuth client and sync service
- `src/lib/notifications/` — dispatcher, types, senders (telegram, ntfy, web-push)
- `src/lib/jobs/` — pg-boss reminder worker (reminders, insights, data backups)
- `src/lib/analytics/` — trend calculations, compliance, correlations
- `src/lib/i18n/` — i18n context, config, locale detection
- `src/lib/validations/` — Zod schemas shared between API + client
- `src/hooks/` — React hooks (`use-auth`)
- `messages/de.json` + `messages/en.json` — i18n translations
- `prisma/schema.prisma` — database schema (23 models)
- `prisma.config.ts` — Prisma config (DB URL here, not in schema)
- `public/sw.js` — Service worker for Web Push notifications + offline caching
- `docs/` — long-form audit notes (`docs/audit/`); end-user docs live in the separate site at https://docs.healthlog.dev
- `AGENTS.md` — AI agent instructions (Codex, Cursor, etc.)
- `CHANGELOG.md` — release notes per semver tag

## Important Patterns

- Import Prisma client from `@/generated/prisma/client` (not `@/generated/prisma`)
- Prisma 7 does NOT support `url = env("...")` in schema.prisma — use `prisma.config.ts`
- Next.js 16 uses `proxy.ts` (not `middleware.ts`) — having both causes build error
- SimpleWebAuthn v13 has no `@simplewebauthn/server/script/deps` — define Transport type inline
- `zxcvbn-typescript` uses default export only (no named `zxcvbnAsync`/`zxcvbnOptions`)
- pg-boss v12: `{ PgBoss }` named import, `localConcurrency` instead of `teamSize`, handler receives `Job<T>[]` array
- **i18n**: All UI text uses `useTranslations()` hook with `t("section.key")`. Messages in `messages/en.json` (English, default) + `messages/de.json` (German, user-selectable). Keys missing in the active locale fall back to English; missing from both surfaces the raw key — the `src/lib/__tests__/i18n*.test.ts` suite guards against that. Numbers/dates go through `useFormatters()` — never hand-roll `Intl.*` with a fixed locale.
- **Notifications**: 3 channels (Telegram, ntfy, Web Push). Dispatcher at `src/lib/notifications/dispatcher.ts`. Opt-out model (all events enabled by default)
- **Gravatar**: Server-side SHA-256 hash via `src/lib/gravatar.ts`. URL returned in `/api/auth/me` response as `gravatarUrl` field
- **Sidebar**: Collapsible (localStorage-persisted). Settings mode with section shortcuts. User section at bottom with three-dot dropdown menu
- **ESLint**: Strict `react-hooks/set-state-in-effect` rule — avoid `setState` inside `useEffect`. Use lazy `useState()` initializer for localStorage reads
- **Proxy route protection**: `src/proxy.ts` checks `healthlog_session` cookie; PUBLIC_PATHS array bypasses auth. Security headers (CSP, HSTS, X-Frame-Options) applied to all responses
- **PWA safe area**: Root layout has `viewportFit: "cover"`. Bottom-nav uses `pb-[env(safe-area-inset-bottom)]` for iOS safe area
- **Doctor report PDF**: Client-side via `src/lib/doctor-report-pdf.ts` (jsPDF). Data from `POST /api/doctor-report`. European medical format, German terminology
- **Achievements**: Persistent in `UserAchievement` table. Computed on API call, new unlocks written to DB with stable `unlockedAt` timestamps
- **Data backup**: pg-boss `data-backup` queue runs weekly (Sundays 03:00), stores JSON in `DataBackup` model
- **Wide Events / Structured Logging**: `apiHandler()` wraps all API routes. Use `annotate()` from `@/lib/logging/context` for business-action annotations. Use `requireAuth()` / `requireAdmin()` from `@/lib/api-handler` (auto-annotates auth). Background jobs use `withBackgroundEvent()`. External calls tracked via `getEvent()?.addExternalCall()`. No `console.log` in production code — use event annotations instead. Env vars: `LOG_LEVEL`, `LOG_SAMPLE_RATE`, `LOG_SLOW_THRESHOLD_MS`, `LOG_INCLUDE_STACK`, `LOKI_ENDPOINT`, `LOKI_USERNAME`, `LOKI_PASSWORD`

## Headless-Client API Patterns

The iOS app talks to bearer-protected routes while the web PWA uses cookie sessions; both share the same handlers (`requireAuth()` accepts either credential).

- **Bearer-token issuance**: `POST /api/auth/login` and `POST /api/auth/passkey/login-verify` return a `token` field for native clients. `isNativeClientRequest()` (`src/lib/auth/issue-token.ts`) opts in via `X-Client-Type: native` header **or** a `User-Agent` starting with `HealthLog-iOS/`. The raw `hlk_<64-hex>` value is returned exactly once; default lifetime 90 days, permissions `["*"]`.
- **Token storage**: API tokens are stored as **HMAC-SHA-256** hashes (`hashToken()` in `src/lib/auth/hmac.ts`, keyed by env `API_TOKEN_HMAC_KEY`) — not plain SHA-256. The keyed HMAC defends against precomputed rainbow tables if the DB leaks. Same mechanism is reused for external-ingest token verification.
- **Idempotency-Key**: `withIdempotency()` (`src/lib/idempotency.ts`) wraps POST/PUT/PATCH/DELETE handlers so retries with the same `Idempotency-Key` (regex `^[A-Za-z0-9_\-:.]{8,128}$`) for the same `(userId, method, path)` replay the original response with `X-Idempotent-Replay: true` for 24h. **NOT cached**: 401, 403, 408, 429, any 5xx, and any body containing `hlk_` (defence against caching a token-issuing response). Validation 4xx (422 etc.) **is** cached so a broken retry doesn't re-hit the DB. `userIdResolver` defaults to the cookie session — pass a 2nd argument for Bearer-only routes.
- **Device-registration cross-user-hijack guard**: `POST /api/devices` rejects re-registration of an existing APNs token under a different user with **409** (`Device token already registered to another account`) instead of silently transferring ownership. APNs tokens aren't a secret, so trusting wire input would let anyone who learns a token redirect another user's pushes. Audit trail: `device.register.denied` with reason `token_owned_by_other_user`.

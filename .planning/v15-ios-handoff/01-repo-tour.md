---
file: 01-repo-tour.md
purpose: Where everything lives — src/ layout, naming conventions, migrations, locales, tests, CI, deploy config
when_to_read: After 00-philosophy.md. Re-read whenever you need to find a file and the search-fu fails.
prerequisites: 00-philosophy.md
estimated_tokens: ~3000
version_anchor: v1.4.25 / sha 49f71c92
---

## TL;DR

Top-level is a stock Next.js 15 + Prisma + pnpm monorepo. Source lives in `src/`. Migrations live in `prisma/migrations/` and are SQL-only. Translations live in `messages/{locale}.json`. Tests split three ways: Vitest unit (`src/**/__tests__/`), Vitest integration (`tests/integration/`), Playwright e2e (`e2e/`). Planning artifacts live in `.planning/`. CI workflows live in `.github/workflows/`.

## Top-level

```
/
├── src/                        # All application code (see § src/ layout)
├── prisma/
│   ├── schema.prisma           # Single Prisma schema
│   └── migrations/             # SQL migrations 0001 → 0060 (additive, forward-only)
├── messages/                   # i18n bundles
│   ├── en.json                 # English (Marc-maintained, default)
│   ├── de.json                 # German (Marc-maintained)
│   ├── fr.json es.json it.json pl.json   # Community-maintained
│   └── (see 08-locales-i18n.md for hygiene rules)
├── scripts/
│   ├── generate-openapi.ts     # OpenAPI generation from Zod schemas
│   ├── check-openapi.ts        # Drift gate — fails CI on schema-vs-spec drift
│   ├── i18n/                   # i18n integrity helpers
│   └── restore-backup.ts
├── e2e/                        # Playwright (24 spec files at v1.4.25)
├── tests/                      # Vitest integration (testcontainers + real Postgres)
├── public/                     # Static assets, manifest.webmanifest, icons
├── docs/                       # User-facing docs site sources
├── .planning/                  # Internal working notes — not published
│   ├── v15-ios-handoff/        # ← this doc-pack lives here
│   ├── research/               # Research notes for complex features
│   ├── phase-*-report.md       # Per-feature delivery reports
│   └── codebase/               # Output of /gsd:map-codebase
├── .github/workflows/          # CI definitions
├── docker-compose.yml          # Local dev (Postgres + app)
├── Dockerfile                  # Production image (multi-stage)
├── docker-entrypoint.sh
├── package.json                # Single workspace; pnpm 10.31.0
├── prisma.config.ts
├── next.config.ts              # Next.js 16.2.6 config (turbopack)
├── tsconfig.json               # strict mode
├── vitest.config.mts           # Unit-test config (jsdom)
├── vitest.integration.config.mts  # Integration-test config (node + testcontainers)
├── playwright.config.ts
├── eslint.config.mjs           # ESLint 9 flat config
├── postcss.config.mjs          # Tailwind CSS v4
├── components.json             # shadcn/ui registry config
├── CHANGELOG.md                # Single canonical changelog
├── CONTRIBUTING.md             # External-contributor guide
├── CONTRIBUTING-AI.md          # Internal-agent guide
├── AGENTS.md                   # Per-area agent ownership map
├── README.md                   # Marketing + 30-second-read intro
└── LICENSE                     # AGPL-3.0-only
```

## src/ layout

```
src/
├── app/                        # Next.js App Router (RSC + route handlers)
│   ├── (page routes)           # /, /dashboard, /insights/*, /measurements, /medications, /settings, /admin, …
│   ├── api/                    # Route handlers — see § API layout
│   ├── layout.tsx              # Root layout (theme, providers, locale)
│   ├── globals.css             # Tailwind + Dracula tokens
│   ├── favicon.ico  robots.ts
│   ├── error.tsx               # Per-route error boundary
│   └── global-error.tsx        # Root error boundary
│
├── components/
│   ├── ui/                     # shadcn primitives (Button, Sheet, Dialog, …)
│   ├── charts/                 # Recharts wrappers (LineChart, BarChart, StackedBar, sparklines)
│   ├── dashboard/              # Dashboard tiles + grid
│   ├── insights/               # Insights mother-page + sub-pages + Coach drawer
│   ├── measurements/           # Manual-entry forms + lists
│   ├── medications/            # Med list, intake, GLP-1 specialist surfaces
│   ├── mood/                   # Mood logger + chart
│   ├── onboarding/             # Wizard primitives (OnboardingShell + per-step components)
│   ├── settings/               # 23 settings sections
│   ├── admin/                  # Admin-only screens (user list, login overview, …)
│   ├── targets/                # /insights/zielwerte
│   ├── doctor-report/          # PDF preview + per-section toggles
│   ├── gamification/           # Achievements + streaks
│   ├── monitoring/             # Wide-event viewer (admin)
│   ├── comparison/             # Comparison-overlay primitives
│   ├── layout/                 # AppShell + AuthShell + AdminShell
│   ├── i18n/                   # LocaleProvider + Trans component
│   ├── app-settings-provider.tsx
│   ├── error-details.tsx
│   └── providers.tsx           # TanStack Query + Theme + Toast providers
│
├── lib/                        # Server + isomorphic helpers
│   ├── ai/                     # AI provider chain + Coach + insights prompts (see 02-server-architecture.md)
│   ├── analytics/              # summarize(), correlations, classifications, health-score
│   ├── auth/                   # session, passkey, password, issue-token, refresh-token, audit
│   ├── coach/                  # (Note: lives under lib/ai/coach/ — see 02)
│   ├── insights/               # status writers (general/bp/weight/pulse/bmi/mood/compliance)
│   ├── jobs/                   # pg-boss workers + cron schedules (see 02)
│   ├── medications/            # GLP-1 PK helpers, drug-knowledge layer, titration
│   ├── notifications/          # dispatcher, senders (Telegram / NTFY / Web-Push / APNs)
│   ├── validations/            # Zod schemas — the single source of truth for every wire shape
│   ├── withings/               # OAuth client, sync (measure + activity + sleep v2), webhook
│   ├── i18n/                   # server-locale resolver, server-translator
│   ├── tz/                     # per-user timezone resolver + helpers
│   ├── monitoring/             # glitchtip sender
│   ├── logging/                # Wide-Event builder + context + transports
│   ├── openapi/                # Zod-to-OpenAPI generator
│   ├── api-handler.ts          # apiHandler() + requireAuth() + requireAdmin() + HttpError
│   ├── api-response.ts         # apiSuccess() + apiError() + safeJson() + getClientIp()
│   ├── db.ts                   # Prisma client singleton
│   ├── db-compat.ts            # Schema-version guard (legacy callsite)
│   ├── crypto.ts               # encrypt/decrypt (per-user secrets in the DB)
│   ├── rate-limit.ts           # checkRateLimit() + rateLimitHeaders()
│   ├── idempotency.ts          # withIdempotency() — HTTP-level retry replay
│   ├── query-keys.ts           # TanStack Query keys — never duplicate, never collide
│   ├── format.ts format-locale.ts time-window-format.ts timezone.ts
│   ├── doctor-report-*.ts      # PDF rendering
│   ├── export.ts               # CSV export
│   ├── gravatar.ts geo.ts glucose.ts
│   └── (more — see src/lib/ listing)
│
├── hooks/                      # React hooks (TanStack-Query consumers, ResizeObserver helpers, etc.)
├── generated/                  # Prisma client output (gitignored — regenerated on pnpm db:generate)
├── instrumentation.ts          # Next.js instrumentation hook — boots pg-boss worker
├── proxy.ts                    # Next.js middleware (auth redirect, onboarding-pending cookie, locale)
└── __tests__/                  # Unit tests live colocated under each module's __tests__/
```

## API layout — `src/app/api/`

| Path | Purpose |
| --- | --- |
| `admin/` | Admin-only routes |
| `ai/` | AI provider + Codex OAuth |
| `analytics/` | Trends + health-score aggregator |
| `audit-log/` | Audit-log read API |
| `auth/` | Login, logout, register, profile, refresh, passkey, codex, me/* (timezone, source-priority, doctor-report-prefs, coach-prefs, research-mode, devices) |
| `bugreport/` | User-submitted bug reports |
| `dashboard/` | summary, glp1, widgets, chart-overlay-prefs |
| `devices/` | Device list + revoke |
| `doctor-report/` | PDF generation |
| `export/` | CSV export |
| `feedback/` | AI-insight feedback (thumbs + free text) |
| `gamification/` | Achievements, streaks |
| `health/` | `/api/health` liveness probe (200 / 503) |
| `import/` | CSV + Apple Health XML import |
| `ingest/` | Generic ingest endpoints (legacy) |
| `insights/` | chat (SSE), generate, cards, comprehensive, correlations, targets, feedback, provider-chain, settings, glp1-timeline, per-status (blood-pressure / weight / pulse / mood / bmi / medication-compliance) |
| `integrations/` | Withings + Apple-Health status reconciliation |
| `internal/` | Server-internal probes |
| `measurements/` | route.ts, batch, by-external-ids, [id], series |
| `medications/` | route.ts, intake, intake-summary, [id]/* (intake, glp1, inventory, side-effects, cadence, titration, compliance, phase-config, api-endpoint) |
| `monitoring/` | Wide-event read API |
| `mood/  mood-entries/` | Mood logging |
| `notifications/` | preferences, status, vapid, web-push |
| `onboarding/` | step, complete, tour |
| `personal-records/` | PR list |
| `send/` | Generic notification dispatch (admin) |
| `settings/` | App-level settings (admin) |
| `telegram/` | Telegram bot test |
| `tokens/` | API token list + create + revoke |
| `user/` | User CRUD (admin) |
| `version/` | App version probe |
| `withings/` | connect, callback, disconnect, status, sync, credentials, webhook |
| `workouts/` | batch |

Full HTTP-verb-by-verb contract: see `03-api-contracts.md`.

## Naming conventions

| Convention | Example | Notes |
| --- | --- | --- |
| Route handlers | `src/app/api/{path}/route.ts` | Next.js App Router; one file per HTTP path, export `GET`/`POST`/`PUT`/`DELETE`/`PATCH` |
| Dynamic segments | `[id]`, `[token]`, `[step]` | Bracket-folder names; accessed via `params` argument |
| Zod schemas | `src/lib/validations/{resource}.ts` | One file per resource; `createXSchema`, `updateXSchema`, `listXSchema` |
| Prisma model | `PascalCase` in `schema.prisma` | Generated client at `src/generated/prisma/client` |
| DB column case | snake_case in DB, camelCase in code | Via Prisma `@map` |
| Migration files | `prisma/migrations/{NNNN}_{snake_case_description}/migration.sql` | Sequential numbering 0001 → 0060 at v1.4.25 |
| Test files | colocated under `__tests__/` directories | `unit.test.ts` for vitest unit, `integration.test.ts` under `tests/` |
| Translation keys | `dot.notation.lowercase` | Same key in every locale; the integrity test blocks drift |
| Audit-log actions | `resource.verb` | `measurement.create`, `auth.login.password`, `medication.intake.update` |
| Wide-Event names | same as audit-log when applicable | Annotated via `annotate({ action: { name } })` |

## Where to find…

| Need | Location |
| --- | --- |
| The list of `pnpm` commands | `package.json` § scripts |
| The list of measurement types | `src/lib/validations/measurement.ts` (Zod enum) and `prisma/schema.prisma` (`MeasurementType`) |
| The Coach system prompt | `src/lib/ai/coach/system-prompt.ts` + `src/lib/ai/prompts/safety-contracts.{locale}.yaml` |
| The Coach refusal copy | `messages/{locale}.json` under `coach.refusal.*` |
| The current PROMPT_VERSION | `src/lib/ai/prompts/insight-generator.ts` → `PROMPT_VERSION` |
| Default rate-limit values | Per-route; see the route file for the `checkRateLimit()` call |
| The cron schedule for X | `src/lib/jobs/reminder-worker.ts` § schedules table |
| Withings OAuth client | `src/lib/withings/client.ts` |
| Apple Health identifier map | `src/lib/measurements/apple-health-mapping.ts` |
| GLP-1 drug-knowledge layer | `src/lib/medications/glp1-knowledge.ts` and the EMA / EPAR references in `docs/` |
| GLP-1 PK helper | `src/lib/medications/glp1-pk.ts` |
| PR detection logic | `src/lib/jobs/pr-detection.ts` |
| Per-user timezone resolver | `src/lib/tz/resolver.ts` → `userDayKey()`, `DEFAULT_TIMEZONE` |
| Source-priority resolver | `src/lib/sources/` + `src/lib/validations/source-priority.ts` |
| The `apiHandler` + `requireAuth` helpers | `src/lib/api-handler.ts` |
| Idempotency wrapper | `src/lib/idempotency.ts` → `withIdempotency()` |
| Wide-Event annotation | `src/lib/logging/context.ts` → `annotate({ action, meta })` |
| Audit-log writer | `src/lib/auth/audit.ts` → `auditLog(action, { userId, ipAddress, details })` |

## package.json scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start Next.js dev server on http://localhost:3000 (Turbopack) |
| `pnpm build` | Production build |
| `pnpm start` | Run production build |
| `pnpm lint` | ESLint 9 flat-config |
| `pnpm typecheck` | TypeScript strict-mode no-emit |
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm test` / `pnpm test:watch` | Vitest unit suite |
| `pnpm test:integration` | Vitest integration suite (testcontainers + Postgres) |
| `pnpm e2e` / `pnpm e2e:ui` | Playwright |
| `pnpm db:generate` | Regenerate Prisma client |
| `pnpm db:push` | Push schema without a migration (dev only) |
| `pnpm db:migrate` | Create + apply a new migration |
| `pnpm db:migrate:deploy` | Apply migrations in CI / production |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm openapi:generate` | Generate `docs/openapi.yaml` from Zod schemas |
| `pnpm openapi:check` | Drift gate — fails when schema and spec diverge |

The CI one-liner (mirrors `.github/workflows/`):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build
```

## CI workflows — `.github/workflows/`

| File | Trigger | What it does |
| --- | --- | --- |
| `dependabot-auto-merge.yml` | Dependabot PR | Auto-merges minor / patch bumps after CI green |
| `docker-publish.yml` | Push tag `v*` on `main` | Builds multi-arch GHCR image (linux/amd64 on ubuntu-latest + linux/arm64 on ubuntu-24.04-arm), merges manifest |
| `e2e.yml` | PR + push | Playwright suite against ephemeral Postgres |
| `integration.yml` | PR + push | Vitest integration suite |
| `post-publish-verify.yml` | After GHCR build | Pulls the published image, runs health-check probes |
| `security.yml` | Daily + PR | npm audit, secret scanning |

## Coolify deploy config

The runtime is **Coolify** on a self-hosted server. The deploy config lives:

- **In Coolify's UI**, not in the repo — the project + environment + tag-based auto-deploy listener is configured there
- The GHCR image tag controls deploys — Coolify polls the tag and redeploys on a new digest
- Environment variables ship via Coolify's env panel (POSTGRES_PASSWORD, DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY, API_TOKEN_HMAC_KEY, plus optional AI provider keys + Withings + Apple-Health bundles)

For iOS purposes: the public URL is the production HealthLog instance; the API base URL is configurable in the app's Settings (the iOS app supports self-hosted operators, not just Marc's instance).

Detail in `02-server-architecture.md` § Coolify deploy + § Stack at a glance.

## Planning artifacts — `.planning/`

| Subdir | What it holds |
| --- | --- |
| `phase-*-report.md` | Per-feature delivery reports — read these for a feature's "why" |
| `research/` | Research notes that precede complex features |
| `codebase/` | Output of `/gsd:map-codebase` — mechanical structure reports |
| `v15-ios-handoff/` | This doc-pack |

When investigating a feature: search `.planning/` first — a report explains "why" in a way the code never can.

## STOP HERE if…

| If your task is… | …skip the rest and read… |
| --- | --- |
| "What does endpoint X return?" | `03-api-contracts.md` |
| "What does the DB look like?" | `04-data-model.md` |
| "How do I run the dev server?" | `CONTRIBUTING.md` (root) |
| "What's the deploy story?" | `02-server-architecture.md` § Coolify |

Otherwise: continue to `02-server-architecture.md`.

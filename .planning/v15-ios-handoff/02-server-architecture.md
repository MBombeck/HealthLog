---
file: 02-server-architecture.md
purpose: Backend services architecture — Next.js, Prisma, pg-boss queues, cron jobs, multi-provider AI routing, Coach / Insights module structure, Health Score, source-priority two-axis
when_to_read: After 01-repo-tour.md. Before building any backend-integrated feature.
prerequisites: 00-philosophy.md, 01-repo-tour.md
estimated_tokens: ~5000
version_anchor: v1.4.25 / sha 49f71c92
---

## TL;DR

Single Next.js 16 process serves the web UI (RSC + App Router) and the API (route handlers). A pg-boss worker boots in-process via `src/instrumentation.ts` and runs ~20 recurring crons against the same Postgres. The AI Coach and the per-status insight cards run on a multi-provider routing layer with structural fallback. Source-priority is a two-axis resolver: per-metric ladder + per-device-type override. Health Score is server-deterministic with a per-component provenance accordion.

## Stack at a glance

| Layer | Tech | Version |
| --- | --- | --- |
| Runtime | Node.js | 20+ |
| Framework | Next.js | 16.2.6 (App Router + RSC + Turbopack) |
| Language | TypeScript | strict mode |
| UI | React 19 + shadcn/ui + Tailwind v4 | — |
| Charts | Recharts | 3.8.1 |
| ORM | Prisma | 7.8.0 (pg adapter) |
| DB | PostgreSQL | 16+ |
| Queues | pg-boss | 12.18.2 (uses same Postgres) |
| Validation | Zod v4 | 4.4.3 |
| Auth — passwords | Argon2 (`@node-rs/argon2`) | 2.0.2 |
| Auth — passkeys | SimpleWebAuthn | 13.3.0 |
| Push | web-push (VAPID) + APNs (`@parse/node-apn`) | 3.6.7 / 8.1.0 |
| State | TanStack Query | 5.100.9 |
| Forms | react-hook-form + Zod resolver | 7.75.0 / 5.2.2 |
| Test — unit | Vitest 4 + jsdom | — |
| Test — integration | Vitest + testcontainers (real Postgres) | — |
| Test — e2e | Playwright | 1.59.1 |
| OpenAPI | zod-openapi | 5.4.6 — drift-checked in CI |

## Request lifecycle

```
HTTP request
   │
   ▼
src/proxy.ts (Next.js middleware)         ← auth redirect, locale cookie, hl_onboarding cookie short-circuit
   │
   ▼
src/app/api/<route>/route.ts              ← exports GET / POST / PUT / DELETE / PATCH
   │
   ▼
apiHandler(handler)                       ← src/lib/api-handler.ts
   │  ▶ start Wide-Event builder
   │  ▶ propagate x-request-id
   │  ▶ run handler inside AsyncLocalStorage
   │  ▶ catch HttpError / SyntaxError → JSON error envelope
   │  ▶ emit Wide Event on completion (sampled)
   ▼
handler body
   │  1. requireAuth() / requireAdmin()   ← cookie session OR Bearer hlk_*
   │  2. checkRateLimit(key, max, ms)
   │  3. safeJson() + Zod schema.safeParse()
   │  4. business logic (Prisma queries, optional pg-boss enqueue, external calls)
   │  5. auditLog(action, { userId, ipAddress, details })
   │  6. annotate({ action: { name }, meta })
   │  7. return apiSuccess(data, status) or apiError(message, status, { errorCode, headers })
   ▼
Response envelope: { data, error } (+ optional meta on error)
```

## Auth precedence (cookie-first)

```
1. Valid session cookie     →  cookie path (full user access; requiredPermission ignored)
2. No cookie + Bearer hlk_* →  ApiToken path (scope-gated)
3. Neither                  →  401
```

`requireAdmin()` is cookie-only — Bearer tokens never elevate. See `05-auth-flows.md` for the full token lifecycle.

## Database — Prisma + Postgres

- Single Prisma schema at `prisma/schema.prisma`
- One-way forward-only migrations under `prisma/migrations/`
- 60 migrations at v1.4.25 (migrations 0043–0060 are the v1.4.25 additions; all additive)
- Generated client emitted to `src/generated/prisma/client` (gitignored, regenerated via `pnpm db:generate`)
- `src/lib/db.ts` exports a singleton — never instantiate `PrismaClient` ad-hoc
- Cross-user safety is enforced by `userId` predicates in every query; the unique indexes (`(userId, type, source, externalId)` on `Measurement`, `(userId, source, externalId)` on `Workout`) carry NULL-distinct semantics

Detail in `04-data-model.md`.

## pg-boss — queue + scheduler

pg-boss runs in-process alongside Next.js. It uses the same Postgres for queue storage (its own schema `pgboss`), so deployment is one container, one DB.

Boot lifecycle:

```
src/instrumentation.ts
  └─ src/lib/jobs/reminder-worker.ts → startWorker()
        ├─ boss.start()
        ├─ boss.schedule(name, cron, {}, { tz: "Europe/Berlin" })   ← for every recurring queue
        └─ boss.work(name, { localConcurrency: 1 }, handler)        ← for every consumer
```

### Recurring schedules

All cron schedules use `Europe/Berlin` TZ. Source: `src/lib/jobs/reminder-worker.ts` schedules table.

| Queue | Cron | Frequency | Handler |
| --- | --- | --- | --- |
| `medication-reminder-check` | `*/15 * * * *` | Every 15 min | Reminder dispatcher — phase-config aware |
| `withings-measure-sync` | `0 * * * *` | Hourly :00 | Fallback measure sync (webhook is primary since v1.4.25) |
| `withings-activity-sync` | `0 * * * *` | Hourly :00 | Activity (steps + distance + active-energy) sync — Since v1.4.25 |
| `withings-sleep-v2-sync` | `15 * * * *` | Hourly :15 | Sleep v2 stage-level segments — Since v1.4.25 |
| `mood-log-sync` | `30 * * * *` | Hourly :30 | Mood-log secret refresh |
| `pr-detection-fallback` | `*/30 * * * *` | Every 30 min | Personal-record sweep across all users (the per-user job is enqueued on every batch ingest) — Since v1.4.25 |
| `general-status` | `0 2 * * *` | Daily 02:00 | Generate `insights.general-status.{locale}` cards |
| `blood-pressure-status` | `5 2 * * *` | Daily 02:05 | Per-status BP card |
| `weight-status` | `10 2 * * *` | Daily 02:10 | Per-status weight card |
| `pulse-status` | `15 2 * * *` | Daily 02:15 | Per-status pulse card |
| `bmi-status` | `20 2 * * *` | Daily 02:20 | Per-status BMI card |
| `medication-compliance-status` | `25 2 * * *` | Daily 02:25 | Per-status compliance card |
| `host-metric-sample` | `* * * * *` | Every minute | Host CPU / memory sample |
| `rate-limit-cleanup` | `*/5 * * * *` | Every 5 min | Drop expired rate-limit rows |
| `idempotency-cleanup` | `0 3 * * *` | Daily 03:00 | Drop expired idempotency-key rows |
| `audit-log-cleanup` | `15 3 * * *` | Daily 03:15 | Retention sweep |
| `medication-inventory-expire` | `30 3 * * *` | Daily 03:30 | Flip IN_USE pens past their 30-day clock to EXPIRED — Since v1.4.25 |
| `data-backup` | `0 3 * * 0` | Weekly Sun 03:00 | Local backup |
| `offhost-backup` | `30 2 * * *` | Daily 02:30 | S3-compatible offhost backup |
| `feedback-aggregator` | `0 4 * * *` | Daily 04:00 | Roll up AI-insight feedback into daily aggregates |

### Per-user enqueue paths (not on a cron)

| Queue | Triggered by | Purpose |
| --- | --- | --- |
| `pr-detection` (per-user) | `POST /api/measurements/batch`, `POST /api/workouts/batch` | Run PR sweep with `silent` flag for historical backfills (>50 entries) |
| `withings-activity-sync` (per-user) | Withings webhook (subscription channel) | Webhook-primary; cron is the catch-net |
| `withings-sleep-v2-sync` (per-user) | Withings webhook | Same pattern |

### Worker concurrency

Every queue uses `localConcurrency: 1` by default. The PR detection worker bumps to 5 in the per-user enqueue path (concurrent users; each user serial). Worker status is exported via `src/lib/jobs/worker-status.ts` and surfaces on `/api/health` as `worker: running | stopped`.

## Multi-provider AI routing

```
src/lib/ai/
├── provider.ts                  # resolveProvider() (legacy single-provider) + resolveProviderChain()
├── provider-chain.ts            # Per-user chain resolution (Settings → AI Provider)
├── provider-runner.ts           # runRawCompletionWithFallback() + AllProvidersFailedError
├── anthropic-client.ts          # Anthropic Messages API
├── openai-client.ts             # OpenAI Chat Completions
├── codex-client.ts              # ChatGPT (Codex) via OAuth
├── codex-oauth.ts               # Codex OAuth dance + token refresh
├── codex-slug-cache.ts          # Slug→model-name cache
├── local-client.ts              # Local LLM (Ollama / LM Studio)
├── mock-client.ts               # Test fixture
├── no-key-fallbacks.ts          # Rule-based copy when zero providers configured
├── citation-coverage.ts         # Citation-presence check
├── confidence.ts                # Confidence scoring helper
├── feedback-attribution.ts      # Per-provider feedback attribution
├── generate-insight.ts          # Top-level insight generation (used by per-status writers)
├── legacy-payload.ts            # Pre-strict-schema payload detector
├── medical-references.ts        # MDR + EMA EPAR + EMA citation library
├── provider.ts
├── schema.ts                    # Zod schema for insight payloads
├── types.ts
├── coach/
│   ├── budget.ts                # enforceBudget() + recordSpend() — daily token cap per user
│   ├── glp1-snapshot.ts         # GLP-1-aware snapshot enrichment
│   ├── keyvalues.ts             # ---KEYVALUES--- sentinel parser
│   ├── persistence.ts           # CoachConversation + CoachMessage CRUD (encrypted at rest)
│   ├── refusal.ts               # Pattern-based prompt-injection + off-topic guard
│   ├── snapshot.ts              # buildCoachSnapshot(userId, scope) → SNAPSHOT block
│   ├── system-prompt.ts         # getCoachSystemPrompt(locale, prefs) — native per-locale
│   ├── target-prompts.ts        # Per-target prompt overlays
│   ├── target-scope.ts          # Scope-resolver helpers
│   └── types.ts                 # CoachStreamEvent, CoachProvenance, CoachKeyValue
├── prompts/
│   ├── base-system.ts           # Shared safety contract
│   ├── insight-generator.ts     # PROMPT_VERSION + strict insights system prompt
│   ├── native-prompts.ts        # Native per-locale prompt bodies
│   ├── safety-contracts.{en,de,fr,es,it,pl}.yaml   ← YAML matrix per locale
│   ├── safety-contracts.ts      # YAML loader
│   ├── general-status.ts blood-pressure.ts weight.ts pulse.ts bmi.ts mood.ts medication-compliance.ts
```

### Provider chain resolution

```
resolveProviderChain(userId)
   ↓
[providerType, instance] pairs in user-priority order
   ↓
runRawCompletionWithFallback({ providers, params })
   ↓ on each attempt:
     - call provider with params
     - on 429 → record attempt, continue to next
     - on other 5xx → record attempt, continue to next
     - on success → return { result, workingProvider }
   ↓ on all fail:
     - throw AllProvidersFailedError(attempts)
```

The route reads `attempts.every(a => a.httpStatus === 429)` to distinguish provider rate-limit from generic unavailability — surfaces `coach.provider.rate_limited` vs `coach.provider.unavailable` to iOS via the SSE `error` frame.

### Daily token budget

`enforceBudget(userId)` consults `CoachUsage` (per-day token ledger). Exceeded → 429 with `coach.budget.exceeded`. iOS surfaces the daily-limit copy from `messages/{locale}.json`. Budget resets at midnight in the user's timezone.

### PROMPT_VERSION

Live constant at `src/lib/ai/prompts/insight-generator.ts` → `PROMPT_VERSION`. Currently `4.25.0`. Bumps when ANY prompt body, safety-contract YAML, or refusal copy changes. Stored on every persisted Coach message (`CoachMessage.promptVersion`) so a future regression can be attributed.

GROUND RULE 9 (no GLP-1 dose recommendations) and GROUND RULE 15 (no drug-level estimates) live in `safety-contracts.{locale}.yaml` and are mirrored verbatim in CI refusal probes.

## Coach module

Top-level flow on `POST /api/insights/chat`:

```
1. requireAuth() (cookie OR Bearer)
2. coachChatRequestSchema.safeParse()
3. enforceBudget()
4. resolveServerLocale({ request, override, userLocale })
5. detectRefusal({ message, locale })       ← pattern-based; on refuse short-circuit (no provider call)
6. fetch/create conversation
7. persist user message (encrypted)
8. parseCoachPrefs(user.coachPrefsJson)     ← defaultWindow, source toggles
9. buildCoachSnapshot(userId, effectiveScope)  ← SNAPSHOT block (metric tables + provenance windows)
10. getCoachSystemPrompt(locale, coachPrefs)   ← native per-locale; safety contract folded in
11. buildHistoryWindow(turns)               ← 20-turn cap with synthetic summary placeholder
12. runRawCompletionWithFallback({...})
13. parseKeyValuesSentinel(rawReply)         ← extract ---KEYVALUES--- block
14. persist assistant message (encrypted) + recordSpend(tokens)
15. stream SSE: token frames → provenance frame → done frame
```

The `provenance` SSE frame carries the enriched envelope:

```
{ type: "provenance", metricSource: { windows, metrics, counts?, keyValues? } }
```

`keyValues` is the parsed `---KEYVALUES---` block — load-bearing numbers the Coach drew on. iOS surfaces these in the collapsible "What is this based on?" disclosure under the assistant bubble.

Detail in `14-coach-mental-model.md`.

## Insights module

```
src/lib/insights/
├── features.ts                  # extractFeatures(userId) — every dashboard tile pulls from here
├── prompt.ts                    # buildUserPrompt({ features, comparison? }) — strict schema
├── memory.ts                    # Per-status cache lookups + writes (audit_logs row reuse)
├── correlations.ts              # pairByTimestamp + pearsonCorrelation wrappers
├── chart-tokens.ts              # Token map for chart citations
├── bucket-series.ts             # Time bucketing
├── week-iso.ts                  # ISO week math
├── sanitize.ts                  # Strip PII before sending to provider
├── sub-page-metric.ts           # Per-sub-page metric resolver
├── general-status.ts blood-pressure-status.ts weight-status.ts pulse-status.ts
├── mood-status.ts bmi-status.ts medication-compliance-status.ts
└── glp1-plateau.ts              # 4-week plateau detection (GLP-1 specific)  ← Since v1.4.25
```

Each per-status writer:

1. Reads the user's last 90 days from `Measurement` (+ mood + intake events as relevant)
2. Runs `summarize()` from `src/lib/analytics/trends.ts`
3. Builds a strict-schema prompt
4. Calls the provider chain via `generateInsight()`
5. Validates the response against `insightResultSchema`
6. Caches the result in `audit_logs` keyed on `action = "insights.{scope}-status.{locale}"`

The per-status cards (`/api/insights/cards`) compose the cached blobs into the iOS-friendly `InsightCard` DTO with `severity ∈ { alert, caution, info, good }`.

Detail in `15-insights-architecture.md`.

## Health Score

Server-deterministic four-component score with provenance:

| Component | Source | Range |
| --- | --- | --- |
| Blood pressure | BP-status classification × in-target proportion | 0–25 |
| Weight | Distance from target band × stability | 0–25 |
| Mood | 30-day average mood score | 0–25 |
| Compliance | 30-day medication intake % | 0–25 |

Total 0–100. Each component carries an `asOf` timestamp and a canonical source (`WITHINGS` / `APPLE_HEALTH` / `MANUAL`) — the provenance accordion under the score number renders these inline with `aria-labelledby` panel pairing.

Computation: `src/lib/analytics/health-score.ts` → `computeHealthScore(input)`. The input is built in `src/app/api/analytics/route.ts` (see lines ~698-720 for the canonical builder) by pulling the same last-30-day metric set the dashboard tiles consume — single source of truth for the displayed numbers vs the score.

Detail in `16-health-score-logic.md`.

## Source priority — two-axis resolver (Since v1.4.25)

Persisted as `User.sourcePriorityJson` (nullable JSONB). Null → use `DEFAULT_SOURCE_PRIORITY` verbatim.

```
{
  // Axis 1 — per-metric ladder
  metricPriority: {
    weight: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
    bp_sys: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
    steps: ["APPLE_HEALTH", "WITHINGS", "MANUAL"],
    // …
  },
  // Axis 2 — per-device-type override (within the chosen source)
  deviceTypePriority: {
    weight: ["scale", "watch", "phone"],          // Withings Body+ wins over a watch-derived weight
    bp_sys: ["band", "watch", "phone"],
    default: ["watch", "phone", "band"]
  }
}
```

The resolver `pickCanonicalSource(rows, type)`:

1. Walk `metricPriority[type]` (falling back to `DEFAULT_SOURCE_PRIORITY[type]`).
2. For each source in order, find candidate rows.
3. If multiple rows from the same source, apply `deviceTypePriority[type]` (falling back to `deviceTypePriority.default`) to tiebreak.
4. Return the surviving row; treat `deviceType = null` as `unknown` (always lowest priority).

Defaults at v1.4.25:

| Class | Default ladder |
| --- | --- |
| Cumulative (steps, distance, active-energy) | APPLE_HEALTH → WITHINGS → MANUAL |
| Sleep | APPLE_HEALTH → WITHINGS → MANUAL |
| HRV | APPLE_HEALTH → WITHINGS → MANUAL |
| Resting HR | APPLE_HEALTH → WITHINGS → MANUAL |
| Point measurements (weight, BP, pulse, body fat, …) | WITHINGS → APPLE_HEALTH → MANUAL |

iOS replicates the resolver behaviour client-side ONLY for dashboard fast-path display; the canonical resolution always happens server-side, and the iOS app pulls from `/api/dashboard/summary` for the displayed numbers.

## Logging — Wide-Event + audit-log

Two parallel logging surfaces:

| Surface | What it records | Sink |
| --- | --- | --- |
| **Wide-Event** | Per-request structured event (route, status, latency, auth method, action.name, meta) | `audit_logs` table + optional GlitchTip + sampling to a generic transport |
| **Audit-log** | Security-relevant events (login, token use, mutations, settings changes) | `audit_logs` table |

`apiHandler()` wraps every route handler so the Wide-Event builder lives inside an AsyncLocalStorage; `annotate({ action, meta })` adds fields anywhere in the handler call tree. `auditLog(action, { userId, ipAddress, details })` is fire-and-forget — never blocks the response.

## Idempotency

Header `Idempotency-Key: <opaque-string>` on POST/DELETE replays the cached response within a 24h window. Implementation: `src/lib/idempotency.ts` → `withIdempotency(handler)`. The cache key is `(userId, route, method, idempotencyKey)`.

Routes that wrap with `withIdempotency`:

| Route | Verb |
| --- | --- |
| `/api/measurements` (single + batch sub-mode) | POST |
| `/api/measurements/batch` | POST |
| `/api/workouts/batch` | POST |
| `/api/medications/[id]/intake` | POST |

Routes that intentionally do NOT (SSE streams cannot replay through the JSON-based cache):

- `/api/insights/chat` — the conversationId existence check + 20-turn cap serves the dedup contract instead.

## Rate limits

Defined per-route via `checkRateLimit(key, max, windowMs)`. The key is typically `resource:action:{userId}` for authed routes or `resource:action:{ip}` for pre-auth routes. The hardened batch endpoints (Since v1.4.25 W10):

| Route | Key | Limit |
| --- | --- | --- |
| `/api/measurements/batch` | `measurements:batch:{userId}` | 60 / min |
| `/api/workouts/batch` | `workouts:batch:{userId}` | 60 / min |
| `/api/auth/login` | `auth:login:{ip}` | 5 / 15 min |
| `/api/auth/refresh` | `auth:refresh:{ip}` | 60 / 15 min |
| `/api/auth/passkey/login-verify` | `auth:passkey-verify:{ip}` | 10 / 15 min |
| `/api/onboarding/step` | `onboarding-step:{userId}` | 30 / 10 min |
| `/api/auth/me/research-mode` (POST) | `research-mode:post:{userId}` | 5 / min |
| `/api/insights/generate` | `insights:generate:{userId}` | env-tunable, default 10 / h |

429 responses carry `X-RateLimit-*` headers via `rateLimitHeaders(rl)`.

## Notifications

```
src/lib/notifications/
├── dispatcher.ts          # Per-event-type dispatcher with channel cascade
├── retry-policy.ts        # Exponential backoff
├── channel-state.ts       # NotificationChannel CRUD
├── vapid-config.ts        # VAPID key generation + persistence
├── types.ts               # EVENT_TYPES, CHANNEL_TYPE_LABELS
└── senders/
    ├── telegram.ts        # Telegram bot
    ├── ntfy.ts            # ntfy.sh (or self-hosted ntfy)
    ├── web-push.ts        # Browser Web Push (VAPID)
    └── apns.ts            # Apple Push Notification Service (Since v1.4.23 scaffolding)
```

Channel cascade: each user has zero-to-many `NotificationChannel` rows. The dispatcher walks them in order and respects per-channel + per-event-type `NotificationPreference` toggles. Global admin toggles (`AppSettings.{telegramGlobal, ntfyGlobal, webPushGlobal}`) act as hard stops.

For iOS — the APNs sender wires into the existing dispatcher, so the same `eventType` (`PERSONAL_RECORD_ACHIEVED`, `MEDICATION_REMINDER`, `INSIGHT_READY`) reaches the device through the registered APNs token. iOS registers via the `devices/` endpoint family — detail in `05-auth-flows.md`.

## Withings integration

```
src/lib/withings/
├── client.ts              # OAuth code-exchange, refresh, getAuthorizationUrl, hasActivityScope
├── credentials.ts         # Per-user Client ID/Secret (encrypted in DB)
├── sync.ts                # Measure sync (BP, weight, body composition, temperature, …)
├── sync-activity.ts       # Activity sync (steps + distance + active-energy) — Since v1.4.25
├── sync-sleep.ts          # Sleep v2 stage-level segments — Since v1.4.25
├── webhook-handler.ts     # POST /api/withings/webhook handler
└── mapping.md             # Withings measure type → Measurement enum mapping (human-readable)
```

Webhook subscription channels (Since v1.4.25):

| Channel | Event type |
| --- | --- |
| 1 | New measure (weight, BP, pulse, body composition) |
| 2 | New activity (steps + distance + calories) |
| 3 | Activity activity update |
| 4 | New sleep segment (sleep v2) |
| 16 | New temperature reading |
| 50 | Auth revoked |

OAuth scope upgrade banner: when `WithingsConnection.scope` is null (legacy v1.4.24 connection) or doesn't include `user.activity`, the Settings → Integrations card surfaces a reconnect banner. iOS surfaces the same banner; on tap, opens the Withings OAuth URL in `SFSafariViewController`.

Detail in `02-server-architecture.md` § Withings integration above + `08-locked-contracts.md` § 8 (webhook path-segment secret).

## Apple Health bridge

```
src/lib/measurements/apple-health-mapping.ts
```

Server-side identifier map (ported from `k0rventen/apple-health-grafana` + `dogsheep/healthkit-to-sqlite` with MIT + Apache-2.0 attribution recorded in source headers and `NOTICE`). Covers the v1.4.25 ingest surface; iOS-18 long-tail mappings (sleep apnea, GAD-7, paddle/row sports, FHIR clinical) carry inline release-window comments.

```
mapAppleHealthEntry({ hkIdentifier, value, unit, startDate, endDate, sleepStage? })
   → { type, value, unit, takenAt, sleepStage? } | null
```

Returns `null` when the identifier is unknown — the batch endpoint surfaces that as a per-entry `skipped` with `reason: "unmappable_identifier"`. iOS does not need to lock its identifier set to the server's — unknown identifiers degrade gracefully.

## Onboarding wizard (Since v1.4.25)

| Step | Persisted | Endpoint |
| --- | --- | --- |
| 0 | Welcome (server-rendered) | — |
| 1 | Goals chip-picker | `POST /api/onboarding/step { step: 1 }` |
| 2 | Source selection 4-card grid | `POST /api/onboarding/step { step: 2 }` |
| 3 | Baseline form (height / DOB / gender) | `POST /api/onboarding/step { step: 3 }` |
| 4 | Source-connect step + Done — flips `onboardingCompletedAt` | `POST /api/onboarding/step { step: 4 }` |

State machine guards:

- Step out-of-order → 409
- Already-completed user → 409
- Concurrent advance (read-then-write race) → 409 via `updateMany` with conditional WHERE

Detail in `02-server-architecture.md` § Onboarding wizard above + `.planning/research/w14b-onboarding-rebuild.md` for the design rationale.

## Personal Records (Since v1.4.25)

| Component | Location |
| --- | --- |
| Schema | `PersonalRecord` table (Migration 0054) |
| Detector | `src/lib/jobs/pr-detection.ts` — MAX / MIN per metric + workout slots |
| Trigger | Per-user enqueue on batch ingest; 30-min fallback cron |
| Warm-up gate | First datapoint per metric does NOT promote itself |
| Silent flag | Historical backfills (>50 entries) suppress push |
| Push opt-in | Per-user toggle (default off) |
| Trend tile badge | Renders when record landed in last 30 days; WCAG-AA contrast |

Detail in `07-server-responsibilities.md` § Domain 4 (PR detection) + `.planning/research/w16c-pr-detection.md` for the design rationale.

## Per-user timezone (Since v1.4.25)

`User.timezone` column (Migration 0043, default `Europe/Berlin`). Threaded through ten surfaces:

- CSV exporter — ISO-8601 with offset
- Formatters (`src/lib/format-locale.ts`, `src/lib/time-window-format.ts`)
- Profile picker — covers all IANA zones
- Admin sets the default for new accounts
- Signup detects browser tz
- Doctor-report PDF
- Chart x-axes — `timezone` prop on every chart wrapper
- Coach snapshot timestamps
- `MoodEntry.tz` records local-day grouping (Migration 0044)
- Weight-weekday correlator

`src/lib/tz/resolver.ts`:

```
userDayKey(date, tz)           // → "YYYY-MM-DD" in tz
DEFAULT_TIMEZONE = "Europe/Berlin"
isValidTimezone(tz)            // → boolean (runtime Intl.DateTimeFormat probe)
invalidateUserTimezone(userId) // → cache evict
```

iOS reads `user.timezone` from `/api/auth/me` and uses it as the canonical display tz. Server is the source of truth; iOS never overrides without writing back via `PUT /api/auth/me/timezone`.

## STOP HERE if…

| If your task is… | …skip the rest and read… |
| --- | --- |
| "How do I call endpoint X?" | `03-api-contracts.md` |
| "How does the Coach really work?" | `14-coach-mental-model.md` |
| "How do I wire the AI providers?" | `14-coach-mental-model.md` § Provider routing |
| "How does Withings sync?" | `02-server-architecture.md` § Withings integration |

Otherwise: continue to `03-api-contracts.md`.

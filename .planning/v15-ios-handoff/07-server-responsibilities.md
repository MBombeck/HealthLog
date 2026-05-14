---
file: 07-server-responsibilities.md
purpose: Exhaustive list of what the server already handles — so iOS doesn't reinvent any of it.
when_to_read: Right after 06-ios-responsibilities.md, before any iOS feature design. The inverse of that doc.
prerequisites: 02-server-architecture.md, 04-data-model.md
estimated_tokens: ~4500
version_anchor: v1.4.25 / sha 49f71c92
---

# Server Responsibilities

## TL;DR

Everything except the HealthKit adapter, the Keychain, the APNs token, the offline cache, and the iOS UI. The server owns AI prompts + safety contracts + provider routing, Insights generation, PR detection, GLP-1 PK helper, Withings sync (Activity + Sleep + measurement + medication), Health Score, source-priority resolver, audit log, rate limiter, i18n, notifications, and the API token store. iOS reads results; iOS does not reimplement.

## STOP HERE IF

- You're tempted to recompute the Health Score on the iOS side. Don't — see `16-health-score-logic.md`.
- You're tempted to build a local Withings poll. Don't — the cron runs server-side at :00 and :15.
- You're tempted to fork the i18n strings to a Swift bundle without sync. Source-of-truth is `messages/<locale>.json` on the server; iOS reads + ships those.

## Domain 1 — Coach AI

### What the server does

- **Per-locale system prompts** — DE (hand-curated), EN (authoritative), FR/ES/IT/PL (native build via the matrix). Source: `src/lib/ai/coach/system-prompt.ts`.
- **GROUND RULES 1-15** — all 15 ratchet through every Coach call. The safety contract holds the EU MDR line (rules 9, 10, 15 explicitly).
- **PROMPT_VERSION** — `4.25.0` stamped into every prompt + every Wide-Event log entry. Source: `src/lib/ai/prompts/insight-generator.ts:34`.
- **Coach Snapshot composition** — per-turn data extracted from the user's measurements via `buildCoachSnapshot()`. Stripped of PII, anchored to `User.timezone`, GLP-1 block conditionally added. Source: `src/lib/ai/coach/snapshot.ts`.
- **Refusal heuristics** — pattern bank for prompt injection + off-topic. Source: `src/lib/ai/coach/refusal.ts`.
- **Multi-provider routing** — codex → openai → anthropic → local → admin-openai chain. Source: `src/lib/ai/provider.ts`.
- **Streaming response** — SSE token frames + provenance event + done. Endpoint: `POST /api/insights/chat`.
- **Evidence-block sentinel parser** — strips `---KEYVALUES---` block from prose, populates `provenance.keyValues`. Source: `src/lib/ai/coach/keyvalues.ts`.
- **Refusal-probe matrix** — >1800 adversarial probes across 6 locales × 15 rules, tested in CI.

### What iOS does

Build a streaming chat UI over the SSE endpoint. Nothing else. See `14-coach-mental-model.md` for the full mental model.

## Domain 2 — Insights generation

### What the server does

- **Per-page system prompts** — `general-status.ts`, `blood-pressure.ts`, `weight.ts`, `pulse.ts`, `mood.ts`, `bmi.ts`, `medication-compliance.ts`. Each layers a DOMAIN section on top of the shared `base-system.ts`.
- **JSON schema validation** — `aiInsightResponseSchema` (Zod). The wrapper retries once on schema failure with a corrective system message; 422 on second failure. Source: `src/lib/ai/generate-insight.ts`.
- **Citation-coverage check** — every `metricSource` must appear in `citations[]`. Enforced by `findUncitedRecommendations()`.
- **Confidence score** — `computeConfidence()` blends model-side confidence with citation-coverage % to produce a 0..1 score the UI surfaces.
- **Cache** — per-user-per-page-per-locale rows in `AiInsightHistory`. Reads serve cached JSON; writes invalidate downstream.
- **`dailyBriefing` slot** — optional top-level block in the comprehensive Insight; 80-200 words + up to 5 key findings.
- **`weeklyReport` slot** — optional ISO-week block; summary + goingWell + worthWatching + tips + dataQualityNotes.
- **`storyboardAnnotations`** — date-pinned events on the 90-day BP timeline.
- **`trendAnnotations`** — one-sentence observation per metric, rendered below mini-charts.
- **Inline-chart tokens** — the prompt emits `metric:<TYPE>` strings the UI replaces with charts.

### What iOS does

Render the JSON. Show citations. Replace inline-chart tokens. See `15-insights-architecture.md`.

## Domain 3 — Health Score

### What the server does

- **Composite formula** — 4 pillars × weights; redistribution on null. Source: `src/lib/analytics/health-score.ts`.
- **Deterministic `asOf`** — post-Fix-G; no `Date.now()` in the math.
- **Source attribution per component** — `bp/weight/mood/compliance` × `manual/withings/appleHealth/mixed/none`.
- **Weekly delta** — `previous?` input → `delta = score - previous.score`.
- **Bands** — `green >= 75`, `yellow 50..74`, `red < 50`.

### What iOS does

Render the number, the band colour, the delta, and the provenance accordion. See `16-health-score-logic.md`.

## Domain 4 — PR (Personal Record) detection

### What the server does

- **pg-boss queue** `pr-detection`, concurrency=5. Source: `src/lib/jobs/pr-detection.ts`.
- **Worker handler** — `detectPersonalRecordsForUser()` scans the user's full measurement + workout history per metric/slot, picks the all-time best per direction (MAX/MIN), writes to `PersonalRecord`. Source: `src/lib/personal-records/pr-detection-worker.ts`.
- **Warm-up gate** — minimum 7 samples per metric before any record is written. Stops an Apple Health backfill from locking in a freak first-row as "all-time best".
- **6 workout slots** — `longest_run_duration`, `longest_distance_run`, `fastest_5km_time`, `longest_cycle_duration`, `longest_distance_cycle`, `fastest_5km_cycle`. Workout PRs piggy-back on the same module via the `metricSlot` discriminator.
- **30-minute fallback cron** — `*/30 * * * *` re-scans every user. Catch-net for any ingest path that forgot to enqueue.
- **Per-batch enqueue** — `/api/measurements/batch` calls `enqueuePrDetection(userId, { silent })` after every successful batch insert. `silent = entries.length > 50` so large backfills don't fire pushes.
- **Tie handling** — equal-value writes a row but suppresses the push.
- **Idempotency** — `(user, metric, slot, achievedAt)` unique + `skipDuplicates: true`.

### What iOS does

Receive `PERSONAL_RECORD` APNs payload (when the user opts in) + render the `/personal-records` screen via `GET /api/personal-records`. See `06-ios-responsibilities.md`.

## Domain 5 — GLP-1 PK helper

### What the server does

- **One-compartment Bateman absorption / elimination math** — qualitative phase chip (rising/peak/fading), display-only chart with no y-axis labels. Source: `src/lib/medications/glp1-pk.ts`.
- **EMA-approved drug catalog** — 6 drugs with per-drug PK constants from EMA EPAR PDFs (cross-validated with Schneck & Urva 2024 for tirzepatide). Source: `src/lib/medications/glp1-knowledge.ts`.
- **Research Mode disclaimer + acknowledgment** — `RESEARCH_MODE_DISCLAIMER_VERSION = "2026-05-14.1"`. Bumped when the disclaimer wording changes or a new drug joins the catalog. Stored per-user as the acknowledged version.
- **Display-only contract** — Research Mode chart is gated by acknowledgment; Coach (GROUND RULE 10/15) refuses to interpret levels regardless of acknowledgment.
- **Two-compartment math deliberately OUT of scope** — would invite numeric concentration reads = MDR Class I "predict / advise" threshold violation. Deferred to v1.6 + medical-device review.

### What iOS does

Read the qualitative phase chip + the unit-less chart via `GET /api/medications/{id}/glp1-timeline` (after Research Mode acknowledgment). Display only — never reason from the values. iOS must surface the same disclaimer before rendering the chart.

## Domain 6 — GLP-1 titration ladder

### What the server does

- Read-only EMA reference for the typical titration schedule per drug (Lilly's "4 weeks per step" for Mounjaro, Novo's "4 weeks per step" for Ozempic/Wegovy, etc.).
- Per-user titration history captured in `Medication.titration` / `MedicationIntakeEvent`.
- EMA reference + history feed the Coach `weeklyContext.glp1` block when applicable.

### What iOS does

Read + display the history. Never advise. The Coach is the only surface that names the drug + dose; the iOS medication detail screen shows the user's logged data, not a recommendation.

## Domain 7 — Withings sync

### What the server does

- **Withings OAuth flow** — connect via `/api/withings/connect`, callback at `/api/withings/callback`.
- **Measurement sync** — `sync.ts`, every 60 minutes via pg-boss cron + webhook trigger.
- **Activity v2 sync** — `sync-activity.ts`, cron `0 * * * *` (every hour at :00) + webhook `appli=16`. Fields: steps, distance, calories.
- **Sleep v2 sync** — `sync-sleep.ts`, cron `15 * * * *` (every hour at :15) + webhook `appli=44`.
- **Medication sync** — out of scope for Withings (medications are user-logged or imported, not from Withings).
- **Idempotency** — `(userId, type, measuredAt, source, sleepStage)` composite unique with NULLS NOT DISTINCT (Migration 0055).
- **Day-anchoring** — Withings returns per-day aggregates; the server stores them at the day's noon UTC (12:00:00Z) so the row lands inside the local day for every user timezone in the [-11, +12] range.
- **Cron-fired vs webhook** — webhook is the primary delivery; cron is the safety net for the 1 % of webhook deliveries Withings drops.

### What iOS does

Nothing. The iOS app doesn't talk to Withings directly. When the user connects Withings on the web, the server pulls + pushes to iOS via the standard data-flow (Insights regenerate, Health Score updates, APNs notifications). iOS sees the resulting rows via `GET /api/measurements`.

## Domain 8 — Health Score (separate from analytics generation)

Covered in Domain 3 above and detailed in `16-health-score-logic.md`. Listed twice because it crosses two domains: math + persistence + cron-refresh all live server-side.

## Domain 9 — Source-priority two-axis resolver

### What the server does

- **Per-metric source priority ladder** — `User.sourcePriorityJson` stores `{ "steps": ["APPLE_HEALTH", "WITHINGS", "MANUAL"], "weight": ["WITHINGS", "APPLE_HEALTH", "MANUAL"], ... }`.
- **Device-type ladder** — `watch > band > ring > phone > scale > other > unknown`. Per-metric overrides supported.
- **Picker algorithm** (`src/lib/analytics/source-priority.ts`):
  1. Bucket measurements by user-tz day.
  2. Walk source ladder, pick first source present in bucket.
  3. Among picked source's rows, walk device-type ladder, keep only top-ranked device-type rows.
  4. Tiebreak preserved by caller's `ORDER BY measuredAt ASC, id ASC`.
- **Output:** filtered row list (subset of input) + per-day picked source for audit/debug overlays.

### What iOS does

Nothing. iOS tags rows with source + deviceType when ingesting from HealthKit; the picker decides which contribute to aggregates. iOS does NOT re-resolve.

## Domain 10 — Audit log

### What the server does

- **`AuditLog` table** — every privileged action (login, password change, OAuth connect, device register, settings change, manual measurement edit/delete, GDPR export request, etc.) writes a row.
- **`auditLog()` helper** — `src/lib/auth/audit.ts`. Two-phase write: `create` then `update` to attach error/result.
- **30-day retention** — `audit-log-cleanup.ts` pg-boss job deletes rows older than 30 days.
- **Admin surface** — `/admin/audit-log` page reads + filters.

### What iOS does

Nothing. iOS-originated actions land in the audit log via the same API endpoints the web app uses (the audit-log write is server-side). iOS can render the user's own audit log via `GET /api/audit-log` if a "my activity" screen is in scope.

## Domain 11 — Rate limiter

### What the server does

- **Per-user + per-endpoint** Postgres-anchored rate limiter. Source: `src/lib/rate-limit.ts`.
- **Sliding window** counts requests in the last N ms; 429 when over.
- **Per-route caps** — `/api/measurements/batch` is 60/min/user; `/api/insights/generate` is lower (provider call cost). See each route for its specific cap.
- **5-minute cleanup cron** — `*/5 * * * *` purges expired counters.

### What iOS does

Handle 429 responses gracefully — display a "too many requests, try again in a moment" toast. Back off exponentially on retry. The iOS sync queue should batch + space its uploads naturally; healthy use should never hit the limit.

## Domain 12 — i18n

### What the server does

- **Flat-file translation bundles** — `messages/de.json`, `en.json`, `fr.json`, `es.json`, `it.json`, `pl.json`.
- **Server-translator** — `src/lib/i18n/server-translator.ts`. Reads + walks the JSON tree by `dotted.key.path`.
- **Locale list** — `["de", "en", "fr", "es", "it", "pl"]`. Source: `src/lib/i18n/config.ts`.
- **Maintained locales** — `{ de, en }` are Marc-maintained. The other four are AI-drafted with structural-coverage tests.

### What iOS does

Bundle the JSON files (or hand-port to Swift `.strings` / `.stringsdict` via SwiftGen). Server-side strings (Insight prose, Coach prose) arrive pre-localised in the API response — iOS does NOT translate them again.

iOS does translate its own UI labels (button text, screen titles, etc.). Source of truth = `messages/<locale>.json`; iOS ships the same files.

## Domain 13 — Notification dispatcher

### What the server does

- **Multi-channel dispatcher** — Telegram + ntfy + Web Push + APNs. Source: `src/lib/notifications/dispatcher.ts`.
- **Per-user-per-channel preferences** — `NotificationPreference` table, default ON except `PERSONAL_RECORD` (default OFF).
- **Channel-state machine** — handles transient failures, exponential backoff, give-up after 5 transient failures.
- **APNs sender** — `src/lib/notifications/senders/apns.ts`. Uses `@parse/node-apn` for HTTP/2 connection pool + JWT bearer rotation. One Provider per gateway (sandbox / production).
- **Hard-reject handling** — when APNs returns `Unregistered`, `BadDeviceToken`, or `DeviceTokenNotForTopic`, the device row is deleted from the DB.
- **VAPID config** — Web Push key management.

### What iOS does

Receive APNs payloads, parse `eventType` + `deepLink`, route the user to the right screen. Re-register the APNs token on rotation (post to `/api/devices` again). See `06-ios-responsibilities.md`.

## Domain 14 — Personal Record detection

Covered in Domain 4 above. Cross-listed because the PR worker is one of the larger server-side jobs the iOS app inherits the result of.

## Domain 15 — API token store

### What the server does

- **`ApiToken` table** — long-lived tokens for native clients + scripted integrations. SHA-256 hashed in DB; plaintext returned once at creation.
- **Per-token scope** — `read`, `write`, `admin`. Most native clients use `read+write`.
- **Per-token revoke** — `DELETE /api/tokens/{id}`. The deletion is propagated to the auth middleware via cache invalidation.
- **Per-token last-used** — updated on every successful auth.

### What iOS does

The iOS app does NOT use long-lived API tokens for normal use — it uses the 30-day bearer issued by `/api/auth/login`. Long-lived API tokens are an advanced feature surfaced in Settings → API for users who want to script against their own data; iOS can render the page but doesn't generate tokens for itself.

## Domain 16 — Onboarding + registration

### What the server does

- **Registration** — `/api/auth/register` with email + password.
- **Onboarding flow** — multi-step (`/api/onboarding/*`) collecting timezone, height/age, goals.
- **Passkey enrolment** — `/api/auth/passkey/register-begin` + `register-verify` (WebAuthn).
- **Registration status** — `/api/auth/registration-status` reports whether onboarding is complete.

### What iOS does

Render the onboarding screens (Swift native), POST through the endpoints. The server enforces step order + validation. Passkey enrolment uses `ASAuthorization` on iOS — see `05-auth-flows.md`.

## Domain 17 — Doctor report generation

### What the server does

- **PDF doctor report** — `/api/doctor-report/pdf` server-renders a PDF summarising the user's last 90 days. Includes recent measurements, mood trend, medication compliance, PRs, AI Insight.
- **CSV export** — `/api/export/csv` for downstream tooling.
- **GDPR export** — `/api/export/gdpr` ships every row the user owns as JSON + ZIP.

### What iOS does

Trigger the export, hand the resulting URL to iOS's share sheet / save-to-Files dialog. The PDF is server-rendered with a stable layout — iOS does not regenerate.

## Domain 18 — Achievements / gamification

### What the server does

- **`UserAchievement` table** — per-user-per-achievement-id rows with unlock timestamp.
- **`/api/gamification/*`** — list achievements, unlock state, streak counters.

### What iOS does

Render the achievements page. The unlock rules are server-side; iOS reflects state.

## Domain 19 — Admin surface

### What the server does

- `/admin/*` pages for ops: system status, audit log, host metrics, feature flags, user impersonation.
- `/api/admin/*` API.
- Admin-only routes gated by `User.role`.

### What iOS does

The iOS app is NOT an admin client in v1.5. Admin features live in the web app only.

## Domain 20 — Cron + worker process

### What the server does

- **pg-boss** as the queue. Source: `src/lib/jobs/boss-instance.ts`.
- **Worker process** — separate Node process from the Next.js server. Source: `src/lib/jobs/reminder-worker.ts`.
- **Queues** registered:
  - `medication-reminder` — every 15 min
  - `withings-fallback-sync` — every 60 min
  - `withings-activity-sync` — every 60 min at :00
  - `withings-sleep-sync` — every 60 min at :15
  - `pr-detection` — on-demand + 30 min fallback
  - `audit-log-cleanup` — daily
  - `idempotency-cleanup` — every 5 min
  - `feedback-aggregator` — daily
  - `host-metric-sampler` — every minute
  - `medication-inventory-expire` — daily
- **Cron format** — standard `*/15 * * * *` etc.

### What iOS does

Nothing. The worker is server-process; iOS sees the results of cron-fired jobs in API responses + APNs payloads.

## Domain 21 — Encryption + crypto

### What the server does

- **`encrypt()` / `decrypt()`** for sensitive columns (`aiAnthropicKeyEncrypted`, `codexAccessTokenEncrypted`, Telegram bot token, ntfy auth, etc.). Source: `src/lib/crypto.ts`.
- **Argon2id** password hashing.
- **Bearer token signing** with HMAC.

### What iOS does

Only Keychain storage on the device — that's a different surface (OS-managed). The bearer token is opaque to iOS; iOS does NOT decode it.

## Domain 22 — Idempotency middleware

### What the server does

- **`withIdempotency()`** wrapper around mutation handlers. Source: `src/lib/idempotency.ts`.
- **Cache** — `(userId, idempotencyKey)` → response body, TTL 24h.
- **5-minute cleanup cron** purges expired rows.

### What iOS does

Send `Idempotency-Key` header on every batch ingest / mutation it would replay on network error. UUIDv4 is the standard choice.

## What the server does NOT do (iOS exclusive)

The complement: see `06-ios-responsibilities.md` Domain 1-5.

## Cross-references

- **06-ios-responsibilities.md** — the inverse.
- **14-coach-mental-model.md** — Coach detail.
- **15-insights-architecture.md** — Insights detail.
- **16-health-score-logic.md** — Health Score detail.
- **08-locked-contracts.md** — exact API surface area.

## "Since v1.4.24" diff markers

- **NEW v1.4.25 W14a** — OpenAPI hard-flip; every endpoint exposes a published OpenAPI 3.1 spec. iOS can codegen against `/api/openapi.json`.
- **NEW v1.4.25 W14c** — Native FR/ES/IT/PL Coach system prompts via the safety-contract matrix.
- **NEW v1.4.25 W16c** — PR detection pg-boss queue (concurrency=5 + 30-min fallback + 7-sample warm-up + 6 workout slots).
- **NEW v1.4.25 W17b/c** — Withings Activity v2 + Sleep v2 syncs added (the cron at :00 and :15).
- **NEW v1.4.25 W19a/c** — GLP-1 knowledge layer + PK helper + Research Mode disclaimer-version pinning.
- **NEW v1.4.25 W5d** — Full Withings measurement-type coverage: `FAT_FREE_MASS`, `FAT_MASS`, `MUSCLE_MASS`, `SKIN_TEMPERATURE`, `PULSE_WAVE_VELOCITY`, `VASCULAR_AGE`, `VISCERAL_FAT`.
- **NEW v1.4.25 W8e** — Health Score per-component source attribution + `asOf` deterministic.
- **NEW v1.4.25 W8c** — Two-axis source-priority picker (source × device-type).
- **NEW v1.4.25 W10** — Rate limit on batch ingest 60/min/user.
- **NEW v1.4.25 Fix-G** — `computeHealthScore` purity restored (no `Date.now()` leak).

## iOS implementation checklist

1. **Trust the server.** Every domain above is already implemented.
2. **Codegen Swift models** from `/api/openapi.json`. Skip hand-writing.
3. **Read the server's APNs payload schema** before rendering. The `eventType` + `deepLink` keys are the routing inputs.
4. **Treat the server as authoritative.** When iOS and server disagree on any computed value (Health Score, compliance %, PR list), the server wins — iOS re-fetches.
5. **Never recompute server-side logic on-device.** The drift will accumulate; the test surface is server-only.

## Self-test snippet

```bash
# Check what the worker process is running
curl -s http://localhost:3000/api/admin/worker-status \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Confirm OpenAPI is published
curl -s http://localhost:3000/api/openapi.json | jq '.paths | keys | length'
```

# Phase W17b + W17c — Withings Activity + Sleep v2 sync routines

Author: implementation agent
Date: 2026-05-14
Scope: v1.4.25 waves W17b (Activity routine) + W17c (Sleep v2 routine)
Branch: `develop` (sequential atomic commits)

## Outcome — 6 atomic commits

| # | Commit | Sub-task |
|---|--------|----------|
| 1 | `df5a82b` | `feat(schema): extend Measurement composite with sleepStage (Migration 0055)` |
| 2 | `e504faa` | `feat(withings): expand webhook subscriptions to activity + sleep v2` |
| 3 | `128ee10` | `feat(withings): activity sync — steps + distance + active-energy from getactivity` |
| 4 | `9ae47dc` | `feat(withings): sleep v2 sync — stage-level segments per night` |
| 5 | `b55942f` | `feat(jobs): pg-boss queues for activity-sync + sleep-v2-sync + webhook enqueue hooks` |
| 6 | `dab7de3` | `test(sources): cross-source priority for Withings Activity + Apple Health` |

## Tests landing in this phase

Unit (Vitest, fast):

- `src/lib/withings/__tests__/client.test.ts` — `WITHINGS_NOTIFY_APPLIS` now contains 16 + 44; `subscribeWebhook` posts those appli values.
- `src/lib/withings/__tests__/sync-activity.test.ts` — 9 cases: fetch shape, field mapping, idempotency (findFirst+create/update), end-of-day measuredAt anchor, externalId stamp, 0-step rest-day handling, missing-field tolerance, recordSyncSuccess.
- `src/lib/withings/__tests__/sync-sleep.test.ts` — 12 cases: state→SleepStage enum mapping (0..3 + state-4 ignore + unknowns), unix-seconds vs minutes conversion, segment writes, externalId stamp, re-sync update path, ScanWatch no-REM tolerance, recordSyncSuccess.
- `src/app/api/withings/webhook/__tests__/route.test.ts` + `[token]/__tests__/route.test.ts` — 6 new dispatch cases: appli=16 enqueues activity queue, appli=44 enqueues sleep queue, both fall back to inline sync when pg-boss is unavailable, appli=4 (legacy) keeps the measure path, missing appli keeps the measure path.
- `src/lib/jobs/__tests__/withings-queues.test.ts` — 6 source-text regression guards: queue names, cron expressions (:00 + :15 offset), handler wiring, sync module imports.
- `src/lib/sources/__tests__/source-priority-withings-applehealth.test.ts` — 8 cross-source cases: APPLE_HEALTH wins for cumulative + sleep defaults; WITHINGS-only fallback when iOS hasn't reported; user override flip; per-stage independence from activity rows (sleepStage NULL vs non-null).

Integration (testcontainer-backed Postgres):

- `tests/integration/withings-sleep-stage-composite.test.ts` — Migration 0055 contract: 4 stage rows for one night co-exist; same-stage duplicates still rejected; NULL-vs-NULL dedup preserved for non-sleep rows (NULLS NOT DISTINCT); findFirst+update path idempotent.
- `tests/integration/withings-activity-sync.test.ts` — end-to-end activity sync writes one row per (date, metric); re-sync updates in place.
- `tests/integration/withings-sleep-sync.test.ts` — end-to-end sleep sync writes one row per stage segment; re-sync updates in place.

Totals across the touched area: 357 unit tests passing (`src/lib/withings`, `src/lib/sources`, `src/lib/analytics`, `src/app/api/withings`, `src/lib/jobs/__tests__`).

## Key implementation decisions

1. **Migration 0055 — `NULLS NOT DISTINCT` over `COALESCE`**: Postgres 16 (docker-compose pin) ships native `NULLS NOT DISTINCT` on unique indexes. Used that instead of the COALESCE-expression pattern because (a) it keeps the schema readable, (b) Prisma's introspection still sees a plain unique index, (c) the migration drift risk is documented inline (future regenerations must preserve the clause).

2. **Prisma upsert reshaped as findFirst + create/update**: Prisma's generated compound input requires non-null `sleepStage`. Rather than break the typed contract, every write path that touches `(userId, type, measuredAt, source, sleepStage=NULL)` uses `findFirst` + conditional `create`/`update`. The unique index still serializes concurrent inserts at the DB level, so the worst case is a P2002 we catch and ignore.

3. **Webhook handler fan-out vs single sync entry**: chose explicit branching on `appli` over a single fan-out helper. Three reasons: (a) the activity / sleep paths enqueue onto pg-boss rather than running inline so the webhook response stays sub-100ms, (b) the legacy `appli=1/2/4 or missing` path keeps the exact pre-W17 inline behaviour (no migration risk), (c) easier to read and test per appli.

4. **pg-boss queue payload shape**: each W17b/c queue's payload optionally carries `userId`. Webhook → set; cron → absent → handler iterates every `WithingsConnection`. Single handler implementation covers both call paths.

## Flags / open questions for the next session

- **Drift risk on Migration 0055**: a future `prisma migrate dev --create-only` that touches the `Measurement` model may regenerate the unique index without the `NULLS NOT DISTINCT` clause. The migration file's header documents the contract; consider adding a CI lint to enforce it (out of W17b/c scope).
- **No `User.withingsActivityWatermarkAt` column**: the research spec mentioned a per-user watermark, but adding it would have required schema work outside Migration 0055's bounds. Today both new sync routines use a 30-day rolling window which is cheap (≤1 page from Withings) and idempotent. Watermark column can land in v1.4.26 if cron load justifies it.
- **`recordError()` import in reminder-worker**: imported but unused in the new activity / sleep handlers' happy path — wired in the catch arms for parity with the existing pattern. No lint warning today.
- **No `setupWebhook` re-subscribe helper for legacy users**: the spec mentioned a one-time migration helper. The current behavior: any user who reconnects (W5d reconnect banner) re-runs `setupWebhook` which now POSTs all five appli values. Users who haven't reconnected yet stay on `[1, 2, 4]` until they do. No additional helper landed because the W5d banner already drives the upgrade path organically.

## Out-of-scope (per spec)

Did NOT touch:
- `src/lib/ai/prompts/` or `messages/*.json` (W14c agent's territory)
- `src/app/api/workouts/`, `src/lib/validations/workout.ts`, `docs/api/openapi.yaml` (W16b agent's territory)
- `User` schema columns (deferred — no watermark column added)
- Withings `getsummary` per-night summary row (W17c spec listed `action=get` only; per-night summary stays as research-table entry for v1.4.26)
- `Device-type` resolution for Withings rows (research §7 — deferred to `User v2-Getdevice` ingest in v1.5)

# W16c PR Detection Worker — Research

**Scope**: v1.4.25 W16c implementation plan for the `PersonalRecord` detection worker. Schema, helpers, and the bare `GET` route landed in W8d (Migration 0054 + `src/lib/personal-records/pr-direction.ts` + `src/app/api/personal-records/route.ts`). The worker that populates rows was explicitly deferred in the W8d phase report and re-inserted into v1.4.25 by Marc directive 2026-05-14. v1.4.26 backlog item P2-1 (`.planning/v1426-backlog.md:42`) is consequently pulled forward.

**Status**: read-only research. No code changes in this document.

---

## Section 1: Schema recap (W8d Migration 0054 + pr-direction.ts)

The shipped schema (`prisma/migrations/0054_personal_record/migration.sql`) differs subtly from the outline at `.planning/research/w8d-implementation-outline.md` §5 — the worker is written against the **actual** shape:

- `id` (cuid), `user_id` (CASCADE), `metric_type` (Measurement enum reuse), `metric_slot` (nullable TEXT — workout discriminator), `direction` (`MAX|MIN` enum), `value`, `unit`, `achieved_at`, `source_measurement_id` (SET NULL on delete — survives measurement deletion), `source` (default MANUAL), `external_id`, `created_at`.
- UNIQUE `personal_records_dedup_key` on `(user_id, metric_type, metric_slot, achieved_at)`. **The outline wanted `value` and `source` in this key; the landed migration omits both** — so the worker cannot write two rows for the same `(user, metric, slot, instant)`. Implications in §5.3.
- Index `personal_records_user_metric_idx` on `(user_id, metric_type, value)` — supports `ORDER BY value DESC LIMIT 1` hot-path.

The direction helper at `src/lib/personal-records/pr-direction.ts` maps every `MeasurementType` to `MAX`, `MIN`, or `null`, asserted exhaustive by `__tests__/pr-direction.test.ts`. The worker MUST short-circuit on `getPRDirection(type) === null` — suppression list at lines 71–82 (BP, glucose, weight, sleep, temperature, pulse, oxygen, fat-free-mass).

**No `source_workout_id` column** — the outline proposed it; Migration 0054 omitted. Workout PRs have `source_measurement_id = NULL` and the worker resolves the originating `Workout.id` separately. Migration 0055 can add the column in v1.4.26 if the doctor-report needs the drill-down link.

---

## Section 2: Detection algorithm per metric + per metric-slot

### 2.1 Plain measurement-driven PRs (`metric_slot = NULL`)

For each `MeasurementType` where `isPRTrackable(type) === true` (16 types — see `pr-direction.ts` lines 47–69):

1. **Trigger surface**: batch-insert into `Measurement` (Apple Health `/api/measurements/batch` at `src/app/api/measurements/batch/route.ts`, the W16b ingest worker, the Withings nightly sync at `src/lib/withings/sync.ts`, and manual single-row insert). Each of these enqueues a `pr-detect` job carrying `{ userId, metricType[], cutoffTimestamp }`.
2. **Query current best**: `SELECT value, achieved_at FROM personal_records WHERE user_id=? AND metric_type=? AND metric_slot IS NULL ORDER BY value <direction> LIMIT 1`. Uses the `personal_records_user_metric_idx` index.
3. **Query candidate**: `SELECT id, value, measured_at, source, external_id FROM measurements WHERE user_id=? AND type=? AND measured_at > <last-detected-cursor> ORDER BY measured_at`. The "last-detected-cursor" is a per-user-per-metric watermark — see §3.4.
4. **Compare**: for each candidate row, if `direction='MAX' && value > current_best` or `direction='MIN' && value < current_best` → insert a new `PersonalRecord` row. Update the in-memory `current_best` for the next iteration in the same batch (so a back-filled history with three monotonic PRs writes three rows, not just one).
5. **Idempotency**: `INSERT … ON CONFLICT (user_id, metric_type, metric_slot, achieved_at) DO NOTHING` (Prisma `skipDuplicates: true` on `createMany`). Replaying the same job is a safe no-op — matches the pattern at `src/app/api/measurements/batch/route.ts` line 262.

### 2.2 Workout-driven PRs (`metric_slot != NULL`) — defer to v1.4.26

W8d landed `Workout` (Migration 0053) but NOT the ingest endpoint (v1.4.26 P2-2). With zero workout rows in prod, workout-PR detection cannot trigger. **Scaffold** the worker's `metricSlot` switch but defer the workout-slot vocabulary (`longest_run`, `fastest_5km`, etc.) and the matching `WorkoutPRSlot` enum to v1.4.26 alongside P2-2. Worker early-returns on non-null `metricSlot` in v1.4.25.

### 2.3 BMI + sleep-stage PRs — defer to v1.4.26

BMI is derived from weight+height; `WEIGHT` direction is suppressed at `pr-direction.ts:79` because the goal direction is user-dependent (bulk vs cut), plus BMI has a goal-band not a goal-direction. Defer alongside the `User.thresholdsJson`-aware favourable-direction helper.

`SLEEP_DURATION` is suppressed at `pr-direction.ts:80` (longer is not strictly better). Per-stage PRs (longest deep sleep, longest REM) need a separate metric-slot vocabulary and stage-aware aggregation. Defer.

### 2.4 Lookback window

Scan against all-time best, not a rolling window — the `personal_records_user_metric_idx` index makes `ORDER BY value LIMIT 1` constant-time.

---

## Section 3: Worker infrastructure (pg-boss already wired)

### 3.1 HealthLog already runs pg-boss — no Redis required

`package.json:65` declares `"pg-boss": "^12.18.2"`. The shared instance accessor at `src/lib/jobs/boss-instance.ts` is set on worker startup in `reminder-worker.ts:1147`. Twelve queues + their schedules already run (`reminder-worker.ts:78–117`): medication reminders, Withings fallback sync, six daily insights, telegram cleanup, MoodLog sync, weekly backup, three cleanup jobs, off-host backup, host-metric sampling, and recommendation-feedback aggregation.

pg-boss is Postgres-native (uses `pgboss.job` + `pgboss.schedule` tables), needs no Redis, and is **already proven** in production. The W16c worker plugs into the existing process; no new infrastructure.

### 3.2 Queue + handler pattern (mirror existing jobs)

Add to `reminder-worker.ts` (or carve into a sibling `src/lib/jobs/pr-detection-worker.ts` once `reminder-worker.ts` crosses 1500 lines — current is 1350, so a sibling file is the cleaner option):

```
const PR_DETECTION_QUEUE = "pr-detection";
// no cron — purely on-demand, dispatched from ingest paths
```

Handler signature mirrors `recordWithingsSync` at `worker-status.ts`:

```ts
interface PrDetectionPayload {
  userId: string;
  metricTypes: MeasurementType[];  // narrows the scan
  triggeredAt: string;             // ISO8601
}
await boss.work<PrDetectionPayload>(PR_DETECTION_QUEUE, handler);
```

### 3.3 Dispatcher hooks (push, not poll)

Three enqueue call sites after writes:

1. **`POST /api/measurements/batch`** at `route.ts:303` — one job per affected user with unique metric-types touched.
2. **Withings nightly sync** at `src/lib/withings/sync.ts` — same pattern as the insights queues (`reminder-worker.ts:1262–1287`).
3. **Manual single-measurement insert** at `src/app/api/measurements/route.ts` — a manual RHR low shouldn't wait for the nightly sync.

**Fallback cron**: daily catch-up at `02:30 Europe/Berlin` scanning measurements newer than `MAX(personal_records.created_at)`. Protects against an ingest path that forgets to enqueue.

### 3.4 Per-metric watermark

No `personal_record_scan_state` table exists. Three options: (A) Migration 0055 with a watermark table; (B) derive from `MAX(measurements.measured_at)` newer than `MAX(personal_records.created_at)`; (C) re-scan all-time on every job (~30k rows × 16 metrics, indexed, ~100 ms).

**Recommend Option C for v1.4.25** — zero schema risk, fits the freeze. Revisit with Option A in v1.4.26 if cost surprises. Product-lead signed off on this trade-off at `.planning/research/w10-product-lead-assessment.md` §H.4.

### 3.5 In-process vs out-of-process

The reminder-worker boots a separate node process. pg-boss `boss.work()` is push-based via Postgres `LISTEN`. An ingest path running in the Next.js server can call `boss.send(PR_DETECTION_QUEUE, payload)` and return immediately; the worker process drains the queue async. **No synchronous PR detection blocks an ingest request.**

### 3.6 BullMQ + Redis: rejected

`docker-compose.yml` carries Postgres + app only — no Redis (contrary to the prompt's hint). pg-boss is already battle-tested in HealthLog, shares the Postgres connection pool, and needs no second job-store. BullMQ adds Redis for zero gain.

---

## Section 4: UX surfaces (badge + push opt-in + doctor report + Coach grounding)

### 4.1 Insights — "PR" badge on metric trend tiles

`src/components/charts/trend-card.tsx` already carries `TrendDirectionSentiment` (line 40) and the `data-slot="trend-card-all-time"` test handle (line 351). Extend the all-time block to read `GET /api/personal-records?metricType=<type>` (the route already exists and supports `?metricType=` filter — `route.ts:42`). A small "PR" pill renders when the latest measurement equals the current PR row's `value` within float-equality tolerance (1e-6). Badge is purely a display layer — no DB change.

i18n: badge label `pr.badge` needs all six locales (EN maintained + DE + FR/ES/IT/PL AI-initial per Marc directive in `v1425-handoff.md:66`). This is captured in v1.4.26 backlog P4-8 (`.planning/v1426-backlog.md:95`).

### 4.2 Push notification — opt-in

The `EVENT_TYPES` array at `src/lib/notifications/types.ts:10` carries 5 events; add a sixth: `PERSONAL_RECORD`.

The dispatcher's policy at `dispatcher.ts:117` is **opt-out by default** — no preference row = send. For PRs this is **too aggressive** at launch: a multi-year Apple Health backfill would fire hundreds of pushes during initial sync. Two required mitigations:

1. **Suppress backfill pushes.** When a batch ingest writes >50 historical measurements in one transaction, the resulting PR notifications carry `silent: true` — they land in Insights / doctor report but skip push channels.
2. **`PERSONAL_RECORD` default-off.** Override the dispatcher's default-enabled policy specifically for this event — gate behind an explicit toggle in `/settings/notifications`. v1.4.25 ships toggle present, OFF.

### 4.3 Doctor report — last-30-days PR section

`src/lib/doctor-report-data.ts` does not currently reference `PersonalRecord`. Add a `recentRecords: PersonalRecord[]` slice with `WHERE achieved_at > NOW() - INTERVAL '30 days'`. Renders as a small clinical-friendly list (German + English per existing doctor-report locale handling) — "Lowest resting HR: 49 bpm (2026-04-22)". No clinical interpretation — pure factual list.

### 4.4 Coach grounding (no extrapolation)

The Coach evidence pipeline reads from `src/lib/insights/general-status.ts` and siblings (the daily insights queues at `reminder-worker.ts:80–95`). Extend the snapshot to include a `recentPersonalRecords` array (last 7 days only — anything older is no longer "fresh news"). Inject as evidence chips, the same way correlations and BP-in-target percentages are injected today.

**Hard rule for the prompt template**: the Coach surfaces the fact ("You hit a new resting-HR low of 49 bpm on Tuesday") but does NOT claim credit, predict the next PR, or recommend behaviour anchored to the PR. This matches the existing prompt discipline documented in the Marathon kickoff memory (`feedback_ai_insights_differentiator.md`: "evidence-grounded + dynamic + multi-provider; not generic chat").

---

## Section 5: Edge cases (first measurement, ties, reset, dormancy)

### 5.1 First measurement of a metric

Zero rows in `personal_records` for `(user, metric, slot=NULL)`: first measurement establishes the baseline **silently** — insert the row, but no push, no Coach mention, no badge animation. Badge can still render statically. Silence is a notification concern, not a data concern — the worker carries a `silent: boolean` on the job payload; no `silent` column on the row.

### 5.2 Ties — equal-value retro

When a user hits the exact same RHR value on a different day, the worker inserts a new row (different `achieved_at`, equal `value`). **No push** — the user matched, not beat. Badge stays on the newest row. Detection: `if (value === currentBestValue) insertSilent`. Float equality is fine (sensor data is integer-encoded or pre-rounded).

### 5.3 Multi-source ties (same instant)

The outline §5.5 wanted two rows when two sources hit the same value at the same instant. **Migration 0054's unique index excludes `source`** — so only the first-inserted row wins; the second triggers `ON CONFLICT DO NOTHING`. `pickCanonicalSourceRows()` can't disambiguate (only one row exists), but the surviving row's `source` column matches the iOS-vs-watch ordering anyway. Acceptable for v1.4.25; Migration 0055 can re-add `source` to the unique key if needed.

### 5.4 Warm-up period — drop the gate

The outline mentioned a 7-measurement warm-up. **Drop it.** Apple Health backfill writes years of history in a single ingest; the gate would gratuitously suppress real PRs. The silent-baseline rule (§5.1) already handles cold-start. A measurement-count threshold makes no sense across metrics with different cadences (7 weekly weigh-ins ≠ 7 daily step rows).

### 5.5 User-triggered reset

"Reset PRs" button in `/settings/data` for life-phase changes (pregnancy, surgery, medication switch): `DELETE FROM personal_records WHERE user_id=?` + re-enqueue a full-rescan. The rescan walks the user's Measurement history per-metric and writes one row per strict improvement (Kadane-style — preserves the PR trajectory). **Defer button to v1.4.26**; worker ships first.

### 5.6 Dormancy: reject auto-recalibration

A user on vacation re-syncs and loses their PR history — too magical, too error-prone. The user-triggered reset (§5.5) is the only lever. DB is source of truth.

---

## Section 6: Performance considerations

Per-job work for one user × 16 PR-trackable metrics:
- 16 × `LIMIT-1` lookup against `personal_records_user_metric_idx` — ~10 ms total.
- 16 × indexed range scan against `measurements_user_id_type_measured_at_idx` (`schema.prisma:367`). 5-year history × 1/day × 16 metrics ≈ 30k rows, ~50 ms.
- ≤ 16 INSERTs (typical 0–2).

Total per-job: **~100 ms**. Cap pg-boss concurrency at **5** for the PR queue (the worker process also runs reminder checks, insights, Withings sync — PR is lowest-priority tenant). Five jobs × 100 ms = 50 jobs/sec drain rate.

**First-ingest spike**: a first Apple Health export through W16b writes 100k+ measurements in minutes. The dispatcher hook enqueues ONE job per batch (not per measurement); silent-baseline suppression (§5.1) prevents a 16-push notification storm. Integration-test this explicitly.

---

## Section 7: Tests strategy

The existing personal-records test at `src/app/api/personal-records/__tests__/route.test.ts` validates the GET shape. The W16c worker needs:

1. **Unit — `detectPRsForUser(userId, metricTypes, prismaMock)`**:
   - First-measurement-per-metric → inserts row, returns `{ silent: true }`.
   - Strict improvement vs MAX → inserts row, returns `{ silent: false }`.
   - Strict improvement vs MIN → inserts row, returns `{ silent: false }`.
   - Tie (equal value) → inserts row, returns `{ silent: true }`.
   - Worse value → no insert.
   - `null`-direction metric (BP / glucose / weight) → early-return, no DB call.
   - Idempotency: re-running the same input is a no-op (mock `createMany`'s `skipDuplicates` behaviour).

2. **Integration — POST /api/measurements/batch enqueues the right job**:
   - Mock the `boss.send` call; assert payload `{ userId, metricTypes }` only contains the metric types touched by the batch.
   - Assert no enqueue when the batch is empty / all duplicates.

3. **Integration — worker handler end-to-end** with a real Postgres fixture (use the existing integration-test harness — vitest + `tsx` + a test DB):
   - Seed measurements, run the handler, assert the resulting `personal_records` rows.

4. **Drift-guard**: every `MeasurementType` enum value must appear in either the worker's MAX, MIN, or suppress branch. The existing `pr-direction.test.ts` already enforces this for `getPRDirection`; the worker tests should reuse the same exhaustiveness assertion.

Target: +40 unit tests, +6 integration tests (matches the v1.4.24 → v1.4.25 baseline ratio per `project_v1422_marathon_outcome` memory: 2111 unit + 89 integration in v1.4.22).

---

## Section 8: Open questions for Marc

1. **Push default off vs on for PERSONAL_RECORD event**: recommendation is **OFF** (override the dispatcher's default-enabled policy for this single event type). Rationale: first-ingest backfill of multi-year Apple Health history would fire hundreds of notifications; users opt-in via Settings → notifications after they've seen the in-app badge a few times. Marc to confirm.

2. **Workout PRs in v1.4.25 or defer to v1.4.26**: recommendation is **defer** — the workout ingest endpoint (v1.4.26 P2-2) hasn't shipped, so there are no Workout rows to detect against. Scaffold the worker's metric-slot dispatch but enumerate workout slots in v1.4.26 alongside the ingest endpoint.

3. **BMI + sleep-stage PRs**: recommendation is **defer both to v1.4.26**. Both need either a goal-direction resolver (BMI) or a stage-aware aggregator (sleep) that doesn't exist yet.

4. **`silent` flag on the `personal_records` row**: silence is a notification concern, not a data concern, so the row carries no `silent` column — the flag lives on the enqueued job payload. Confirm Marc agrees, or add a Migration 0055 column.

5. **User-triggered "Reset PRs" button**: defer to v1.4.26. The worker has to ship first to test the rescan path.

6. **Per-user-per-metric watermark table (Migration 0055)**: deferred to v1.4.26 — the v1.4.25 worker re-scans full history per job (~100 ms per user per dispatch). Revisit if production cost surprises.

---

## References

- Schema: `prisma/migrations/0054_personal_record/migration.sql`
- Direction helper: `src/lib/personal-records/pr-direction.ts`
- Bare GET route: `src/app/api/personal-records/route.ts`
- W8d phase report (deferred-items): `.planning/phase-W8d-v1425-ah-server-prep-report.md` lines 166–186
- W8d outline (full design): `.planning/research/w8d-implementation-outline.md` §5
- v1.4.26 backlog P2-1 (pulled forward): `.planning/v1426-backlog.md:42`
- pg-boss accessor: `src/lib/jobs/boss-instance.ts`
- pg-boss queue patterns: `src/lib/jobs/reminder-worker.ts:78–117, 1147, 1248–1332`
- Batch ingest entry: `src/app/api/measurements/batch/route.ts:240–305`
- Dispatcher default policy: `src/lib/notifications/dispatcher.ts:29, 117`
- Event-type vocabulary: `src/lib/notifications/types.ts:10–17`
- Canonical-source picker: `src/lib/analytics/source-priority.ts:103`
- Trend-card mount point: `src/components/charts/trend-card.tsx:40, 351`
- Doctor-report assembler: `src/lib/doctor-report-data.ts`
- Coach evidence pipeline: `src/lib/insights/general-status.ts` (+ 5 sibling status files)
- Senior-dev sign-off on 0054 dedup-key: `.planning/research/w10-senior-dev-findings.md:264`
- Product-lead sign-off on worker P2-1: `.planning/research/w10-product-lead-assessment.md` §H.4

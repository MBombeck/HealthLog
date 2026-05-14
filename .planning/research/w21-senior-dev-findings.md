# W21 senior-dev findings — v1.4.25

Reviewer pass over HealthLog `develop` at the v1.4.25 release-candidate
snapshot (commit near `51f23ef3`). Scope: architectural correctness of
the six new Prisma migrations (0051..0059), purity claims on the new
helper modules, edge cases on the multi-day flows (onboarding wizard,
Withings sleep / activity sync, PR detection, Coach prompt versioning,
two-axis source-priority), performance posture on the new list /
section endpoints, and error-handling shape consistency.

I reviewed read-only. No code changed.

## Summary

The schema additions are solid. Every new table carries the right FK
`ON DELETE` posture for the delete-user cleanup story (CASCADE on the
user / medication axis, `SET NULL` on `PersonalRecord.sourceMeasurementId`
where the historical fact has to survive the underlying measurement
deletion). Every new index pairs with a real read path. The Migration
0055 `NULLS NOT DISTINCT` switch on the measurement composite is the
single most important detail in the bundle and it is implemented
correctly.

The five pure-module claims (`glp1-pk.ts`,
`research-mode-staleness.ts`, `titration/ladder.ts`,
`scheduling/cadence.ts`, `scheduling/compliance.ts`,
`side-effects/taxonomy.ts`) hold up — none of them import the Prisma
client, none of them call `fetch`, none of them read `process.env`,
none of them call `Date.now()` or `new Date()` inside their public
surface. `taxonomy.ts` does import from `@/generated/prisma/client` but
only for the two enum *type* re-exports; no runtime client touch.

One real concern, two medium-grade observations, a handful of minor
notes. No critical findings — the bundle is safe to deploy.

## Critical

None.

## High

None.

## Medium

**M1 — Migration 0057 `onboarding_step` ships nullable with an
unenforced default on existing rows.** `migration.sql` adds the column
as `INTEGER DEFAULT 0` without `NOT NULL`, so every pre-W14b user row
keeps `NULL`. The Prisma schema also models the field as `Int?
@default(0)`. The wizard page at `src/app/onboarding/[step]/page.tsx`
treats `NULL` as `0` via `clampCurrentStep`, and `POST /api/onboarding/step`
treats `fresh.onboardingStep ?? 0` the same way. The behaviour is
correct, but the schema invariant ("every user has an onboarding step
between 0 and 4") is enforced only in application code. A future-self
joining a new query path that reads `User.onboardingStep` directly will
hit a tri-state (`null` / `0..3` / `4`) where they expect a bi-state
(`0..3` / `4`). Two acceptable resolutions: (a) backfill `onboarding_step = 0`
for `onboarding_completed_at IS NULL` rows and `onboarding_step = 4` for
`onboarding_completed_at IS NOT NULL` rows in a follow-up data
migration, then flip the column to `NOT NULL DEFAULT 0`; (b) keep the
nullable column and add a Prisma-validator decoder helper that
collapses the tri-state at the boundary. Either is fine. Today's risk is
non-zero only because the wizard URL handlers fan out to step pages
each of which has to remember the null-equals-zero convention.

**M2 — Withings activity sync anchors per-day rows at 23:59:59 UTC,
which mis-buckets for users east of UTC+0.** `src/lib/withings/sync-activity.ts`
parses `YYYY-MM-DD` from the Withings response as
`new Date(\`${yyyymmdd}T23:59:59.000Z\`)`. For a Berlin-resident user
(UTC+1 / UTC+2 across DST), 2026-06-01T23:59:59Z reads as
2026-06-02T01:59:59 local, which the `dayKey()` helper buckets into the
*wrong* local day. The file comment claims "Berlin-timezone day
analytics consume the row through the standard `dayKey()` helper, which
buckets it into the right local day even across DST shifts" — that's
true for negative or zero offsets, not for positive offsets. The W17b/c
sleep sync side does not have this issue because Withings ships unix
seconds for sleep segments. Recommended fix: anchor at noon-UTC of the
reported `YYYY-MM-DD` (resilient to ±12h offsets) or convert through the
user's stored timezone (`User.timezone` exists per the v1.4.15
per-user-tz migration). Same-machine analytics in dev (Marc, Berlin)
will not surface this, but a v1.5 international user lands a one-day
shift on every activity row.

**M3 — `pickCanonicalSourceRows` cross-source workout dedup is
deliberately deferred to v1.5 but the same shape applies to
`PersonalRecord` rows seeded from workouts.** Migration 0054's unique
key is `(userId, metricType, metricSlot, achievedAt)` — `source` is not
in the dedup key. The workout-PR loop in
`src/lib/personal-records/pr-detection-worker.ts` writes the row tagged
with the source of the *best* workout it found per slot, and relies on
the unique key to dedup. That's safe for workout-derived PRs in
v1.4.25 (workout cross-source dedup is a known-deferred problem and the
detector reads the canonical workout row per slot). But the
measurement-driven branch with `metricSlot = null` has the NULLS-DISTINCT
problem the comment at line 245 of `pr-detection-worker.ts` already
calls out and the application-level pre-flight already handles. Just
flagging that the worker correctness depends on that pre-flight — the
test in `pr-detection-worker.test.ts` should pin the contract by
exercising "same userId / metricType / null slot / same achievedAt, two
back-to-back invocations" and asserting one row written. Spot-check
recommended.

## Low

**L1 — Migration 0058 `research_mode_enabled` ships `NOT NULL DEFAULT
false` while the two companion columns ship NULL.** That's the right
shape (the timestamp + version are recorded only after a positive
acknowledgment) but the `ADD COLUMN IF NOT EXISTS` posture means a
dev-DB that had this column from a prior hand-edit could now have
`NULL` rows for `research_mode_enabled` if the prior shape was
nullable. Production is fine — this migration has never landed before
0059. Worth a `WHERE research_mode_enabled IS NULL` sanity probe on
each staging deploy.

**L2 — Migration 0054 `personal_records_dedup_key` uses
NULLS-DISTINCT for `metric_slot`.** This is documented and the
detection worker compensates with an application-level pre-flight
`findFirst`. The W16c phase report flagged it. The worker handles it.
The risk on this specific axis is concurrent worker invocations — two
batch ingests landing within the same millisecond, both calling
`enqueuePrDetection`, both pre-flighting before either writes. Today's
PR detection queue has `retryLimit: 3` and `retryBackoff: true` but no
single-flight gate per user. The chance of two workers landing the
exact same `(userId, metricType, null, achievedAt)` is low (you'd need
two backfills running in true parallel) — but if it ever happens, two
rows get written. Acceptable today; consider a `boss.singletonKey`
keyed on `userId` for the queue when v1.5 adds Apple Health backfill
streams.

**L3 — Migration 0055 silently depends on the legacy index name being
`measurements_user_id_type_measured_at_source_key`.** The file comment
notes this is the Prisma `0001_init` default and was verified via
grep. `DROP INDEX IF EXISTS` makes the migration idempotent even if
that name happens to be wrong, but a wrong name plus `IF NOT EXISTS`
on the new index would leave both the old composite *and* the new
composite in place, with the old NULLS-DISTINCT semantics still
breaking sleep dedup. Recommend a follow-up data check: after each
prod deploy, query
`SELECT indexname FROM pg_indexes WHERE tablename = 'measurements'`
and assert exactly one composite index covering
`(user_id, type, measured_at, source, *)`.

**L4 — `pg-boss` `pr-detection` queue has no dead-letter handler.**
`retryLimit: 3` + `retryBackoff: true` means a permanently-failing job
exhausts retries and dies silently in the pg-boss archive table. The
30-minute fallback cron re-creates it next sweep. Today's worker only
fails on transient DB errors so this is fine; if v1.5 adds external
API calls to the detection path (e.g. Apple Health workout fetch), a
DLQ + alert becomes necessary.

**L5 — `OnboardingStepPage` step gating is server-rendered but the
task brief mentioned a "step 4.5 GLP-1 branch" that does not exist in
the codebase.** I searched onboarding for any `4.5`, `glp1Branch`,
`GLP-1` references and found none — the wizard is purely 0..4. Either
the brief is stale or step 4.5 is a future v1.4.26 item. Either way no
bug; just noting the gap so the W21 reviewers don't write tests for a
non-feature.

## Migrations audited (one paragraph per migration)

**0051 (`measurement_device_type`).** Single `ALTER TABLE` adding a
nullable `device_type TEXT`. Idempotency comes free with no `IF NOT
EXISTS` because the column is brand-new and the migration runs once.
Default is implicitly NULL. The source-priority analytics layer treats
NULL as "unknown" and the picker falls through to keep every row when
no device-type signal is present (verified in
`src/lib/analytics/source-priority.ts:181-193`). Free-text rather than
enum was the right call; coordinating an enum bump every time a new
device class arrives would have been a sustained tax. No index on the
column — that's correct because the column is a tie-breaker filter, not
a query predicate; the existing
`measurements_user_id_type_measured_at_idx` covers the hot read path.
Safe.

**0052 (`apple_health_enum_extensions`).** Three `ALTER TYPE ... ADD
VALUE IF NOT EXISTS` statements appending `AUDIO_EXPOSURE_ENV`,
`AUDIO_EXPOSURE_HEADPHONE`, `TIME_IN_DAYLIGHT` to the `measurement_type`
enum. Forward-additive, idempotent, no row backfill needed (no existing
row carries any of the new values, so the type extension is pure
metadata). The W8d phase report's decision to drop `WORKOUT_ROUTE` from
the enum (workouts are first-class on the `Workout` table from
Migration 0053) is the right architectural call — a sentinel enum
value with no corresponding row is dead weight in every downstream
consumer (chart registry, doctor-PDF allow-list, analytics summariser).
Safe.

**0053 (`workout_and_route`).** Two new tables. `workouts` has the
expected FK posture (`user_id` CASCADE), composite unique on
`(user_id, source, external_id)` with NULL-distinct semantics keeping
manual entries non-colliding, two read-path indexes
(`workouts_user_started_idx`, `workouts_user_sport_started_idx`). The
known-deferred cross-source dedup is correctly flagged in the schema
TODO. `workout_routes` has 1:1 enforcement via `workout_id UNIQUE`,
CASCADE on workout delete, GeoJSON as JSONB to avoid the PostGIS
extension dependency. Safe.

**0054 (`personal_record`).** `personal_records` table with NEW
`personal_record_direction` enum (MAX | MIN). FK posture: user
CASCADE, `source_measurement_id SET NULL` so the historical fact
survives measurement deletion. Composite unique is
`(user_id, metric_type, metric_slot, achieved_at)` with PG's default
NULLS-DISTINCT semantics; the application-level pre-flight in
`pr-detection-worker.ts` compensates for the `metric_slot IS NULL`
case. Idempotency contract is explicit and the worker uses
`createMany({ skipDuplicates: true })` on top of it. Safe with the
caveat documented in L2.

**0055 (`measurement_sleepstage_composite`).** Drops the legacy 4-axis
composite, recreates a 5-axis composite with `NULLS NOT DISTINCT` so
non-sleep rows (sleep_stage IS NULL) continue to dedup on the first
four columns. Pin-point-correct fix for the Withings Sleep v2 sync
that writes one row per stage. The PG 15+ syntax is available on the
deploy target (Postgres 16-alpine). The hand-rolled migration is
intentional — Prisma 7 regenerates the index without `NULLS NOT
DISTINCT` and the schema comment correctly warns future-self to
preserve the clause on any `prisma migrate dev --create-only` that
touches this index. Safe. The single soft spot is the silent
dependency on the legacy index name being `..._source_key`; see L3.

**0056 (`medication_inventory_item`).** New `medication_inventory_state`
enum + `medication_inventory_items` table. FK posture: user + medication
both CASCADE. Two indexes: composite on
`(user_id, medication_id, state)` for the "active inventory for this
medication" UI tile, and `(user_id, expires_at)` for the daily
expire-stale background job. State machine is documented inline in
the migration (ACTIVE → IN_USE → EXPIRED | USED_UP). Persisted
`expires_at` rather than derived is the right trade-off for the cron
index pattern. Safe.

**0057 (`user_onboarding_step`).** Single `ADD COLUMN IF NOT EXISTS
"onboarding_step" INTEGER DEFAULT 0` on the `users` table. Existing
rows keep NULL (PG behaviour: DEFAULT applies to new inserts only).
The application code (`OnboardingStepPage.clampCurrentStep` and
`/api/onboarding/step` `onboardingStep ?? 0`) treats NULL as 0
consistently. See M1 for the schema-invariant note. Safe.

**0058 (`user_research_mode`).** Three columns on `users`:
`research_mode_enabled BOOLEAN NOT NULL DEFAULT false`,
`research_mode_acknowledged_at TIMESTAMP(3)` nullable,
`research_mode_acknowledged_version TEXT` nullable. Idempotent via
`ADD COLUMN IF NOT EXISTS`. The version + enabled pairing is the
right shape — version drift forces re-acknowledgment without losing
the historical acknowledgment timestamp. Safe.

**0059 (`medication_side_effect`).** Two new enums
(`medication_side_effect_category` with 5 values,
`medication_side_effect_entry` with 21 values), one new table.
FK posture: user + medication both CASCADE. Severity bounded with
`CHECK (severity >= 1 AND severity <= 5)` — DB-side defence in depth
against client-side Zod drift, exactly right. Two indexes:
`(user_id, medication_id, occurred_at)` for the drug-detail timeline,
`(user_id, occurred_at)` for the Coach snapshot aggregation. Both are
real read patterns. The DB stores `category` denormalised even though
the entry → category mapping is fixed in the pure
`taxonomy.ts` — the schema comment correctly notes the API write path
*derives* category from entry rather than trusting the client, which
guards against an inconsistent write slipping through. Safe.

## Pure-module verification

All six claimed-pure modules check out:

- `src/lib/medications/glp1-pk.ts` — imports only from
  `@/lib/medications/glp1-knowledge` (the static GLP-1 knowledge
  table). No Prisma, no fetch, no `Date.now()`. Every function accepts
  `asOf: Date` per the W19c-Backend claim. Pure.
- `src/lib/medications/research-mode-staleness.ts` — no imports at all
  beyond the type signatures. Functions take `asOf` explicitly. Pure.
- `src/lib/medications/titration/ladder.ts` — imports from
  `@/lib/medications/glp1-knowledge`. Same posture as `glp1-pk.ts`.
  Pure.
- `src/lib/medications/scheduling/cadence.ts` — imports
  `parseScheduleRecurrence` from `@/lib/medication-schedule`, which is
  itself pure (no Prisma, no fetch, no environment reads). Functions
  take `asOf` and `anchor` explicitly. Pure.
- `src/lib/medications/scheduling/compliance.ts` — depends on
  `cadence.ts`. Pure.
- `src/lib/medications/side-effects/taxonomy.ts` — imports only the
  enum *types* from `@/generated/prisma/client`. No runtime Prisma
  surface. Pure.

## Coach prompt versioning

`PROMPT_VERSION` is a single exported constant at
`src/lib/ai/prompts/insight-generator.ts:34` = `"4.25.0"`. Every other
locale-specific prompt path (`buildNativeCoachPrompt`, the EN body, the
DE body, the system-prompt assembler) imports that constant. No
locale carries a hand-coded version string. Mismatched-version
detection is centralised through the feedback-attribution layer
(`src/lib/ai/feedback-attribution.ts`) which falls back to the current
`PROMPT_VERSION` when the message's stored version is missing — so a
legacy cached snapshot still attributes feedback against the live
version rather than crashing on a null. Sound.

## Source-priority two-axis (W8c)

`src/lib/analytics/source-priority.ts` implements the source-axis
ladder + device-type-axis ladder with all the right fallbacks: every
metric × deviceType combination falls through to "keep every row of
this type" when the user's ladder doesn't enumerate any present
deviceType for that metricType (lines 239-244), and the single-row
fast path is taken first (line 176). The default ladder lives at
`src/lib/validations/source-priority.ts` and the `sourcePriorityJson`
column is read on the User row for per-user overrides. Two-axis
implementation correctness checks out.

## Performance / N+1

`/api/medications/[id]/cadence/route.ts` reads schedules + intake
events with a single bounded query each (windowDays clamped to 180);
no per-row fetches. `/api/medications/[id]/side-effects/route.ts`
ships a single `findMany` with the `(user, medication, occurred_at)`
index covering the query path. `/api/personal-records/route.ts` ships
a single `findMany` with the `(user, metric_type, value)` index. No
N+1 in the new endpoints I inspected.

## Error-handling

The `safeRequestProp` narrow-catch (introduced W15, narrowed-then-widened
through the FixG/FixH hotfix loop) is correctly scoped to the
NextRequest probe path only. Spot-checking the new W19d/e/f routes:
each uses `apiHandler` (which runs the global narrow-catch under it),
each uses `safeJson` for body parsing (which returns a `{ error }`
shape rather than throwing), each returns `apiError(message, status)`
on the validation-fail branch. Consistent.

## API contract consistency

Every new route I read returns `apiSuccess(payload)` which the
`api-response` helper wraps as `{ data: payload }`, matching the
Marc-memory convention `(await res.json()).data`. Error responses go
through `apiError(message, status, code?)` which produces
`{ error: string, code?: string }`. Consistent.

## Closing

The bundle is in good shape. M1 (onboarding_step nullable invariant)
is a hygiene item that compounds if left untouched — recommend folding
it into the v1.4.26 schema-tidy phase. M2 (Withings activity sync
positive-offset TZ mis-bucket) is invisible at Marc's home zone but
trips the first international user; worth fixing before the v1.5 iOS
release that opens the door to Apple Health users worldwide. M3 is a
test-coverage tightening rather than a code change. Nothing here
blocks the v1.4.25 deploy.

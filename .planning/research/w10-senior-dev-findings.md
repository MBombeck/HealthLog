# W10 Senior-Developer Architectural Review — v1.4.25

**Reviewer:** Senior-dev architectural reviewer (multi-agent QA, W10).
**Scope:** `git log v1.4.24..develop` at `/Users/marc/Projects/HealthLog`.
**Date:** 2026-05-14.

Headline counts:

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 2     |
| Medium   | 4     |
| Low      | 3     |

No critical defects. The diff is unusually well-shaped for a release of
its size — the four migrations are additive, FK behaviours match
user-facing intent, and the new two-axis source-priority picker
preserves the v1.4.24 behaviour as the default fallback path. Issues
below cluster around backward-compat edge cases (the legacy-NULL
device-type path) and one batch-ingest race-reconciliation logic
inversion that is rare-path but wrong.

---

## Critical

_None._

The four migrations (0051 / 0052 / 0053 / 0054) are forward-only and
additive. The MeasurementType enum additions (0052) use `ALTER TYPE …
ADD VALUE IF NOT EXISTS` which is non-locking on Postgres 12+, deploys
without a table rewrite, and remains backward-compatible with the
v1.4.24 client (the new enum values simply never appear on legacy
rows). The new tables (`workouts`, `workout_routes`, `personal_records`)
introduce no FK pointing back at existing tables in a way that could
break existing rows. `Measurement.deviceType` is nullable with no
backfill required — the picker treats `NULL` as `"unknown"`. Migration
0054's `source_measurement_id REFERENCES measurements(id) ON DELETE SET
NULL` is the correct semantic: the PR is the historical fact, the
underlying measurement is a pointer; deleting the measurement must not
delete the achievement.

---

## High

### H-1: Race-reconciliation logic in `/api/measurements/batch` is inverted

`src/app/api/measurements/batch/route.ts:240–278` (commit `024845e` /
v1.4.23 baseline; touched in W8c).

The comment block at lines 240–242 says *"if `skipDuplicates` quietly
absorbed a row (race with another batch), reconcile the per-entry
status."* The reconciliation logic at line 270 then asserts that any
row we flagged as `inserted` but which *isn't* present in `stored`
(post-write recheck) was raced and should be downgraded to `duplicate`.

That's the wrong half of the truth table. If another batch wrote the
row in the same tick and `skipDuplicates` absorbed ours, the row *is*
in `stored` — written by them, not us. A row flagged `inserted` and
absent from `stored` would imply our `createMany` returned a row count
> 0 *and* the unique row vanished — that doesn't happen under normal
Postgres semantics. The block effectively never fires the downgrade
path in practice, so the `insertedCount` over-counts in the rare race
case it claims to handle.

The user-facing impact is bounded — `inserted + duplicates +
skipped !== processed` for a single batch under contention, which the
iOS sync cursor logic could mis-interpret as a partial write. v1.4.25
ships zero iOS clients writing through this endpoint, so the bug is
latent. Will become real once v1.5 iOS app lands.

**Fix shape:** invert the predicate. The correct reconciliation is to
compare the row's `createdAt` against the request start time — if the
DB row pre-existed our request, it was raced. Or simpler: drop the
reconciliation entirely. The unique index already enforces correctness;
the per-entry status can be best-effort.

### H-2: Picker's "mixed-MeasurementType bucket" comment doesn't match behaviour

`src/lib/analytics/source-priority.ts:197–229`.

The inline comment at lines 197–200 promises:

> Resolve the ladder from the first row's type — buckets are typically
> same-type so this only resolves once per bucket. If the bucket carries
> mixed types, `resolveLadder` is cached and walked per row inside the
> device-type walk below.

The implementation resolves *one* ladder from the first row's `type`
(line 201) and then walks `sampleLadder` for the whole bucket (line
207) and matches every row against `pickedDeviceType` (lines 225–229).
`resolveLadder` is cached but never re-called per row. If a future
caller passes a mixed-type bucket while having a per-metric
`deviceTypePriority` override set, rows of the *non-matching* type
get tested against the wrong ladder.

Today's caller (`src/app/api/analytics/route.ts:80`, SLEEP_DURATION
aggregation) only feeds single-type rows into the picker, so the bug
is latent. The risk is a future analytics path (Coach evidence rollup,
correlations engine, doctor-PDF section) that batches multiple types
through one picker call.

**Fix shape:** either honour the comment (resolve the ladder per row,
not per bucket) or rewrite the comment to assert the same-type
precondition and add a `console.assert` / runtime guard. Same-type
precondition is the cheaper fix and matches every call site today.

---

## Medium

### M-1: Source-priority determinism depends on caller-supplied input order

`src/lib/analytics/source-priority.ts:121–127`.

The picker buckets rows into a `Map` keyed by `dayKey(measuredAt)` and
walks the buckets via `for (const [key, slot] of buckets)`. `Map`
iteration is insertion-order, which means the output `canonicalRows`
order mirrors the caller's input order. That's deterministic only if
the caller passes a deterministically-ordered list. Today
`fetchMeasurementSeriesChunked` paginates with `orderBy: [{ measuredAt:
"asc" }, { id: "asc" }]` which IS deterministic — but the picker's
contract doesn't state that as a precondition.

**Fix shape:** add a JSDoc precondition on `pickCanonicalSourceRows`
declaring "input must be deterministically ordered" (this is also how
the algorithm guarantees the "ties broken on first-seen" outcome).

### M-2: `parseSourcePriority` silently swallows malformed user JSON

`src/lib/validations/source-priority.ts:274–275`.

When the Zod safeParse fails, `parseSourcePriority` returns
`buildResolved({}, {}, {})` — i.e. the user's saved priority blob is
silently discarded and replaced with defaults. No log, no telemetry, no
warning to the user that their carefully-tuned ladder vanished.

This will be the source of a near-impossible-to-debug user report
("why did my ladder reset?") if the Zod schema gains a stricter
constraint in a future release and someone's persisted JSON predates
it. The Marc-directive feedback memory on cache invalidation +
explicit-state-management argues for surfacing the failure.

**Fix shape:** log the failure via the existing `annotate()` /
`emitIfSampled` telemetry path before returning the default. Cost: one
extra import + four lines.

### M-3: Workout uniqueness key may collide across sources for MANUAL workouts

`prisma/migrations/0053_workout_and_route/migration.sql:52–53` —
`UNIQUE (user_id, source, external_id)`.

Postgres treats NULL as distinct in uniqueness, so two MANUAL workouts
with `external_id = NULL` never collide (this is intentional and
documented). However: a user who manually creates a workout, then later
ingests the *same* workout from HK with the same `external_id` will
land two rows because `source` differs (MANUAL vs APPLE_HEALTH).

For Measurement that's the v1.4.20 design intent (every source's
audit-trail row survives, picker chooses canonical at read time). For
Workout, there is no canonical-picker layer yet, and the dashboard
"recent workouts" query at the `(userId, startedAt)` index will return
duplicates. The W8d phase report explicitly defers the workout-picker
to a future release, so this is a known smell — but the dashboard tile
will show both rows side-by-side once iOS lands. Worth tracking now.

**Fix shape:** add a TODO comment in `Workout` model noting the
de-dup-on-display requirement; consider extending
`pickCanonicalSourceRows()` to a workout variant in v1.5.

### M-4: `/api/personal-records` GET has no pagination or limit

`src/app/api/personal-records/route.ts:40–46`.

Plain `findMany` with no `take`, no `skip`, no cursor. Today the route
returns an empty array for every user (no detection worker exists yet),
so the unbounded query is harmless. Once the worker lands, a power user
with ten years of Apple Health history could accumulate 50+ PR rows
per metric × 14 PR-trackable metrics — still nowhere near a problem,
but adding `take: 500` at the route level is one line of insurance and
matches the project's other ingest-and-read endpoints
(`MEASUREMENT_CHUNK_SIZE = 5000`).

**Fix shape:** add `take: 500` default with a `?limit` query param up to
1000 to maintain the project-wide ceiling pattern.

---

## Low

### L-1: `PersonalRecord` index `(userId, metricType, value)` doesn't help MIN-direction queries efficiently

`prisma/migrations/0054_personal_record/migration.sql:49–50` and
schema `(userId, metricType, value)` index.

Postgres b-tree indexes are bidirectional — `ORDER BY value DESC LIMIT
1` and `ORDER BY value ASC LIMIT 1` both use the same index. The
comment block in the schema (`/// ORDER BY value DESC LIMIT 1 (MAX
direction) / ASC LIMIT 1 (MIN direction). Index covers both.`) is
correct on Postgres. No action.

### L-2: `Measurement.deviceType` is TEXT, not the documented enum

The schema doc says "Stored as free text to avoid coordinated enum
bumps across the iOS client and server every time a new device class
arrives" — that's a defensible call, but the `deviceTypeEnum` Zod check
in `source-priority.ts:52–60` enforces a closed set at the validation
boundary. The result is a TEXT column whose only valid values are the
seven enum slots — a Postgres enum would have been more economical and
just as forward-compatible (`ALTER TYPE … ADD VALUE` is non-locking,
same pattern as Migration 0052). Worth a note for the v1.5 cleanup
pass.

### L-3: i18n drift-guard for PR + Workout strings absent

W8d ships schema and one read endpoint for PersonalRecord; no UI yet.
W9e's i18n drift-guard covers existing keys but no W8d PR/Workout
strings exist to drift on. Track for v1.4.26.

---

## Cross-cutting positive notes

- **Migration safety:** all four migrations are `ALTER TYPE … IF NOT
  EXISTS` or `CREATE TABLE` — zero data migration, zero column
  rewrites. Forward-deployable against a live v1.4.24 server with no
  downtime.
- **Backward compat:** `parseSourcePriority()` correctly merges W8c
  nested shape over W5e flat shape over defaults; the v1.4.24 client
  that emits the flat shape continues to work unchanged. The
  `Measurement.deviceType` column is nullable and the picker treats
  NULL as `"unknown"`, so no client-side change is forced.
- **Edge cases handled:** picker's "no priority-listed source present"
  fallback (line 167) and "no ranked device-type present" fallback
  (line 220) both keep every row in the bucket rather than silently
  drop data. `computeUserHealthScore` returns `null` when no
  components are computable so the UI hides the hero panel rather than
  painting a misleading "0".
- **Performance:** analytics route paginates with cursor +
  `MEASUREMENT_CHUNK_SIZE = 5000` and a 1000-iteration safety cap.
  The two-axis picker stays O(n) with cached ladders. The health-score
  route reads `Measurement.source` alongside `value` in the same SELECT
  (no extra round-trip).
- **Concurrency:** the `Idempotency-Key` flow on `/api/measurements/batch`
  + the composite unique `(userId, type, source, externalId)` index
  defend against replay-from-iOS races at the storage layer. The
  reconciliation block (H-1) is the only race-handling defect, and it
  fails toward "over-count inserted" rather than data corruption.
- **Coupling:** no boundary violations spotted. Settings UI consumes
  the validation module via the existing settings API contract, not
  direct Prisma. The new picker is pure (no DB calls, no IO).

---

## Migration-by-migration verdict

| Migration | Verdict |
|-----------|---------|
| **0051** `measurement.device_type` (TEXT nullable) | Safe. Additive column, nullable, no backfill, picker NULL-safe. |
| **0052** Three MeasurementType enum values | Safe. `ALTER TYPE … ADD VALUE IF NOT EXISTS` non-locking on Postgres 12+. The W8d phase report's decision to drop `WORKOUT_ROUTE` from this migration is sound — that data belongs in the `WorkoutRoute` table, not as a `Measurement.type` sentinel. |
| **0053** `workouts` + `workout_routes` | Safe. `ON DELETE CASCADE` on user+workout matches "if user deletes account, drop their workouts" intent; route geometry deletes with its parent workout. NULL `external_id` distinct in unique constraint is correct. Mild smell on cross-source dedup (M-3). |
| **0054** `personal_records` + `PersonalRecordDirection` enum | Safe. `ON DELETE SET NULL` on `source_measurement_id` is the correct semantic. `(userId, metricType, metricSlot, achievedAt)` dedup key is idempotent for the future worker. `direction` stored on row rather than derived avoids per-query lookups. |

---

## Recommendation

**Ship v1.4.25 as-is.** No findings rise to critical or to blocking the
release. The two High items are latent (the inverted race
reconciliation only matters once iOS clients post concurrent batches;
the mixed-type bucket comment is misleading but never reached by
today's call sites). Both should be tracked into the v1.4.26 hygiene
window.

Top three to address before the v1.5 iOS sprint:

1. **H-1** — fix the batch-ingest race reconciliation before iOS goes
   live, or remove the block. The unique index does the correctness
   work; the reconciliation only confuses the per-entry status report.
2. **H-2** — assert single-type precondition on
   `pickCanonicalSourceRows` (cheaper than honouring the comment), or
   move ladder resolution inside the per-row loop.
3. **M-2** — surface `parseSourcePriority` failures via telemetry so a
   future schema-tightening doesn't silently nuke a user's saved
   ladder.

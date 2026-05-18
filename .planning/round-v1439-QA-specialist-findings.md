# v1.4.39 — QA findings — Prisma + performance specialist

Read-only review of `git diff v1.4.38.8..develop` against the five wave
reports (W-MOOD / W-MED / W-SUM / W-WMY / W-SINCE) and the v1.4.38 perf
audit. Severity-band structure.

---

## Critical

None.

The three migrations (`0070_v1439_mood_rollups`,
`0071_v1439_medication_compliance_rollups`,
`0072_v1439_rollup_sum_value`) are correct and non-blocking under
PostgreSQL ≥ 11:

- `0072` is `ADD COLUMN IF NOT EXISTS … DOUBLE PRECISION` with no
  `DEFAULT` and `NULL`-able. PG 11+ treats this as a catalog-only DDL
  (no table rewrite) — production rollout holds `ACCESS EXCLUSIVE` on
  `measurement_rollups` for milliseconds, writes resume immediately.
- `0070` / `0071` are `CREATE TABLE IF NOT EXISTS` + indexes guarded by
  `DO $$ BEGIN … duplicate_object` for the FKs. Idempotent on replay.

Per-write hooks: I confirmed none of the touched routes
(`mood-entries/*`, `medications/intake/*`, `medications/[id]/intake/*`,
`mood-entries/bulk`, `medications/intake/bulk`, `ingest/medication`,
`telegram/webhook`, `import`, `integrations/moodlog/webhook`,
`settings/data`, `settings/moodlog`) wraps the entry create/update
inside an interactive `prisma.$transaction(async tx => …)`. The
admin/backups restore is the only interactive tx; its rollup
`deleteMany` correctly uses `tx`, and the long-running
`recomputeUserMoodRollups` / `recomputeUserMedicationCompliance` calls
correctly run **outside** the tx (audit-doc'd, verified in
`src/app/api/admin/backups/[id]/restore/route.ts:280-470`). The
snapshot-isolation gotcha you flagged in #2 does not apply.

---

## High

### H1 — Mood rollup DST-boundary case is documented, NOT pinned in a test

W-MOOD report claims the UTC-bucket vs TZ-anchored `MoodEntry.date`
divergence is "pinned in parity test which uses noon-anchored
timestamps". The route parity test
(`src/app/api/mood/analytics/__tests__/route.test.ts`) uses
`moodLoggedAt: 2026-05-{08,09,10}T12:00:00.000Z` — i.e. noon UTC, far
from any DST boundary. There is NO test that exercises a Berlin DST
boundary case:

- 2025-03-30T01:30Z (Berlin: 03:30 CEST, after the spring-forward
  hour) → UTC bucket = 2025-03-30; user-tz bucket = 2025-03-30. OK.
- 2025-10-26T01:30Z (Berlin: 02:30 CET, before fall-back hour) → UTC
  bucket = 2025-10-26; user-tz bucket = 2025-10-26. OK.
- 2025-10-25T23:30Z (Berlin: 00:30 CET, AFTER fall-back) → UTC bucket =
  2025-10-25; user-tz bucket = 2025-10-26. **DIVERGES.**

For Berlin tenants the slip lands on entries logged 22:00-23:59 UTC,
which is 23:00/00:00-00:59/01:59 local depending on DST. The W-MOOD
report's noon-anchored test does not cover this. The legacy live path
emitted `MoodEntry.date` (TZ-anchored); the rollup tier emits the
UTC-midnight bucket. The route test will pass because all its
fixtures live mid-day. A real user logging "right before bed" at 23:30
local will see the rollup bucket attribute their entry to the wrong
calendar day in the chart.

Severity: High because it's a silent data-mislabelling, not a 5xx.
Recommend: add at least one route-parity test with
`moodLoggedAt = "2025-10-25T23:30:00.000Z"` and a user `timezone:
"Europe/Berlin"` that asserts the bucket lands on `2025-10-26` (or
explicitly accepts the documented `2025-10-25` slip).

### H2 — Live-fallback `since` cap silently nulls `avg30LastYear` on cold mounts

`src/app/api/analytics/route.ts:240` introduces a 90-day floor on
every per-type `fetchMeasurementSeriesChunked` call.
`summarize().avg30LastYear` reads from days 365-395 ago, so it now
returns `null` whenever the fast-path gate flips false. The W-SINCE
report flags this trade-off but the consumer impact is real:

- `src/app/page.tsx:309` reads `summary.avg30LastYear` when
  `compareBaseline === "lastYear"` and falls back to `null` →
  `tileCompareDelta` returns `null` → the tile renders "no prior
  data".
- `src/app/api/insights/generate/route.ts:149` and
  `src/components/insights/vo2-max-chart-row.tsx:70` do the same.

When the rollup fast-path covers the user, the rollup branch supplies
the long-window numbers via the comprehensive aggregator + summaries
slice (also 90-day capped, but `avg30LastYear` already arrives null
there — confirmed by reading
`src/lib/analytics/summaries-slice.ts:174,410,551`). So this is **not
a regression for the rollup-covered common case**; the issue is the
live-fallback path strictly worsens.

Severity: High because the fall-through path is the one users with
brand-new measurement types or empty rollups land on, and that's
exactly when the "vs last year" tile would be a useful baseline.

Recommend: either (a) document on the front-end that "vs last year"
silently degrades during cold mounts, or (b) leave the cap at 395+30
days so the year-ago window remains populated on the fall-through
path. The audit's own quick-win bundle anchored on 90 days so option
(a) is a fair release-time call, but it should be Marc-Voice noted.

### H3 — `fetchMeasurementSeriesChunked` `since` filter relies on the existing index

The new `measuredAt: { gte: liveSince }` filter (`route.ts:697`) plus
the existing `orderBy: [{ measuredAt: "asc" }, { id: "asc" }]` is
served by the existing `(user_id, type, measured_at)` index on
`measurements`. I checked `prisma/schema.prisma:Measurement` — the
schema declares the matching `@@index([userId, type, measuredAt])` (no
diff in v1.4.39). Plan stays the same: indexed range scan, no seq
scan. **No regression.**

The W-SUM `SUM(m."value")` addition to `runRollupAggregate`'s
`$queryRawUnsafe` (rollups.ts:391, 424) is just one more
expression in the existing `SELECT` list. The `GROUP BY m."type",
date_trunc(...)` clause and the `WHERE user_id = $1 AND type IN (...)
AND measured_at >= $2 AND measured_at < $3` predicate are unchanged.
Same index path. **No regression.**

---

## Medium

### M1 — `enqueueBootTimeRollupBackfill` UNION branch causes a seq scan on rollup table

`src/lib/measurements/rollups.ts:762-779`: the second UNION arm

```sql
SELECT DISTINCT r2."user_id" AS id
FROM measurement_rollups r2
WHERE r2."granularity" = 'DAY'
  AND r2."sum_value"   IS NULL
```

has no index on `sum_value` and no anchoring predicate. On every
worker boot, this scans every `granularity = 'DAY'` row in
`measurement_rollups` and filters by `sum_value IS NULL`. For Marc's
tenant (~5-10k DAY rollup rows) this is millisecond-class. After the
column converges across all users, the predicate matches zero rows
but the seq scan still runs.

For v1.5 multi-tenant scale this should either gain a partial index
(`CREATE INDEX … WHERE sum_value IS NULL`) or the UNION arm should be
dropped once the discovery completes. The discovery is supposed to be
idempotent and self-converging (the boot-backfill writer always
populates `sum_value`), so a follow-up release can simply drop the arm.

Cosmetic note: the outer `SELECT DISTINCT id FROM (...) discovery`
wrapping a `UNION` is redundant — `UNION` already de-dups. Use `UNION
ALL` + outer `DISTINCT` for clarity, or just drop the outer
`DISTINCT`. Not a bug.

### M2 — `medication_compliance_rollups.day` TEXT column lacks a tested DST-day case

`recomputeMedicationComplianceForDay`
(`src/lib/medications/compliance-rollups.ts:177-252`) correctly
handles DST 23/25-hour days via the `startOfDayUtcInTz(nextDayKey, …)`
two-pass — the helper's `wallClockInTz` + `tzOffsetMinutes` honour
`Intl.DateTimeFormat` DST. I verified `tests/integration` and
`src/lib/medications/__tests__/compliance-rollups.test.ts` (382
lines).

The unit test file exercises DST-adjacent days but the assertion only
checks that the rollup row is written, not that the `[start, end)`
window correctly absorbs the 25-hour day's extra hour. For a 03:00
local intake event on the Berlin fall-back day, both `start +
86_400_000` and the DST-safe `nextDayKey` boundary agree because
03:00 is well after the 02:00→03:00 fall-back transition. A test that
mints an event at 01:30 local on the fall-back day and asserts the
event lands in the **expected** day's bucket would close this gap.

Severity: Medium — the writer code is correct (I traced
`windowEnd = dstSafeEnd.getTime() > start.getTime() ? dstSafeEnd :
end`), but the test does not pin the boundary, so a future refactor
of the DST helpers could silently regress without the suite catching
it.

### M3 — Compliance scheduler mint path fires the hook per `RED`-phase row, not batched

`src/lib/jobs/reminder-worker.ts:572-599`: for every medication whose
`existingMissed === 0` on a RED-phase scheduled-window, the worker
creates one `medicationIntakeEvent` row AND immediately calls
`recomputeMedicationComplianceForEvent`. This is the audit's question
#5 (`N+1 on scheduler mint?`).

Across **one user with N medication schedules** firing simultaneously
the cost is N independent compliance recomputes (each is one bounded
`findMany` plus one upsert). With ~5-10 medications per power user
this is bounded and fine.

Across **all users** the worker iterates all `med` records — but each
user's medications fire only on their own RED-phase clock. The fan-out
is naturally per-tenant. **Not** an N+1 in the
"single-batch-write-fires-N-hooks" sense. Acceptable.

For Marc's tenant explicitly: at most 4-5 hooks per evening when
multiple medications hit their RED window inside the same worker
tick. Negligible.

### M4 — `aggregateWmyBuckets` math is correct (validation)

I confirmed `src/lib/measurements/rollup-read-wmy.ts:204-240` computes
`mean = sumWeighted / totalCount` where `sumWeighted = Σ(count * mean)`
and `totalCount = Σ count`. This is the correct `Σ(count·mean) / Σ
count`, NOT a naive `mean(mean)`. **Math is right.** The 18 unit
pins in `rollup-read-wmy.test.ts` cover the weighted-mean composition
(see `aggregateWmyBuckets > composes weighted mean correctly`).

### M5 — `since` cap in `/api/analytics` does not clip the v1.5 multi-year card

I grep'd every caller of `fetchMeasurementSeriesChunked` — only
`src/app/api/analytics/route.ts:263` uses it. The new
`computeLongWindowSummary`
(`src/lib/analytics/summaries-slice.ts:615`) routes through
`readBestGranularityRollups` (the new WMY reader), which has its own
window-day inputs. **No collision.** Finding #7 in your prompt:
clear.

### M6 — Reader fallback discriminator is correct for both new tiers

Mood rollup: route fallback uses `result.usedRollup`
(`src/app/api/mood/analytics/route.ts`) and the route's
`ensureUserMoodRollupsFresh` watermark check
(`src/lib/mood/rollups.ts:334-374`) reads `newestRollup.computedAt`
vs `Max(updatedAt, moodLoggedAt)`. **Robust** — not "0 rollup rows =
no data" but "rollup tier may be stale and we know which side to
trust".

Medication rollup: `hasMedicationComplianceCoverage`
(`compliance-rollups.ts:373-389`) returns false when no rollup row
exists in the trailing window. The route then falls back to
`buildComplianceBuckets` (the legacy live aggregator) which is
correct over an empty window. The boot backfill fires on the side.
**Robust** for the "zero events" and "zero rollup but events exist"
cases. The "rollup exists but is stale" case relies on the per-write
hooks keeping it fresh — same posture as the measurement rollups.

---

## Low

### L1 — Cosmetic SQL clean-up in the boot-backfill UNION

See M1 — `SELECT DISTINCT id FROM (... UNION ...)` wraps a `UNION`
which already de-dups. Minor.

### L2 — `recomputeMoodBucketsForEntry` only flushes WEEK/MONTH/YEAR on enqueue

Same posture as `measurement-rollups`: the DAY pass is synchronous,
the rest is fire-and-forget via pg-boss. Worth noting that the route
test parity (which mocks pg-boss) does not assert the WEEK/MONTH/YEAR
buckets get enqueued — if a future refactor drops the `Promise.all`
fan-out, no test would catch it. Reachable via a `boss.send` spy
assertion, not currently included.

### L3 — Compliance rollup `day` TEXT range scans for trailing window

`hasMedicationComplianceCoverage` and `readMedicationCompliance` use
`day: { gte: oldestKey, lte: newestKey }` with `day` as TEXT. The
primary key is `(user_id, medication_id, day)` and the descending
index is on `(user_id, day DESC)`. The TEXT comparison is correct for
ISO `YYYY-MM-DD` strings (lexicographic == chronological), so the
range scan is index-served. **No regression.** Worth noting for
future maintenance because TEXT day-keys are unusual in this codebase.

---

## Tests delta

W-MOOD: +21 unit/route tests. W-MED: +18. W-SUM: +8 across 3
test files. W-WMY: +23. W-SINCE: +3. Net ~ +73 v1.4.38.8 → develop.

I sampled the writer tests for parity contracts and they correctly pin
the new `sum_value` flow-through, the rollup partition deletion on
last-row removal, and the weighted-mean composition.

---

## Brief-back (≤ 200 words)

**No critical issues.** Migrations are non-blocking (column add is
catalog-only on PG 11+). Per-write hooks correctly call against the
right Prisma client; no `tx` snapshot-isolation traps. `aggregateWmyBuckets`
correctly weights mean by count. `since` cap does not clip the v1.5
multi-year card (only the legacy analytics route's live-fallback).

**Two high findings worth Marc's call before tagging:**

1. **H1** — the mood rollup DST-boundary case is documented but not
   pinned in a test. The "noon-anchored" parity test misses the
   23:30-01:00 local-tz boundary that diverges UTC vs user-tz day-keys.
   Recommend adding one boundary-case route-parity test before
   release.

2. **H2** — the `/api/analytics` 90-day `since` cap silently nulls
   `summary.avg30LastYear` on the live-fallback path, breaking the
   dashboard / VO2 chart / insights generator's "vs last year"
   comparison tile when the fast-path gate flips false. The rollup
   common case is unaffected. Recommend either Marc-Voice user-facing
   note or widening the cap to ~425 days to preserve the year-ago
   window.

**One medium recommendation for v1.4.40:** drop the
`measurement_rollups.sum_value IS NULL` UNION arm from the boot
backfill once it has converged across all users (M1). Currently runs a
seq scan on every worker boot.

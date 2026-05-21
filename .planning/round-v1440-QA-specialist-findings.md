# Round v1.4.40 — Prisma + perf specialist findings

Read-only review. Scope: W-POOL, W-DELETED, W-INFRA (threads 1/3/4),
W-INSIGHTS (compliance recompute + mood-rollup swap), W-WMY-WIRE,
W-CONSENT. Anchored to `.planning/round-v1439-empirical-trace.md`.

---

## CRITICAL (none)

No release-blocking perf or data-integrity defect found.

---

## HIGH

### H-1 — Bulk recompute hook treats failures as fire-and-forget without surfacing
`src/app/api/medications/intake/route.ts:171-186` and the mirror in
`src/app/api/dashboard/summary/route.ts` `Promise.all(recomputeJobs)`
the recompute calls **without** a catch wrapper. The W-INSIGHTS report
states "errors stay caught inside the helper" but if
`recomputeMedicationComplianceForEvent` ever throws (DB blip, missing
medication row), the `await Promise.all` rejects → the intake POST
returns 5xx **after** the projection `createMany` already committed.
This is asymmetric with the surrounding `auditLog(...).catch(() => {})`
pattern. v1.4.41 candidate: wrap each push in `.catch(err => logger…)`
or wrap the `Promise.all` in `.catch(() => {})` to preserve the
"best-effort" contract the comment promises. Worst-case today is a
recoverable transient blip surfacing as a request failure, not data
loss.

---

## MEDIUM

### M-1 — `deletedAt: null` plan validation — partial index deferred
Every `measurement.findMany` post-W-DELETED now carries
`(user_id, type, measuredAt range, deletedAt IS NULL)`. The existing
`@@index([userId, type, measuredAt])` (prisma/schema.prisma:501) still
serves these queries; the `deleted_at` filter is applied post-index
as a heap-level discard. With ~0 tombstones on Marc's tenant today
the discard cost is nil. **No partial index needed before iOS sync
emits its first tombstones**. Once iOS Apple-Health soft-delete reaches
1–5 % of rows the trade-off shifts; v1.4.41+ candidate: add
`CREATE INDEX measurements_live ON measurements(user_id, type, measured_at)
  WHERE deleted_at IS NULL`. Defer until row-count justifies.

### M-2 — Pool ceiling capacity vs cluster topology
`max=20` per `pg.Pool` × N Node processes. Next.js standalone (Coolify
default) = 1 process per container, so single container = 20 slots
against Postgres' stock `max_connections=100`. Five concurrent
power-users worst-case = 100 = the wall. The brief mentioned dialling
down via `DATABASE_POOL_MAX`; production env should explicitly set this
to 20 (not rely on the default) once container count climbs above 4 or
PgBouncer/transaction-pooling lands. Document in deploy notes.

### M-3 — Slope from MONTH-bucket means is linear-composable but NOT
identical to slope from DAY samples (W-WMY-WIRE)
`avg30LastYear` via `readBestGranularityRollups(type, 395)` reads
`[now-395d, now-365d)` MONTH buckets and count-weighted-averages them.
For mean, this is mathematically equal to mean over the underlying DAY
rows ✓. The health-score `weightLongWindow` is documented as
**annotate-only** (not consumer-visible math) — that's the right call
because a regression slope over monthly means differs from a slope over
daily samples even with linear composability (the means lose intra-month
variance, regression slope tightens). Wave-report claim of
"linear-composability holds" is correct for **mean**; would be misleading
if a future wave wires MONTH-tier means into a slope/r² computation.
Flag for v1.5 Coach drawer integration when slope90 actually consumes a
WMY tier.

---

## LOW

### L-1 — p-limit error semantics verified
`pLimit(4)` (p-limit v7.3.0) propagates the wrapped promise's
rejection through to the caller, so `Promise.all(types.map(t =>
typeFetchLimit(() => …)))` still rejects on first failure. Existing
error path preserved. ✓

### L-2 — Empirical 7.3s → 1.6s claim
Plausible. Pre-fix Wave-C blocked at thick-analytics-release (~7.3s);
post-fix the chart tiles unblock from pool-slot availability (max=20)
rather than analytics drain, so first-paint ≈ Wave-B settle (1.1s) +
tile RTT (~150ms × bounded queuing) → 1.6s. Both p-limit AND max=20
contribute; either alone would unblock Wave-C, the pair is
belt-and-braces. The thick-analytics ~10-15% wall-clock penalty math
checks out: 15-way fan-out across 4 lanes = 4 batches; if all types
were equal-cost it would be 4x slower, but the slowest type dominates
each batch — so the penalty is closer to (slowest_4 / slowest_1) ≈ 1.1-1.2x.

### L-3 — Bulk compliance recompute volume
After `createMany(missing)` the Set-coalesced
`recomputeMedicationComplianceForEvent` calls fire one per
`(medicationId, dayKey)` tuple. Worst case for Marc's tenant ≈
medications × 1 day = ~5-10 round-trips, each walking a
bounded ~30-day intake-event window. Safe. ✓

### L-4 — Mood-rollup tier swap row-bound check
`src/app/api/insights/targets/route.ts` + `comprehensive/route.ts` +
`lib/insights/features.ts` — verified each new path consumes
`readMoodDayRollups` (bounded `count(*) ≤ days_in_window`) instead of
unbounded `moodEntry.findMany`. Coverage-fallback bounds added: 30d on
`targets`, 90d on `comprehensive`, 1y on `features.ts`. All bounded.
Worst-case row count drop from unbounded → ≤365. ✓

### L-5 — `findMany distinct` floor (W-INSIGHTS, targets route)
365-day floor on the previously-unbounded `findMany({distinct})` —
justified in the wave-report (slow-moving metrics like BODY_FAT need a
year window for the "current" tile). Bounded scan + uses the existing
`(user_id, type, measured_at)` index. ✓

### L-6 — ConsentReceipt index alignment
`@@index([userId, createdAt(sort: Desc)])` matches the
`latestActiveReceipt(userId, kind)` query exactly: index scan by
userId, walk descending, filter on `revokedAt IS NULL` + `kind=…` post-
fetch. Append-only invariant pinned in the test suite. ✓

### L-7 — 64KB artefact cap
`ARTEFACT_MAX_BYTES = 64 * 1024` in `src/lib/validations/consent.ts:33`.
Reasonable for signed PDF or JWT; protects against pathological body
sizes. ✓

### L-8 — Rollup umbrella move is pure relocation
Spot-checked 3 importer rewrites
(`@/lib/measurements/rollups` → `@/lib/rollups/measurement-rollups`):
analytics route, insights features, mood-chart consumer. No call-shape
changes, no public-API drift. 58 sites consume the umbrella; zero
remaining references to the old paths. ✓

### L-9 — Knip CI trigger
`.github/workflows/knip.yml` triggers on `push: branches=[main]` and
`pull_request: branches=[main]`. **Does NOT run on PRs targeting
`develop`**. Marc's branch model is develop → main releases-only;
contributors developing on feature branches against develop won't see
the gate until the release PR lands. Acceptable for the current solo-dev
workflow, but if/when external contribution opens up, extend the
`pull_request.branches` to include `develop` so dead-code is caught
before merge to the long-lived branch. The `unlisted` + `binaries` +
`files` + `dependencies` gates are appropriate; deferring `exports` +
`types` is the right call given the 487/52 baseline.

---

## INFORMATIONAL

### I-1 — Compliance-rollup recompute bound on Marc-sized tenants
The `recomputeUserMedicationCompliance(userId, days)` helper walks the
trailing `medicationIntakeEvent` window. On Marc's tenant (~30-90
rows/day × bounded day window) this is cheap; the Set-coalesced fan-out
in W-INSIGHTS keeps it that way. Safe as the directive predicted. ✓

### I-2 — DST drift carry-over from rollup-tier swap
W-INSIGHTS report flags the UTC `bucketStart` vs Berlin-anchored
`MoodEntry.date` divergence on DST nights. The bound is one calendar
day for Berlin tenants on fall-back. v1.5 per-user-tz bucket migration
closes the gap. Inherited from v1.4.38; not introduced this wave.

### I-3 — Cross-wave commit drift
Two waves (W-POOL, W-APNS-NOTIFY, W-RSC, W-WMY-WIRE) report
cross-agent commit-message drift — same pattern memorised from v1.4.37.
The functional diffs are intact (verified via spot-check `git show`),
but release-notes / CHANGELOG generation needs to walk **diff bodies**,
not commit subjects, this release. Out of perf scope; flagging because
it impacts what an auditor sees in git history.

---

## Verdict

W-POOL fix is correct, empirical claim is plausible, error semantics
preserved. W-DELETED full-wire is comprehensive and index-aligned
(partial index deferral is the right call). W-INFRA threads 1/3/4 are
clean. W-INSIGHTS row-bounds verified. W-WMY-WIRE is annotate-only on
the slope path, which sidesteps the variance-loss concern. W-CONSENT
shape + index aligned with the "latest receipt" query. Ship.

One v1.4.41 follow-up: wrap recompute Promise.all in a catch (H-1).
Two long-tail follow-ups: partial index when tombstones materialise
(M-1), extend knip CI trigger to develop branch (L-9).

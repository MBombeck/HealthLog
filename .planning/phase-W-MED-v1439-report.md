# Phase W-MED — v1.4.39 medication-compliance rollup tier

## Directive

Eliminate the 3.2 s cold mount on
`/api/medications/intake?scope=compliance` (`.planning/round-v1438-perf-analysis.md`
§2.5 + §5 P4) by materialising a persistent
`medication_compliance_rollups` ledger keyed
`(userId, medicationId, day)` where `day` is `YYYY-MM-DD` anchored to
the user's IANA timezone.

## Scope

Owned file set:

- `src/lib/medications/compliance-rollups.ts` (NEW)
- `src/lib/medications/__tests__/compliance-rollups.test.ts` (NEW)
- `src/app/api/medications/intake/route.ts`
- `src/app/api/medications/intake/__tests__/route.test.ts`
- `src/app/api/medications/intake/bulk/route.ts`
- `src/app/api/medications/[id]/intake/route.ts`
- `src/app/api/medications/[id]/intake/[eventId]/route.ts`
- `src/app/api/medications/[id]/intake/import/route.ts`
- `src/app/api/medications/[id]/intake/purge/route.ts`
- `src/app/api/ingest/medication/route.ts`
- `src/app/api/telegram/webhook/route.ts`
- `src/app/api/admin/backups/[id]/restore/route.ts`
- `src/lib/jobs/reminder-worker.ts`

`prisma/schema.prisma` + `prisma/migrations/0071_v1439_medication_compliance_rollups`
were read-only inputs from the prerequisite commit `0d33f91d`.

## Commits

| SHA | Commit |
|---|---|
| `83d96a98` | `feat(medication-compliance-rollups): writer and reader helpers` |
| `227eb69b` | `perf(medications-intake): consume compliance rollup tier` |
| `7657b848` | `test(medication-compliance-rollups): hook, reader, and tz parity` |
| `8e29c3ab` | `feat(medication-compliance-rollups): boot-time backfill queue` |

## Test delta

| Surface | Before | After |
|---|---|---|
| `src/lib/medications/__tests__/compliance-rollups.test.ts` | — | **+16 tests** (NEW) |
| `src/app/api/medications/intake/__tests__/route.test.ts` | 8 | **10** (+2 cases pinning the rollup read swap + live fallback) |
| `pnpm test src/lib src/app/api` aggregate | 3 530 | **3 547** (+17) |

## Self-review

- Re-read `compliance-rollups.ts` end-to-end after wiring: the writer
  handles 23-/25-hour DST days via `startOfDayUtcInTz(nextDayKey, …)`
  rather than a naive `+86_400_000`. Verified by inspection that
  Berlin fall-back at 2025-10-26 produces a 25-hour window and Berlin
  spring-forward at 2025-03-30 a 23-hour window.
- Empty-window case deletes the rollup row rather than leaving a
  stale `(scheduled, taken, skipped)` tuple from a now-deleted event.
- Bulk + import paths collapse per-row hooks to one recompute per
  distinct `(medicationId, dayKey)` pair so a 500-row batch costs at
  most ~20-50 rollup folds rather than 500.
- Coverage-probe fallback fires the boot-backfill enqueue in the
  background; current request still returns a byte-identical live
  response so no front-end can observe a hiccup during the
  cold-mount converge.
- Writer is best-effort wrapped in
  `recomputeMedicationComplianceForEvent` so a populator hiccup never
  rolls back the parent intake-event write.
- `git status` clean across all four commits; no W-MOOD / W-SUM /
  W-WMY / W-SINCE files staged.

## Performance expectation

Per the audit's §2.5 + §5 P4 estimate:

- Cold mount on `/api/medications/intake?scope=compliance`:
  **3.2 s → ~200 ms** on Marc's tenant once the boot backfill has
  converged. The dominant cost was a pool-stall on the unbounded
  event findMany; reading 7-30 indexed rows from the rollup tier
  collapses to a single millisecond-class query.
- Warm-cache hit (15-minute LRU) unchanged at < 50 ms.
- First request post-deploy is the live-fallback path (~3.2 s) until
  the worker boot's discovery enqueue folds the trailing 90 days;
  subsequent requests land on the rollup tier.

## Deferred

- **`health-score-fast-path.ts` consumer integration** — out of
  scope for W-MED per task directive (collision with W-WMY). The
  per-active-medication × intake-event fan-out inside
  `computeUserHealthScoreFastPath` (`health-score-fast-path.ts:267-303`)
  still pays the live cost. Follow-up phase (v1.4.40 or W-MED-2)
  should swap that branch onto `readMedicationCompliance` for the
  same tier reuse. Estimated saving: 1-2 s on the analytics full-slice
  cold path.
- **Per-user-tz bucketing for non-Berlin tenants** — `day` is
  string-anchored to the user's tz, which already removes the
  `isNearUtc(userTz)` blocker that gates the measurement-rollup
  fast-paths. No additional v1.5 work needed on the medication
  tier specifically.
- **WEEK / MONTH / YEAR compliance rollups** — Marc's audit
  (§2 + §5 P6) flags that no consumer reads multi-granularity
  buckets yet; the medication tier follows the same shape, daily
  granularity only. Future quarter-window analytics could fold the
  WEEK/MONTH/YEAR tier off the daily ledger.

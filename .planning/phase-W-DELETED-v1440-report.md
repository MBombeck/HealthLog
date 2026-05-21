# Phase W-DELETED — v1.4.40 — Soft-delete invisibility across every reader tier

## Goal

Close Senior Infra+DB audit **Critical Finding #3** (`.planning/round-v1439-arch-qa-infra-db.md`): `Measurement.deletedAt` was set by the iOS sync path but ignored by every read path. Once iOS soft-deletes its first reading, the tombstoned row would still contribute to dashboards, analytics fan-outs, the rollup populator's count, and the Coach snapshot the model grounds against.

## Inventory — read paths in scope of this phase

| File | Read shape | Action |
|---|---|---|
| `src/lib/measurements/rollups.ts` | `runRollupAggregate` SQL (DAY/WEEK/MONTH/YEAR rebuilds), `isRollupFresh` findFirst, `ensureUserRollupsFreshImpl` findFirst, boot-backfill discovery SQL | Added `AND m."deleted_at" IS NULL` to both branches of the aggregate, `deletedAt: null` to the two `findFirst` watermark probes, and `WHERE m."deleted_at" IS NULL` to the discovery's measurements scan |
| `src/lib/measurements/rollup-coverage.ts` | `probeRollupCoverage` discovers which types the user has logged | Added `AND "deleted_at" IS NULL` so tombstoned-only types stop demanding coverage and pushing reads onto the live aggregator |
| `src/lib/analytics/summaries-slice.ts` | 4× `$queryRaw` (narrow + DISTINCT ON latest, mirrored across the rollup-fresh and cold-fallback branches) | Added `AND m."deleted_at" IS NULL` to all four. The DAY-bucket aggregate read from `measurement_rollups` is unaffected — it inherits the writer-side filter |
| `src/lib/analytics/correlations-fast-path.ts` | `fetchSeriesChunked` cursor-paged findMany | Added `deletedAt: null` to the where clause |
| `src/lib/analytics/bp-in-target-fast-path.ts` | `fetchSeriesChunked` cursor-paged findMany | Added `deletedAt: null` to the where clause |
| `src/lib/analytics/health-score-fast-path.ts` | 3× `prisma.measurement.findMany` (WEIGHT source attribution, WEIGHT live-fallback series, BLOOD_PRESSURE_SYS source attribution) | Added `deletedAt: null` to each |
| `src/lib/insights/comprehensive-aggregator.ts` | 8× `FROM measurements m` (window_stats CTE + main aggregate + DISTINCT ON latest + firstAt probe, mirrored across rollup-fresh + cold-fallback) + 1× `fetchBpRawRows` findMany | Added `AND m."deleted_at" IS NULL` to all 8 SQL filters + `deletedAt: null` to the BP findMany |
| `src/app/api/dashboard/summary/route.ts` | `latestIn7d` DISTINCT ON SQL, `allTime` groupBy, `streakDays` SQL | Added `AND m."deleted_at" IS NULL` to the two raw queries + `deletedAt: null` to the groupBy. `sparkBuckets` reads from `measurement_rollups` (writer-side filter) |
| `src/app/api/measurements/route.ts` | Shared `where` builder used by main findMany + count + groupBy=day; dayKey drill-down findMany; rollup-coverage day-count probe; live `date_trunc` aggregate | Added `deletedAt: null` to the shared `where` (inherits across all consumers), to the drill-down `findMany`, and `AND m."deleted_at" IS NULL` to the two raw SQL clauses |
| `src/app/api/measurements/series/route.ts` | 3× findMany (BP_SYS / BP_DIA pair + single-type) | Added `deletedAt: null` to all three |
| `src/lib/ai/coach/snapshot.ts` | Consolidated `prisma.measurement.findMany` over the active metric types for the AI Coach prompt | Added `deletedAt: null` so tombstoned data never reaches the model |

## NOT touched (owned by other agents)

- `src/app/api/analytics/route.ts` (W-POOL)
- `src/app/api/insights/**` (W-INSIGHTS) — `cards/route.ts`, `generate/route.ts`, `targets/route.ts`, `comprehensive/route.ts`
- `src/lib/insights/features.ts` (W-INSIGHTS — actively modifying for the mood-rollup swap)
- `src/lib/insights/glp1-plateau.ts`, `pulse-status.ts` (W-INSIGHTS engine helpers — left for that agent to filter when they re-touch)
- `src/app/api/sync/state/route.ts` (already filters per the audit)
- Read-only export / admin / doctor-report / gamification / reminder-worker / pr-detection-worker / withings paths (out of scope for the audit's critical finding; deferred to W-DELETED v1.4.41 if needed — they don't affect the user-facing dashboard or analytics surfaces)

## File path was non-existent

`src/app/api/measurements/timeline/route.ts` — no such route in the codebase. The dispatch file-set name was prospective.

## Test matrix

`tests/integration/measurement-soft-delete.test.ts` pins three end-to-end contracts against the Postgres testcontainer (all three pass):

| Tier | Fixture | Assertion |
|---|---|---|
| Analytics summaries slice | 3× WEIGHT readings (80.0 / 99.0 / 80.2). Soft-delete the 99.0 sentinel. | `GET /api/analytics?slice=summaries` returns `WEIGHT.count == 2`, `latest == 80.2`, `min == 80.0`, `max == 80.2`, `mean == 80.1`. If the tombstone leaked, `max` would explode to 99.0. |
| Dashboard summary | 2× WEIGHT readings (80.0 1d ago + 99.0 6h ago). Soft-delete the 99.0. | `GET /api/dashboard/summary` returns the WEIGHT tile with `latestValue == 80.0`, `allTimeCount == 1`. If the tombstone leaked, `latestValue` would be 99.0. |
| Rollup recompute | 3× same-day WEIGHT readings (80.0 / 99.0 / 80.4). Soft-delete the 99.0. Call `recomputeBucketsForMeasurement`. | Resulting DAY rollup bucket has `count == 2`, `mean == 80.2`, `min == 80.0`, `max == 80.4`. If the tombstone leaked, `count == 3` and `mean ≈ 86.5`. |

Targeted unit tests: 454/454 passing across `src/lib/measurements`, `src/lib/analytics`, `src/lib/insights/__tests__/comprehensive-aggregator.test.ts`, `src/app/api/dashboard`, `src/app/api/measurements`.

Full unit suite: 4731/4737 passing; the 5 failures live in `src/lib/insights/__tests__/features.test.ts` and are caused by W-INSIGHTS' in-flight mood-rollup swap — confirmed unrelated to this phase by stashing their `features.ts` changes and re-running (test passes).

Lint: 1 error in `src/app/page.tsx` shipped by W-RSC's Suspense-boundary commit — unrelated.

Typecheck: clean.

## Commits (atomic, on `develop`)

- `db2d864a` — `fix(rollups): skip soft-deleted measurements in DAY recompute`
- `f0a0551a` — `fix(rollups): filter deletedAt in measurement-rollup readers`
- `1f490410` — `fix(summaries-slice): exclude soft-deleted measurements`
- `37342744` — `fix(correlations,bp-fast-path,health-score): exclude soft-deleted measurements`
- `c47b7dad` — `fix(comprehensive-aggregator): exclude soft-deleted in raw aggregate`
- `1bcaae47` — `fix(dashboard-summary): exclude soft-deleted in sparkline and streak queries`
- `97920f0f` — `fix(measurements-route,series,timeline): exclude soft-deleted in list reads`
- `55fefb1d` — `test(integration): pin soft-delete invisibility across analytics, dashboard, rollup tiers`

(`1bcaae47` was inflated by the openapi pre-commit hook to also carry an unrelated `notifications/status` route + test from another agent; the dashboard-summary diff stands on its own.)

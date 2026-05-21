# v1.4.40 QA — Simplification Findings

Reviewed `git log --oneline v1.4.39.4..develop` (55 commits across 11
waves). Focus on what the parallel waves missed: orphan stubs, naming
drift, dead exports still around, near-duplicate code, and bare-array
queryKeys that slipped past W-RSC's factory migration.

No automated edits were applied — every candidate either touches
multiple wave outputs (deserves a cross-wave reconcile), intersects a
v1.5 contract anchor flagged in the wave reports, or is large enough
that Marc's voice in the commit message matters.

## Suggested removals

- `/Users/marc/Projects/HealthLog/src/lib/rollups/measurement-read-cumulative.ts:54` — `isCumulativeType` — exported, tested, still no production caller after the umbrella move. Carried forward unchanged from the v1.4.39 simplifier backlog. Confidence: certain.
- `/Users/marc/Projects/HealthLog/src/lib/rollups/measurement-read-cumulative.ts:83` — `readCumulativeDaySums` — exported + tested, no production caller. Same v1.4.39 carry-forward. Confidence: certain.
- `/Users/marc/Projects/HealthLog/src/lib/rollups/measurement-read-cumulative.ts:117` — `resolveBucketSum` — exported + tested, no production caller. The `dashboard/summary/route.ts:441` nested ternary still re-implements the same shape inline. Confidence: certain.
- `/Users/marc/Projects/HealthLog/src/lib/rollups/measurement-read-wmy.ts:125,137,149` — `readWeekRollups` / `readMonthRollups` / `readYearRollups` — only the wmy test file imports them; the production `readBestGranularityRollups` walker uses the internal `readGranularity`. Either downgrade to non-exported helpers or inline into the tests. Confidence: certain.
- `/Users/marc/Projects/HealthLog/src/lib/analytics/summaries-slice.ts:659` — `computeLongWindowSummary` — only the file's own test suite imports it. Flagged for v1.5 multi-year-card wiring in the v1.4.40 backlog (F-M-01); still ships as dead code in `develop`. Confidence: certain.
- `/Users/marc/Projects/HealthLog/src/lib/rollups/medication-compliance-rollups.ts:469` — `ensureUserMedicationComplianceFresh` — the boot-backfill cascade fully owns the cold-mount path; the "kept for symmetry" wrapper has no real caller. v1.4.39 carry-forward. Confidence: certain.
- `/Users/marc/Projects/HealthLog/src/lib/rollups/mood-rollups.ts:177` — `tx?: PrismaTxOrClient` parameter on `recomputeMoodRollupForEntry` is still unused by every call site (audited 19 references — none pass `tx`). Backlog item F-M-02 from v1.4.39 reconcile. Confidence: certain.
- `/Users/marc/Projects/HealthLog/src/lib/rollups/medication-compliance-rollups.ts:159,250` — `tx?: PrismaLike` parameter on `recomputeMedicationComplianceForEvent` + `recomputeUserMedicationCompliance` likewise dead at every call site. Confidence: certain.

## Suggested dedups

- `/Users/marc/Projects/HealthLog/src/app/api/medications/intake/route.ts:94-187` ↔ `/Users/marc/Projects/HealthLog/src/app/api/dashboard/summary/route.ts:295-387` — the entire "find active medications → `expandTodayIntakes` → diff against existing → `createMany skipDuplicates` → fan-out `recomputeMedicationComplianceForEvent` per distinct `(medication, dayKey)`" block is replicated near-verbatim across both routes (W-RSC's audit-L4 hook gap closure shipped the rollup recompute fan-out in both files but did not extract the shared helper). Both files even share the "v1.4.40 — close the compliance-rollup hook gap from v1.4.39.4" comment. Suggested action: extract `projectTodayIntakesAndRecompute(userId, userTz, todayStart, todayEnd)` into `src/lib/medications/scheduling/today-projection.ts` and have both routes call it. Drift here is a real failure mode — the v1.4.39 intake-route projection landed without a matching dashboard hook, which is the bug audit-L4 had to chase.
- `/Users/marc/Projects/HealthLog/src/components/charts/mood-chart.tsx:142` ↔ `/Users/marc/Projects/HealthLog/src/components/charts/health-chart.tsx:261` — `movingAverageByPoints` is byte-identical across the two chart components. W-GHOSTS removed the lib-level `movingAverage` (29bfcc67) because nothing consumed the windowed-by-points variant; both chart files carry their own private copy. Suggested action: extract a shared `src/lib/charts/moving-average.ts` with two functions (`byPoints` + the un-windowed reducer) so a future "switch from MA-7 to EMA-7" lands in one place. Pure helper, deterministic, trivial to unit-pin.
- `/Users/marc/Projects/HealthLog/src/components/charts/mood-chart.tsx:162` (`buildTrendLine`) — only used inside mood-chart today, but the health-chart `computeTrendLine` neighbour does the same linear-regression-over-day-offset math against the same date/value pair shape. Suggested action: lift `buildTrendLine` to `src/lib/charts/trend-line.ts` alongside the moving-average extract above; converge the health-chart variant in a follow-up so both consumers stay byte-stable. Confidence: medium — a quick side-by-side diff should confirm whether the two are line-for-line identical or merely shape-compatible.

## Suggested simplifications

- **queryKey factory carry-forward** — W-RSC migrated `app/page.tsx`, the three chart components, `use-auth`, and the insights pages but ~50 bare-array `queryKey: [...]` literals remain across `src/components/settings/*`, `src/app/notifications/page.tsx`, `src/app/auth/login/page.tsx`, `src/app/medications/page.tsx`, `src/components/medications/*`, `src/app/targets/page.tsx`, etc. The factory-bypass guard test (`src/lib/__tests__/query-keys.test.ts`) only walks `src/components/charts`, `src/app/page.tsx`, and `src/hooks/use-auth.ts`. Recommendation: in a follow-up minor (v1.4.40.1 or v1.4.41 backlog) widen the factory walker to all of `src/app` + `src/components` and either migrate the bare arrays or extend `queryKeys` with `notifications.preferences()`, `auth.login()`, `passkeys()` (already there), `settings.global()`, etc. The audit-H1 + audit-L4 class of bugs the v1.4.40 marathon chased was exactly factory drift — the work is half done.
- **Rollup directory naming** — the seven files in `src/lib/rollups/` split into two patterns: writers (`measurement-rollups`, `mood-rollups`, `medication-compliance-rollups`) and readers (`measurement-read`, `measurement-read-wmy`, `measurement-read-cumulative`, `measurement-coverage`). The mood + medication paths have no equivalent reader file because their read logic lives in the analytics routes. Suggested action: either rename the writers to `<entity>-write` (so the convention is `<entity>-<role>`) or accept the asymmetry and add a one-line module comment to each writer explaining the read side lives in `app/api/<entity>/...`. The current state confuses the "where do I add the next reader?" question.
- `/Users/marc/Projects/HealthLog/src/app/api/dashboard/summary/route.ts:441` — the cumulative-vs-spot `useSum ? (row.sum_value !== null ? Number(row.sum_value) : Number(row.mean) * Number(row.count)) : Number(row.mean)` nested ternary still lives where the v1.4.39 simplifier flagged it. CLAUDE.md forbids nested ternaries. Once the four `measurement-read-cumulative.ts` dead exports above are either wired or removed, this is the call site that should be reading `resolveBucketSum(row)`.
- `/Users/marc/Projects/HealthLog/src/lib/rollups/measurement-rollups.ts` boot-backfill discovery `UNION` over `r2."sum_value" IS NULL` — the legacy-NULL backfill arm is still live after the v1.4.39 single-tenant convergence. Backlog F-M-03 (v1.4.39 → v1.4.40 carry-forward) flags this for either a partial-index add or removal. Marc's tenant has converged; safe to schedule the arm for removal in v1.4.41 + add a TODO with the cut-off date.

## Applied

None. Every candidate above either:

1. Intersects a test contract (`measurement-read-cumulative.test.ts`, `measurement-read-wmy.test.ts`, `summaries-slice.test.ts`) that should be migrated in lockstep so the deletion lands green CI without a separate "drop dead test" commit.
2. Pairs with a v1.5 wiring intent Marc signed off on in the wave reports (computeLongWindowSummary → multi-year-card, cumulative readers → analytics-route batch path).
3. Is a cross-file dedup (the medication today-projection block, the moving-average extract) whose target module needs Marc's naming input before the move.

Listing as suggestions keeps Marc's voice in the eventual commit messages and lets the reconcile decide which carry-forwards land in v1.4.40 vs the v1.4.41 backlog.

## Cross-check against marathon scope

- **W-INFRA umbrella move** — clean. `grep` for old `lib/measurements/rollup` / `lib/mood/rollups` / `lib/medications/compliance-rollups` returns zero callers; no orphan re-export stubs. Tests moved with the source files.
- **W-GHOSTS purge** — `movingAverage`, `weeklyAverages`, `mmolToMgdl`, `berlinDayKey`, `typesMissingCoverage`, `readCumulativeDaySumsBatch`, `TELEGRAM_CLEANUP_QUEUE`, `/api/medications/intake-summary`, `/api/monitoring/{umami,glitchtip}/test` all confirmed gone from `develop`. Prisma schema has no orphan indexes pointing at the deleted routes.
- **CHANGELOG.md** — single reference to "v1.4.40" is a forward-reference at line 185 ("v1.4.40 backlog"); no premature `## [1.4.40]` heading. Release endgame can land it cleanly.
- **Soft-delete test consolidation** — `tests/integration/measurement-soft-delete.test.ts` (310 LOC, W-DELETED) is the single coordinating test; the per-tier `analytics`, `dashboard`, `rollup` assertions live inside one file. No fragmentation found.
- **`prisma/migrations/0074_v1440_consent_receipts`** — additive only, idempotent guards mirror 0067/0070/0071, includes the FK + index. Clean.

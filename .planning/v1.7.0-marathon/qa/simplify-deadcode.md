# v1.7.0 — Simplification + dead-code review

Scope: `git diff main..release/v1.7.0` (174 files, +17 490 / −1 363). READ-ONLY review.
Tooling: `pnpm knip` (clean except one item), targeted grep/read across the ~8-agent boundaries.

## Severity counts

| Severity | Count |
|---|---|
| High | 0 |
| Medium | 2 |
| Low | 3 |
| Info / verified-clean | 6 |

No correctness or High-severity findings. The diff is unusually clean for an 8-agent
release: new modules are all wired, no console.* noise, no commented-out code, no orphan
files, and the v1.4.37 "unregistered queue ships silently" lesson was heeded.

---

## MEDIUM

### M1 — Dead export: `DestructiveZoneSection` (knip-confirmed)
`src/components/medications/sections/destructive-zone-section.tsx:451`
The v1.7.0 rework (`95a75c62`) split the section into `<LifecycleManageBody>` and
`<DangerZoneBody>` so `<AdvancedSettingsSheet>` can slot them under separate groups. The
old composing wrapper `DestructiveZoneSection` (+ its `DestructiveZoneSectionProps` at
:56) was left behind "for any caller that wants the bundled shape" (per the file's own
header comment, lines 6–12). knip confirms zero importers; the only matches in the repo
are the export site, its props interface, and the self-referential comment.
- **Dead, safe to delete** — both `DestructiveZoneSection` and `DestructiveZoneSectionProps`.
  This is exactly the "no backwards-compat shims for hypothetical callers" DO-NOT in CLAUDE.md.
  Recommendation: remove the wrapper + props; keep `LifecycleManageBody` / `DangerZoneBody`.

### M2 — Third copy of the per-user-day "consolidation drain" shape
`src/lib/measurements/consolidate-daily-mean.ts` (new) vs the pre-existing
`src/lib/measurements/drain-per-sample-cumulative.ts` and
`src/lib/measurements/consolidate-legacy-steps.ts`.
The new mean-consolidation module re-implements the same scaffolding the other two
already carry:
- `MEAN_CONSOLIDATION_CUTOFF_HOURS = 36` (:65) duplicates `DRAIN_CUMULATIVE_CUTOFF_HOURS = 36`
  in drain-per-sample-cumulative.ts (:55) — same magic constant, separate declaration.
- `MeanConsolidationBucket` / `MeanConsolidationSummary` / `MeanConsolidationOptions`
  (:70 / :85 / :96) mirror the `Drain*` and `Step*` triples field-for-field, including the
  identical `dryRun?` + `log?` "Logger sink — defaults to console.log" option pattern.
- The `stats:`-prefix overwrite-drain + per-user-timezone day bucketing logic is the same
  algorithm in all three.
The new module *does* correctly re-import the shared primitives it can (`PerSampleRow`,
`bucketRowsByUserDay`, the day-window helpers from drain-per-sample-cumulative.ts), so this
is partial duplication, not a clean-room re-write.
- **Genuine simplification, not just style, but NOT safe as a blind delete** — behaviour
  differs (mean vs sum vs step-sum aggregation). Recommendation: extract the shared
  `Options` shape (`dryRun` + `log` sink), the `*_CUTOFF_HOURS = 36` constant, and a generic
  `Bucket`/`Summary` base into one `consolidation-common.ts` and have all three drains
  parameterise on the aggregator function. Low risk because all three are job-only, fully
  unit + integration tested. Defer-able to a follow-up if the release window is tight.

---

## LOW

### L1 — `ScheduleType` closed set declared twice
`src/lib/validations/medication.ts:169` hardcodes `z.enum(["SCHEDULED","PRN","CYCLIC"])`
while `src/lib/medications/scheduling/recurrence.ts:55` declares
`export type ScheduleType = "SCHEDULED" | "PRN" | "CYCLIC"`. Same closed set, two
representations that can drift independently (add a 4th type and only one updates).
- **Style/safety, safe** — derive the zod enum from a shared `const SCHEDULE_TYPES =
  ["SCHEDULED","PRN","CYCLIC"] as const` exported once (e.g. from recurrence.ts), then
  `z.enum(SCHEDULE_TYPES)` and `type ScheduleType = (typeof SCHEDULE_TYPES)[number]`.

### L2 — `120_000` poll interval literal duplicated across two query hooks
`src/lib/queries/use-dashboard-snapshot.ts:50` and
`src/lib/queries/use-analytics-query.ts` both hardcode `refetchInterval: 120_000` +
`refetchIntervalInBackground: false`. The two are mutually exclusive at the call site
(`page.tsx` gates analytics with `enabled: !snapshotEnabled`), so there is NO redundant
double-poll — verified. But the magic interval lives in two places.
- **Style, safe** — a shared `OPEN_PAGE_POLL_MS = 120_000` const would keep them in lockstep.
  Cosmetic; leave if the release is tight.

### L3 — `MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE` defined inline in the worker
`src/lib/jobs/reminder-worker.ts:277` declares the queue name as a local `const` string,
whereas the sibling new queues (`INSIGHT_PREGENERATE_QUEUE`, `MEAN_CONSOLIDATION_QUEUE`)
export their name constant from their own job module
(`src/lib/jobs/measurement-tombstone-cleanup.ts` does not export the queue name).
Asymmetric with the established one-constant-per-job-module convention.
- **Style, safe** — move the literal into `measurement-tombstone-cleanup.ts` as an export
  and import it, matching the other two. It IS correctly registered in `allQueues` (:~1983),
  so no behaviour bug — purely convention drift.

---

## INFO — verified clean (explicitly checked, no finding)

- **Legacy `expandTodayIntakes` walker**: GONE. Zero references anywhere in `src/`
  (already removed before v1.7.0 by the read-flip). `todays-dose-card.tsx` and `DoseUnit`:
  no files / no references. Nothing to delete.
- **Glucose maps**: NOT duplicated. FHIR `GLUCOSE_LOINC` (subtype→LOINC code map) and
  `convertGlucose`/`resolveGlucoseUnit` come from the shared `@/lib/glucose` module — the
  builder imports them rather than re-deriving mg/dL↔mmol/L. No second conversion path.
- **Unit conversion (W7 valueScale vs FHIR)**: NOT overlapping. `display-transform.ts` only
  scales WALKING_SPEED (m/s→km/h) and WALKING_RUNNING_DISTANCE (m→km) at the render layer.
  The FHIR builder's only inline conversion is sleep minutes→hours (`value/60`,
  build-bundle.ts:156) and glucose via the shared helper. Different metrics, no duplicate logic.
- **Cluster / metric source lists**: single source of truth. `clusters.ts`
  (`CLUSTER_SOURCES`, `CLUSTER_PRIORITY`) is imported by `snapshot.ts`; snapshot does NOT
  re-declare its own source lists. The insights metric maps (`sub-page-metric.ts` slug→type,
  `metric-availability.ts` type union) are different concerns, not copies.
- **New job queues registered**: `INSIGHT_PREGENERATE_QUEUE`, `MEAN_CONSOLIDATION_QUEUE`,
  and `MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE` are all present in the worker's `allQueues`
  array and scheduled — the v1.4.37 "drain queue not registered, ships silently" failure
  mode is NOT repeated.
- **No leftover scaffolding**: zero `console.log/debug/info` in non-test diff (the two hits
  are the intentional `log` option sink defaulting to console.log, matching the existing
  consolidate-legacy-steps pattern). No commented-out code, no TODO/FIXME/HACK markers, no
  orphan files (build-bundle→export route, sync/cursor→sync route, kvnr→auth validation,
  snapshot-flag→page.tsx all wired). avatar.tsx `object-cover` change is a clean bugfix.

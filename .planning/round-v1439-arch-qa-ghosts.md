# Architecture QA — Ghost Paths + Dead Code

v1.4.39.3 read-only audit. 457 source files scanned, 914 unique top-level
exports, 182 API routes, 2 437 i18n keys, 51 Prisma indexes, ~30 pg-boss
queues. Findings below are reconciler-grade evidence (file:line +
zero-caller proof) — not stylistic cleanup.

## Findings

### Truly dead (recommend deletion — 0 callers anywhere)

- `src/lib/measurements/rollup-read-cumulative.ts:121` —
  `readCumulativeDaySumsBatch`. Only its own test references it; the live
  cumulative read path uses `readCumulativeDaySums` (singular).
- `src/lib/measurements/rollup-coverage.ts:77` — `typesMissingCoverage`.
  Never imported; the live fast-path guards use `isFullyCovered` (which
  *is* alive) or per-type `coverage.get(type)`.
- `src/app/api/medications/intake-summary/route.ts` — full GET handler.
  Only reference is `queryKeys.medicationIntakeSummary` in
  `src/lib/query-keys.ts:61` (never consumed in any `useQuery({queryKey:
  …})`). No `fetch("/api/medications/intake-summary")` anywhere.
- `src/app/api/monitoring/umami/test/route.ts` — superseded by
  `/api/admin/monitoring/umami-test` (the one the UI calls).
- `src/app/api/monitoring/glitchtip/test/route.ts` — same pattern;
  superseded by `/api/admin/monitoring/glitchtip-test`.
- `TELEGRAM_CLEANUP_QUEUE` ghost in `src/lib/jobs/reminder-worker.ts`
  (`const = "telegram-message-cleanup"` at line 164, handler at line
  1098, registered at line 1672, worker bound at line 1832). **No
  `boss.send(TELEGRAM_CLEANUP_QUEUE, …)` and no cron schedule**: the
  queue will receive zero jobs in production. Doc comment claims "the
  Telegram sender schedules cleanup", but `src/lib/notifications/
  senders/telegram.ts` and `src/lib/telegram.ts` never call `boss.send`.
- `src/lib/glucose.ts:18` — `mmolToMgdl` exported but never called
  (UI only converts mg/dL → mmol/L via `convertGlucose`; the reverse
  helper is dead).
- `messages/de.json` namespace `format.{dateShort,timeShort,dateTime}` —
  no `t("format.…")` consumer; `format-locale.ts` builds the patterns
  via `Intl.DateTimeFormat`, the literal strings in messages/de.json
  duplicate that intent and are stale. (Mirror keys in
  en/es/fr/it/pl.json.)

### Test-only (legit contract verification, no production caller)

- `src/lib/analytics/correlations.ts:126` — `weeklyAverages`. Charts have
  their own local `movingAverageByPoints`; production never imports
  `weeklyAverages`. Keep if the contract is intentional; otherwise prune.
- `src/lib/analytics/trends.ts:13` — `movingAverage` (test-only).
  `health-chart.tsx`/`mood-chart.tsx` define local
  `movingAverageByPoints`; the lib-level helper is parallel-implemented.
- `src/lib/analytics/trends.ts:119` — `detectAnomalies` (called only from
  `summarize` inside same file and from its test); no UI surface
  consumes anomaly counts.
- `src/lib/measurements/rollup-read-wmy.ts:125-149` — `readWeekRollups`,
  `readMonthRollups`, `readYearRollups`. Only the test file imports
  them; production uses `readBestGranularityRollups` (the dispatcher).
  These three are likely test fixtures left over from the v1.4.35 W-WMY
  scaffolding.
- `src/lib/analytics/berlin-day.ts:29` — `berlinDayKey`. Production
  switched to user-timezone `wallClockInTz` in v1.4.38; the legacy
  helper survives only behind its own test. Comment at
  `src/app/api/analytics/route.ts:185` confirms the legacy import was
  intentionally dropped.
- `src/lib/insights/prompt.ts:90` — `buildComparisonBlock`. Used inside
  the file (line 50) and its test; could be downgraded from `export` to
  non-export.

### Intentional v1.5 scaffolding (document, do not delete)

- `src/lib/analytics/summaries-slice.ts:615` —
  `computeLongWindowSummary`. Awaits v1.5 multi-year card. Tests only.
  Already flagged in the brief.

### Duplicate helpers

- `wallClockInTz` defined twice:
  - `src/lib/medications/compliance-rollups.ts:73`
  - `src/lib/medications/scheduling/cadence.ts:107`

  v1.4.39 QA simplifier already flagged this — consolidate into
  `src/lib/tz/format.ts` (which exports the canonical version). The two
  in-place definitions drift independently and increase the bug surface
  for the cross-tz ±3 h guard.

- `startOfUtcDay` defined twice:
  - `src/lib/measurements/rollups.ts:524`
  - `src/lib/mood/rollups.ts:620`

  Both have identical bodies. Promote one to a shared `src/lib/tz/`
  helper (or `src/lib/measurements/rollup-coverage.ts` — but a fresh
  `src/lib/tz/utc-day.ts` is cleaner).

### Orphaned API routes (no UI consumer)

- `/api/medications/intake-summary` (full handler, no fetch).
- `/api/monitoring/umami/test` (duplicate of admin variant).
- `/api/monitoring/glitchtip/test` (duplicate of admin variant).
- `/api/admin/import-apple-health-export`, `/api/admin/backup/test`,
  `/api/admin/drain-per-sample-cumulative` — operator-curl only, no UI
  button. Not strictly dead (documented as operator endpoints) but they
  are easy to mistake for orphans. Recommend doc-comment marker
  `@operator-only` so future audits skip them.

### Dead i18n keys

Approx. 139/2 437 keys (≈ 5.7 %) have no `t("…")` consumer when scanned
for last-segment or full-path string literals. Most are false positives
(computed keys like `medications.sideEffects.entries.${i18nKey(row)}`).
Confirmed orphans after manual spot-check:

- `format.dateShort`, `format.timeShort`, `format.dateTime` — date
  patterns duplicated in messages/de.json but the runtime uses
  `Intl.DateTimeFormat` directly. Same in en/es/fr/it/pl.

A second-pass scan with translator-aware AST (instead of plain grep) is
needed before any mass-prune. Recommend deferring to a follow-up run
with a Babel-based extractor.

### Unused indexes / columns

Spot-checked all 51 `@@index([…])` against grep of column names — every
index has at least one WHERE/ORDER consumer in `src/lib` or `src/app`.
No removable indexes found in this pass. Columns with `// legacy …` or
`// TODO(v1.5 iOS):` markers (cf. the schema review above) carry their
own justification and read paths.

### Long-standing TODOs

Clean. Only one TODO marker in production source
(`src/components/i18n/maintainership-banner.tsx:14`, and that's
documentation of a test invariant — not a deferred bug). One
`TODO(v1.5 iOS):` in `prisma/schema.prisma` (cross-source workout
dedup) is intentional pre-v1.5 reminder.

## Top 5 deletion candidates

Ranked by safety (zero-risk first) × impact (biggest cognitive-noise
reduction first):

1. **`/api/monitoring/umami/test` + `/api/monitoring/glitchtip/test`
   routes.** Both have admin-namespaced replacements that the UI
   already uses. Zero callers, zero test fixtures referencing them
   as live targets. Safest single deletion in this audit.
2. **`/api/medications/intake-summary` route.** Full GET handler with
   no `fetch()` caller and no `useQuery` consumer of its query key.
   Safe to delete; query-key entry in `src/lib/query-keys.ts:61` also
   removable as a tag-along.
3. **`TELEGRAM_CLEANUP_QUEUE` orphan in `reminder-worker.ts`.**
   Handler + register + worker binding for a queue that has no
   sender and no cron. Worst case it consumes a queue connection at
   boot; best case (after removal) the worker boot is one queue
   lighter and the operator-confusion footprint shrinks. Verify with
   the operator that the cleanup feature was never wired before
   removal — but it clearly isn't running today.
4. **`weeklyAverages`, `movingAverage`, `detectAnomalies`,
   `readWeekRollups`/`readMonthRollups`/`readYearRollups`,
   `readCumulativeDaySumsBatch`, `typesMissingCoverage`, `mmolToMgdl`,
   `berlinDayKey`.** 9 dead exports across `src/lib/analytics/` +
   `src/lib/measurements/` + `src/lib/glucose.ts`. Each one has a
   live sibling that's the production path. Delete the orphans (and
   their tests if the contract is no longer being verified
   elsewhere); keep `berlinDayKey` if Marc wants the legacy
   reference, downgrade the others.
5. **Duplicate `wallClockInTz` + `startOfUtcDay`.** Consolidate to
   `src/lib/tz/` (one source of truth). The cross-tz guard work in
   v1.4.38 hinges on these helpers staying in lock-step; today they
   drift independently because the two copies aren't even imports of
   each other.

(Bonus, not in top 5: prune the `format.{dateShort,timeShort,dateTime}`
i18n keys from messages/de.json + the 5 locale siblings, with the
caveat that locale tests pin key parity — adjust those tests first.)

## Process recommendation

The biggest accumulator of ghost code in this codebase has been the
"replace, but leave the legacy helper for one more release just in
case" pattern (v1.4.35 W-WMY scaffolding, v1.4.36 read-swap probe,
v1.4.38 W-F dashboard summary). Each marathon adds two helpers in
parallel; the deletion of the older one routinely slips because the
release has shipped and "no caller" is hard to prove during the next
marathon kick-off. **The fix is a pre-marathon `unused-exports` CI
job** (use `ts-prune` or `knip` — both work against `tsconfig.json` and
respect dynamic imports; knip additionally covers API routes and i18n
keys). Run it once on every release branch; route new findings into
the v1.x.y.z+1 backlog as triage items. That converts ghost-hunting
from a quarterly archaeology dig into a recurring 5-minute review,
and crucially gives the read-swap-then-delete pattern a finite
horizon: if it's still parallel after two releases, CI flags it.

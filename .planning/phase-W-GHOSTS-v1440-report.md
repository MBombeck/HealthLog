# Phase W-GHOSTS — Dead-code purge (v1.4.40)

Owner: W-GHOSTS. Ran in parallel with W-WMY-WIRE. Touch-disjoint
verified per commit; W-WMY-WIRE's in-flight diffs were never staged.

## Deletions landed

Nine atomic commits on `develop` (oldest → newest):

| Commit    | Subject                                                                                  | Net   |
| --------- | ---------------------------------------------------------------------------------------- | ----- |
| 0ec4a993  | chore(jobs): remove dead TELEGRAM_CLEANUP_QUEUE handler and registration                 | -44   |
| 2b4e2177  | chore(routes): remove orphan /api/medications/intake-summary endpoint                    | -107  |
| 2bff80aa  | chore(routes): remove duplicate /api/monitoring/{umami,glitchtip}/test endpoints         | -550  |
| 9df23c3c  | chore(analytics): drop unreferenced movingAverage and weeklyAverages exports             | -173  |
| 75607e4c  | chore(measurements): drop unreferenced typesMissingCoverage / readCumulativeDaySumsBatch | -119  |
| f3a4da50  | chore(glucose,berlin-day): drop unreferenced mmolToMgdl and berlinDayKey exports         | -86   |
| e26e27b5  | chore(i18n): drop dead format.dateShort timeShort dateTime keys across six locales       | -99   |
| 79c86a06  | refactor(tz): consolidate startOfUtcDay into src/lib/tz/start-of-utc-day.ts              | -1    |
| cd8277d3  | refactor(tz): consolidate wallClockInTz into src/lib/tz/wall-clock.ts                    | +2    |

Net source lines removed: ≈ 1 177.

### TELEGRAM_CLEANUP_QUEUE (commit 0ec4a993)

`src/lib/jobs/reminder-worker.ts` — dropped:

- `const TELEGRAM_CLEANUP_QUEUE = "telegram-message-cleanup"` (was line
  164)
- `interface TelegramCleanupPayload` (was line 281)
- `async function handleTelegramCleanup` (was line 1098)
- The entry in `allQueues` (was line 1672)
- The `boss.work<TelegramCleanupPayload>(TELEGRAM_CLEANUP_QUEUE, …)`
  bind (was line 1832)

Zero `boss.send(TELEGRAM_CLEANUP_QUEUE, …)` callers anywhere — the
queue would have received zero jobs in production. `deleteMessage`
from `@/lib/telegram` is still imported because the live moodlog-mood
deletion path at `:379` uses it.

### /api/medications/intake-summary (commit 2b4e2177)

- Deleted `src/app/api/medications/intake-summary/route.ts`
- Removed `medicationIntakeSummary` from the queryKey factory in
  `src/lib/query-keys.ts:90`
- Removed the corresponding entry from `medicationDependentKeys`
  (would have invalidated a never-rendered key)
- Cleaned a stale doc reference in `medication-intake-quick-add.tsx`

### /api/monitoring/{umami,glitchtip}/test (commit 2bff80aa)

Deleted both routes plus their `__tests__/route.test.ts` files. The
admin UI calls the `/api/admin/monitoring/{umami,glitchtip}-test`
counterparts via `umami-section.tsx:41` and `glitchtip-section.tsx:38`
respectively — those routes remain untouched.

### 9 dead exports — 7 deleted, 2 kept

Deleted (with their dedicated tests where they existed):

- `movingAverage` (`src/lib/analytics/trends.ts`) — `health-chart.tsx`
  and `mood-chart.tsx` implement their own `movingAverageByPoints`
  locally; the lib helper had no production consumer.
- `weeklyAverages` (`src/lib/analytics/correlations.ts`) — only the
  unit test consumed it. The Berlin-tz `BERLIN_DATE_PARTS` constant
  fell out as a tag-along since `weeklyAverages` was its only reader.
- `typesMissingCoverage` (`src/lib/measurements/rollup-coverage.ts`)
  — the rollup-fast-path probes coverage via `coverage.get(type)` or
  the all-or-nothing `isFullyCovered` helper.
- `readCumulativeDaySumsBatch`
  (`src/lib/measurements/rollup-read-cumulative.ts`) — only its own
  test referenced it; the live A2 path took the chunked per-type
  `findMany` route via `readCumulativeDaySums` (singular).
- `mmolToMgdl` (`src/lib/glucose.ts`) — UI only converts mg/dL →
  mmol/L for display via `convertGlucose`; the reverse helper was
  unused.
- `berlinDayKey` (`src/lib/analytics/berlin-day.ts`) — every display
  surface migrated to `userDayKey(date, tz)` in v1.4.38. Whole module
  + dedicated test removed. Updated stale comments in
  `src/app/api/analytics/route.ts:212` and `src/lib/tz/format.ts`.

Kept (false positives — flagged as dead but live):

- **`detectAnomalies`** (`src/lib/analytics/trends.ts:119`) — the
  Ghost-Hunter audit listed it as "test-only", but `summarize()` in
  the same file calls `detectAnomalies(data).length` at line 260, and
  `summarize` is imported by `/api/analytics`, `/api/insights/cards`,
  `/api/insights/comprehensive`, `/api/insights/generate`,
  `/api/mood/analytics`, `/api/measurements/series`, and
  `src/lib/insights/features.ts`. Reachable transitively from the
  production read path — kept.
- **`ensureUserMedicationComplianceFresh`**
  (`src/lib/medications/compliance-rollups.ts:492`) — the
  W-GHOSTS brief listed it in the "DO NOT touch" set with the note
  that W-INSIGHTS is wiring it in parallel. Grep currently shows only
  the export definition; W-INSIGHTS' phase report references the
  recompute hook. Held per directive, deferred to a follow-up audit
  once both waves have settled.
- **`readWeekRollups` / `readMonthRollups` / `readYearRollups`**
  (`src/lib/measurements/rollup-read-wmy.ts:125-149`) — explicitly
  excluded from this wave per the brief (W-WMY-WIRE was wiring them
  during this run).

### Dead i18n keys — `format.{dateShort,timeShort,dateTime}` × 6 locales

Removed the `format` namespace block from `messages/de.json`,
`messages/en.json`, `messages/es.json`, `messages/fr.json`,
`messages/it.json`, `messages/pl.json`. Deleted the dedicated pinning
test at `src/lib/i18n/__tests__/format-locale-order.test.ts` — it was
the only consumer of those keys.

Verified the locale-parity tests under `src/__tests__/i18n-drift-guard.test.ts`
and `src/lib/i18n/__tests__/fallback-chain.test.tsx` still pass. They
do not walk a hard-coded key list — they assert structural parity per
locale, so the synchronous removal across all six bundles keeps them
green.

### Duplicate helpers consolidated

#### `startOfUtcDay` → `src/lib/tz/start-of-utc-day.ts` (new file, commit 79c86a06)

The byte-identical helper that lived as a private function in:

- `src/lib/measurements/rollups.ts:524` (removed)
- `src/lib/mood/rollups.ts:620` (removed)

now lives once at `src/lib/tz/start-of-utc-day.ts`. Both callers
import `{ startOfUtcDay } from "@/lib/tz/start-of-utc-day"`. The
function body, public contract, and call sites are unchanged.

#### `wallClockInTz` → `src/lib/tz/wall-clock.ts` (new file, commit cd8277d3)

Two file-local copies with diverging return shapes:

- `src/lib/medications/compliance-rollups.ts:73` returned only
  `{year, month, day}` and required `tz: string`.
- `src/lib/medications/scheduling/cadence.ts:107` returned the full
  `{year, month, day, hour, minute, second, weekday}` tuple and
  accepted `tz: string | undefined`.

Canonical version returns the full tuple (super-set), accepts
`tz: string | undefined`, and lives in `src/lib/tz/wall-clock.ts`.
`compliance-rollups.ts` destructures the three fields it needs at
line 172 (`parts.year`, `parts.month`, `parts.day`) so the existing
call site stays one line. The cross-tz ±3 h guard now reads from a
single helper instead of two siblings that could drift.

Two additional `wallClockInTz`-named helpers exist in
`@/lib/tz/format.ts` (`wallClockParts`) but those carry a different
signature (returns string-typed parts) and a different responsibility
(formatting). Out of scope for this consolidation — and the brief
called for the two `medications/`-folder copies specifically.

## False positives kept (re-stated, single list for the auditor)

| Symbol                                | Why kept                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| `detectAnomalies`                     | Transitively used by `summarize()`, which the analytics / insights / measurements-series routes consume |
| `ensureUserMedicationComplianceFresh` | Brief excludes it; W-INSIGHTS wiring claim pending verification |
| `readWeekRollups` etc.                | Brief excludes them; W-WMY-WIRE is the consumer wave            |

## Quality gates

- `pnpm typecheck` clean at every commit (verified after each).
- Targeted vitest sweep across 75 test files (1 037 tests, 1 skipped)
  passed after the last commit.
- `pnpm lint` flags a pre-existing `react-hooks/preserve-manual-memoization`
  error in `src/app/page.tsx:577` (commit 3cacfcf9, untouched by this
  wave) — not introduced here.

## Cross-wave drift observed

W-WMY-WIRE landed `summaries-slice.ts`, `health-score-fast-path.ts`,
and `health-score-fast-path.test.ts` edits mid-run. None of those files
overlap with the W-GHOSTS touch list; each pre-commit was preceded by
`git status` and a targeted `git add` of only the W-GHOSTS files. One
race (between `0ec4a993` and `24568c80`) briefly mis-attached the
intake-summary deletion to a W-WMY-WIRE commit message — the commit
that actually carries the intake-summary deletion in HEAD is
`2b4e2177` and is correctly titled. No data loss.

## Tag-along cleanup

- `src/app/api/analytics/route.ts:212` — comment updated to reflect
  the `berlinDayKey()` retirement.
- `src/lib/tz/format.ts:124` + `:157` — same.
- `src/components/dashboard/medication-intake-quick-add.tsx:61` —
  removed the dead "intake-summary" entry from the doc-comment list of
  invalidated query keys.

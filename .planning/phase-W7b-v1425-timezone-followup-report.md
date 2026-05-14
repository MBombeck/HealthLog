# v1.4.25 W7b — per-user timezone follow-up (4 deferred surfaces) — report

Status: shipped on `develop`. Not pushed. Not tagged. No
`CHANGELOG.md` / `package.json` touch.

The W7 wave (commit `7a27390` … `a0dffbd`) shipped the per-user timezone
schema, resolver, and the easy display surfaces (export, doctor-report
PDF, profile picker, admin default). Four surfaces stayed on Berlin:
the `berlinDayKey()` callers, the chart x-axis tick labels, the Coach
snapshot day buckets, and the `MoodEntry.date` column. W7b closes
those.

## Per-surface commit SHAs

| Surface | SHA       | Summary                                                |
| ------- | --------- | ------------------------------------------------------ |
| 1       | `35f068a` | `berlinDayKey()` callers honour user `displayTimezone` |
| 2       | `eeaa563` | Chart x-axis ticks render in user `displayTimezone`    |
| 3       | `7d878c1` | Coach snapshot anchors yesterday/this-week to user tz  |
| 4       | `989243a` | `MoodEntry.tz` column for per-row tz attribution       |
| —       | `2bdfdc2` | Prettier across W7b surfaces                           |

## Surface 1 — `berlinDayKey()` 5 callers

Four routes (`dashboard/summary`, `medications/intake`, `analytics`,
`insights/targets`) and the private copies of `berlinDayKey()` inside
those routes now read `userTz` from the authenticated `User` and pass
it through `userDayKey()` from `src/lib/tz/resolver.ts`. The
analytics route also threads `userTz` into the helpers it calls
(`computeSleepStageBreakdown`, `computeCorrelationHypotheses`).

The aggregation logic is unchanged — only the bucket-key function
swapped from `berlinDayKey(date)` to `userDayKey(date, userTz)`.
Existing Berlin users see no behaviour change (Europe/Berlin is the
schema default for `User.timezone`).

Integration test extended with a two-case Auckland assertion (commit
`35f068a`): the `userDayKey()` boundary case (13:00 UTC May 14 →
`2026-05-15` Auckland vs `2026-05-14` Berlin) and the dashboard
summary route returning a non-zero streak for an Auckland account
with three consecutive Auckland-day measurements.

## Surface 2 — Chart x-axis prop threading

Four chart components (`HealthChart`, `MoodChart`,
`MedicationComplianceChart`, `ComplianceLineChart`) gained a
`userTimezone?: string` prop defaulting to `"Europe/Berlin"`. Inside
each chart the X-axis tick formatter, tooltip date label, and per-day
bucketing all run through a tz-aware `makeFormatters(locale, userTz)`
instance instead of the legacy `formatDateShort()`.

Mount sites that already pull `useAuth()` pass `user?.timezone`:

- `src/app/page.tsx` (dashboard — 7 chart instances)
- `src/components/insights/trends-row.tsx` (3 mini charts)
- `src/components/insights/recommendation-card.tsx` (1 mini)
- `src/components/insights/insight-advisor-card.tsx` (inline charts)

Ad-hoc usages without a user (storybook-style, test harnesses) keep
the legacy Europe/Berlin rendering bit-for-bit thanks to the
`'Europe/Berlin'` default. The TanStack Query cache key for the
HealthChart's data fetch gains `userTimezone` so a tz change inside a
session re-buckets correctly.

Tests: 109 chart-component unit tests stay green.

## Surface 3 — Coach snapshot

`src/lib/ai/coach/snapshot.ts` previously bucketed by UTC
(`utcDayKey`, `utcWeekday`, `isoWeekKey`). It now:

- Reads `User.timezone` alongside `User.coachPrefsJson` in the same
  query (no extra DB round-trip).
- Threads `userTz` through every bucketing helper (`dailyMeans`,
  `bucketWeekly`, `buildDailyValueRows`, `buildDailyBpRows`) and
  through the medication-compliance day roll-up + Apple Health
  additive blocks.
- Renames `utcDayKey` → `tzDayKey(date, tz)`, `utcWeekday` →
  `tzWeekday(date, tz)`, `isoWeekKey` → `isoWeekKey(date, tz)`.

The prompt-budget calculator (`src/lib/ai/coach/budget.ts`) is
**unaffected**. The ledger still uses UTC midnight for spend
roll-over because the operator's LLM bill cycles on UTC; only the
snapshot itself shifts to the user's calendar. The provenance
`counts` are row counts, not day counts, so no provenance drift
either. The W7 agent's concern that the bucket math was shared with
the budget proved unfounded on re-read.

Integration test pins the boundary: a 13:00 UTC May 14 reading (=
01:00 NZST May 15) appears under `"2026-05-15"` in the Coach snapshot
for a Pacific/Auckland user. The same instant in Berlin would land
on May 14; the test asserts the snapshot does NOT bucket there.

Existing 88-test coach unit suite stays green (the mocked
`user.findUnique` returns no timezone, so the snapshot falls back to
Europe/Berlin and the v1.4.24 byte-shape holds).

## Surface 4 — `MoodEntry.tz` column

Per proposal §7 Decision A:

- Schema: `MoodEntry.tz: String?` (nullable VARCHAR(64)).
- Migration `0044_mood_entry_tz_column` — additive, idempotent,
  forward-only `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
- Write path (`POST /api/mood-entries` + `PUT /api/mood-entries/:id`)
  captures `User.timezone` at write time, stores it on the row's
  `tz` column, and computes `date` using that zone.
- Read-path helper (`src/lib/mood/date-key.ts`):
  - `moodDateKey(date, tz)` — the canonical write-time bucketer.
  - `effectiveMoodTz(row)` — returns `row.tz ?? "Europe/Berlin"` so
    legacy rows continue to be read as Berlin without a backfill.

The `PUT` route also refreshes `tz` when `moodLoggedAt` changes, so a
legacy row promoted via an edit migrates to per-row attribution
in-place.

Unit suite (`src/lib/mood/__tests__/date-key.test.ts`) pins both
halves of the contract: legacy null-tz rows bucket like a
Europe/Berlin row at the same instant; new Pacific/Auckland rows
bucket to the Auckland day when a legacy row at the same instant
would land on the Berlin day. +8 unit tests.

## Test deltas

| Suite                                                      | Before | After | Delta |
| ---------------------------------------------------------- | ------ | ----- | ----- |
| Unit total                                                 | 2367   | 2375  | +8    |
| Integration: `tests/integration/timezone-per-user.test.ts` | 7      | 10    | +3    |

Unit `+8` is `src/lib/mood/__tests__/date-key.test.ts` (Surface 4).
Integration `+3` is two assertions added in Surface 1 and one in
Surface 3.

## CI gates

| Gate                                    | Result                        |
| --------------------------------------- | ----------------------------- |
| `pnpm typecheck`                        | clean                         |
| `pnpm lint`                             | clean                         |
| `pnpm test` (unit)                      | 2375 passed, 1 skipped        |
| `pnpm test:integration` (timezone file) | 10 passed                     |
| `pnpm format:check` (W7b files)         | clean after `pnpm format` run |

A single unrelated integration test from a concurrent agent's branch
(`tests/integration/measurements-batch-delete.test.ts`, introduced in
`959adec`) fails on a unique-constraint duplicate seed. Out of scope
for W7b; flagged for the owning agent.

## Files touched

```
prisma/schema.prisma                                 # +5 (MoodEntry.tz)
prisma/migrations/0044_mood_entry_tz_column/migration.sql  # NEW (22 LOC)

src/lib/tz/resolver.ts                               # unchanged (reused)
src/lib/mood/date-key.ts                             # NEW (~57 LOC)
src/lib/mood/__tests__/date-key.test.ts              # NEW (~101 LOC)

src/app/api/dashboard/summary/route.ts               # userTz, drop berlinDayKey
src/app/api/medications/intake/route.ts              # userTz, drop berlinDayKey
src/app/api/analytics/route.ts                       # userTz, drop berlinDayKey
src/app/api/insights/targets/route.ts                # userTz, dayKey shim
src/app/api/mood-entries/route.ts                    # write tz + user-tz date
src/app/api/mood-entries/[id]/route.ts               # refresh tz + date on PUT

src/components/charts/health-chart.tsx               # userTimezone prop
src/components/charts/mood-chart.tsx                 # userTimezone prop
src/components/charts/medication-compliance-chart.tsx # userTimezone prop
src/components/charts/compliance-line-chart.tsx      # userTimezone prop

src/app/page.tsx                                     # thread user?.timezone
src/components/insights/trends-row.tsx               # thread user?.timezone
src/components/insights/recommendation-card.tsx      # thread user?.timezone
src/components/insights/insight-advisor-card.tsx     # thread user?.timezone

src/lib/ai/coach/snapshot.ts                         # tz-aware bucketers

tests/integration/timezone-per-user.test.ts          # +3 cases
```

## What's left for v1.5

Nothing on the per-user-timezone proposal. Every surface §3 listed
now honours `User.timezone` end-to-end.

The new untracked insight sub-pages from concurrent agents
(`src/app/insights/bmi/`, `blutdruck/`, `puls/`, `gewicht/`,
`stimmung/`, etc.) already thread `userTimezone={user?.timezone}`
into their chart mounts — those pages were modified in-place when I
threaded the prop on tracked sibling files. When the owning agent
commits those pages, the tz threading lands with them.

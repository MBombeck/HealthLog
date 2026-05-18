# v1.4.39 — UX / Response-Shape Review (read-only)

Reviewer scope: byte-shape parity on the four read-path swaps + the
new `computeLongWindowSummary` helper. Diff base
`v1.4.38.8..develop`; agent reports
`phase-W-MOOD-v1439-report.md`, `phase-W-MED-v1439-report.md`,
`phase-W-SUM-v1439-report.md`, `phase-W-WMY-v1439-report.md` read.

The four target route handlers + test files inspected:
- `src/app/api/mood/analytics/route.ts` (+ `__tests__/route.test.ts`)
- `src/app/api/medications/intake/route.ts` (+ `__tests__/route.test.ts`)
- `src/app/api/dashboard/summary/route.ts` (+ `__tests__/route.test.ts`)
- `src/app/api/measurements/route.ts` (+ `__tests__/range-aggregation-route.test.ts`)

Helpers checked: `readMoodDayRollups`, `readMedicationCompliance`,
`hasMedicationComplianceCoverage`, `readBestGranularityRollups`,
`computeLongWindowSummary`, `resolveBucketSum`.

---

## SEV: HIGH

### H1 — Mood `summary.count / latest / min / max / mean / avg7 / avg30` semantics shift on multi-entry days (live → rollup divergence)

File: `src/app/api/mood/analytics/route.ts:97-101`

The legacy live path called `summarize()` over **per-entry**
`DataPoint`s (`moodLoggedAt`, `score`). The new rollup fast-path
calls `summarize()` over **per-day mean** `DataPoint`s
(`bucketStart`, `r.mean`). For a user with two entries on the same
day (score 7 + score 8), the legacy response emitted:

| field   | legacy            | rollup              |
|---------|-------------------|---------------------|
| count   | total entries     | total days          |
| latest  | last entry's score| last day's mean     |
| min/max | per-entry min/max | per-day-mean min/max|
| mean    | unweighted avg of all entries | unweighted avg of daily means (Simpson-shift on uneven day counts) |
| slope*  | OLS over per-entry x = elapsed ms | OLS over per-day x |

The route comment at lines 91-96 acknowledges this and asserts "power
user's mood is typically 1/day" so the divergence is invisible. That
assumption is reasonable for Marc's tenant but **is** a contract
shift. Consumers on `summary.count` (`src/app/page.tsx:1195` —
dashboard sort gate, harmless) and `summary.latest / avg7 / avg30 /
slope30` (`src/app/page.tsx:878-883` — `TrendCard` tile) read these
fields directly.

Existing parity test `emits byte-identical entries + summary shape
between rollup tier and live fallback` only covers one-entry-per-day
data so the divergence is uncovered. Add a multi-entry-per-day pin
that either (a) accepts the new semantics with a documented contract
or (b) pre-aggregates the live-fallback path through
`aggregateDailyAverages` first so the rollup and live shapes match
on multi-entry days too.

Recommendation: option (b) — make the live-fallback walk fold daily
means before `summarize()` so the two branches stay byte-identical.
Cheap, single map call, removes the silent-shift risk entirely.

---

## SEV: MEDIUM

### M1 — Compliance reader may emit `days + 1` buckets on DST fall-back edge

File: `src/lib/medications/compliance-rollups.ts:330-332`

```ts
if (!dedup.has(todayKey)) {
  orderedKeys.push(todayKey);
}
```

Defensive "always include today" insert that runs **after** the
`for (let i = days - 1; i >= 0; i--)` window builds `orderedKeys`.
On a normal day the loop already includes `todayKey`, so the guard
is a no-op. On a DST fall-back when the loop dedups two probes onto
the same day-key, this branch pushes a fresh entry **outside the
trailing window** if the dedup ever drops `todayKey` itself —
returning `days + 1` buckets where the legacy route always returned
exactly `days`.

Coverage gap: `compliance buckets for the last N days` parity test
pins `body.data.length === 7` on a stable day, not on DST. Live
fallback (`buildComplianceBuckets`) always emits exactly `days`. Add
a DST-fall-back pin and either drop the defensive insert or cap the
final array at `.slice(0, days)`.

### M2 — Mood `entries[].score` rounding can diverge by ≤0.005 on multi-entry days

File: `src/app/api/mood/analytics/route.ts:86`

Legacy: `Math.round((stats.sum / stats.count) * 100) / 100` — JS
arithmetic over integer scores.
Rollup: `Math.round(r.mean * 100) / 100` where `r.mean` is Postgres
`AVG(score)::double precision` — IEEE-754 double through a
different precision chain.

For mood scores (1-5 integers) the two paths produce identical
two-decimal rounding in essentially every realistic case, but the
intermediate float math is not provably identical. Worth a property
test pinning a fixture where JS-AVG and PG-AVG could disagree at the
fifth decimal (e.g. seven entries: 3, 3, 3, 4, 5, 5, 5 → 4.0
vs 4.0). Currently uncovered; risk is cosmetic (Recharts axis tick
shifts on the third decimal).

### M3 — `entries[].samples` semantics consistent BUT route-meta `entryCount` semantics shift

File: `src/app/api/mood/analytics/route.ts:102, 139`

Rollup fast-path: `entryCount = rollups.reduce((s, r) => s + r.count, 0)` — total raw entries across all days.
Live fallback: `entryCount = moodEntries.length` — total raw entries.

These match. Good. **But** `entryCount` is only emitted into
`annotate({ meta })` — not into `apiSuccess(...)` — so it never
reaches the client. No client-facing shape impact; flagging for
audit completeness only.

### M4 — `/api/analytics` live-fallback 90-day cap shifts `summary.avg30LastYear` to null for power users

File: `src/app/api/analytics/route.ts:240-269`

Out of the brief's strict 4-route scope but adjacent: commit
`823føbc8 perf(analytics): cap live-fallback findMany at trailing
90 days` caps every per-type chunked read at the trailing 90 days.
Any user who lands on the live-fallback path (i.e. the rollup
coverage probe missed) loses `summary.avg30LastYear` (window
365-395 d ago) and `summary.avg30LastMonth` (30-60 d ago is
preserved by the 90-day window).

The route comment at `route.ts:230-239` documents this as an
intentional trade-off matching the slim slice's existing 90-day
contract. **Shape parity is preserved (the field is still emitted,
just `null`)** so the iOS / web consumer code handles it
gracefully. Flagged because the marathon brief asked for
"pagination / limit preservation" — there is no pre-existing limit
on this path, but the new 90-day cap is a behavioural shift the
dashboard tile's comparison-overlay will surface.

---

## SEV: LOW

### L1 — `computeLongWindowSummary` not yet exposed via any route (confirms brief)

File: `src/lib/analytics/summaries-slice.ts:615`

`computeLongWindowSummary` is exported but **not consumed from any
route handler or server-component**. `grep -rn` on `src/app`
confirms zero callers. Reserved for v1.5 multi-year trend card and
Coach drawer per `phase-W-WMY-v1439-report.md`. No exposure risk.

### L2 — Locale-sensitive formatting absent on the swap surfaces

No new code in the four target routes does locale-aware date
formatting. Mood rollup labels via `utcDayLabel(d)` which uses pure
`getUTC*` calls (no `toLocaleDateString`). Compliance rollup keys
use `userDayKey(date, tz)` from `tz/format` — same helper the legacy
route used. No `de-DE` vs `en-US` bucket shift risk surfaced.

### L3 — Backend-only paths emit no user-facing strings

No `t(...)` / translator calls introduced into the four routes' new
code paths. Coach evidence chips, i18n labels, all client-side. No
i18n exposure regression.

### L4 — Sort-order parity holds across all swap surfaces

- `readMoodDayRollups`: `orderBy: { bucketStart: "asc" }` — matches
  legacy `aggregateDailyAverages` final `sort([a, b]) =>
  a.localeCompare(b)`.
- `readMedicationCompliance`: builds keys oldest-first then sorts
  via `orderedKeys` array order. Legacy `buildComplianceBuckets`
  ended in `.sort((a, b) => a.date.localeCompare(b.date))`. Both
  produce ISO `YYYY-MM-DD` ascending. Match.
- Dashboard `sparkBuckets`: `bucket_start ASC` in raw SQL.
  Unchanged.
- Measurements `source=rollup` branch: `orderBy: { bucketStart:
  "asc" }`. Unchanged.

### L5 — Empty-state shape parity holds across all swap surfaces

- Mood: both branches return `{ entries: [], summary:
  summarize([]) }` where `summarize([])` is the canonical null
  envelope (`count: 0, latest: null, ...`). Pinned in test
  `returns an empty envelope for a brand-new user`.
- Compliance: both branches produce zero-filled `days`-length
  array. Pinned for legacy path; new path falls through to it on
  coverage-miss.
- Dashboard sparkline: `sparkOf(type)` returns `[]` on miss; tile
  consumer renders empty chart.
- Measurements rollup: `rollupRows.length > 0` gate falls through
  to legacy `date_trunc` path on miss; shape preserved.

### L6 — Pagination / `limit` preservation

- Mood: legacy had no limit (unbounded); new path applies a 5-year
  `since` filter (~1 800 row ceiling). Documented in route comment.
  Strictly tighter, not a regression — but the legacy
  "I have 6-year-old mood entries" power user would lose the
  ≥5-year-old tail. Realistically Marc started logging mood in
  2023 so this is theoretical.
- Compliance: legacy passed `days` straight through; new path
  preserves `days` and clamps at 365 via Zod. Same surface.
- Dashboard sparkline: `SPARK_DAYS = 7` unchanged.
- Measurements: `take: cap = Math.min(limit, BUCKET_CAP.daily)`
  unchanged.

---

## Summary

| Sev | Count | Themes |
|-----|-------|--------|
| H   | 1     | Mood summary shape shifts on multi-entry days (uncovered) |
| M   | 4     | Compliance DST edge, mood rounding, route-meta, analytics 90 d cap |
| L   | 6     | Helper not exposed yet, locale, i18n, sort, empty-state, limits |

The single H finding is **the** UX risk worth blocking on: power-user
multi-entry-mood-day tiles will silently shift `latest / mean / avg7
/ avg30 / slope30` when the rollup tier converges. The fix is
mechanical (pre-aggregate the live-fallback path through
`aggregateDailyAverages` before `summarize()`) and the parity test
just needs one multi-entry fixture to lock it in.

All four routes preserve byte-shape for empty state, sort order,
limits, locale-independence, and i18n absence. The new
`computeLongWindowSummary` helper is correctly NOT exposed.

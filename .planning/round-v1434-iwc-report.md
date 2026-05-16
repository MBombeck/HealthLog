# Round v1.4.34 — IW-C (Compliance Classifier) report

## Scope delivered

Carryover scope item #9 (`compliance.ts` classifier hardening) closed
in three atomic commits on `develop`:

1. `36d5398c` — **classifier**: widen pre-window grace 1h → 3h, add a
   dedicated `early` bucket, extend post-window `on_time` tolerance to
   3h, and let the configurable `lateMinutes` knob size the `late`
   tail past the 3h grace. Tests rebuilt with a parameterised offset
   matrix.
2. `4984bce5` — **consumers**: route `early` intakes through the
   compliant path in `src/app/api/medications/[id]/compliance/route.ts`
   (counted with `onTime` for the heatmap, plus a dedicated `early`
   counter on `DailyComplianceEntry`) and in
   `src/app/api/gamification/achievements/route.ts` (perfect-day
   preserved); docstring fixup in
   `src/lib/medications/scheduling/cadence.ts`.
3. `30c8555c` — **heatmap**: drop the v1.4.33 `looksClassifierBug`
   defensive fallthrough now that the root cause is fixed; keep a
   one-line comment pointing at the classifier fix.

Pushed to `origin/develop` (`30c8555c`).

## Threshold model (final)

```
takenAt === null                                    → "missed"
takenAt < windowStart - 3h                          → "very_late"
windowStart - 3h ≤ takenAt < windowStart            → "early"      (NEW)
windowStart ≤ takenAt ≤ windowEnd + 3h              → "on_time"    (widened)
windowEnd + 3h < takenAt ≤ windowEnd + 3h + Xmin    → "late"       (X = lateMinutes, default 120)
takenAt > windowEnd + 3h + Xmin                     → "very_late"
```

`early` + `on_time` both count as compliant. `early` is exposed on
`IntakeTimingClass` for downstream consumers and as an optional
counter on `DailyComplianceEntry`.

## Validation

- `npx vitest run src/lib/analytics/__tests__/compliance.test.ts` —
  31/31 passing (was 21; added 10 covering -3.5h, -3h (boundary), -1h,
  -10min, 0, +10min, +20min, +1h, +3h, +3.5h, +5h, +5h1min, plus an
  overnight `early` case and a `lateMinutes`-knob case).
- `npx vitest run` — full suite 4153 passing / 1 skipped across 386
  test files.
- `npx tsc --noEmit` — clean.
- `npx eslint` on the five touched source files — clean.

## Touch surface

- `src/lib/analytics/compliance.ts` (+44 / -9)
- `src/lib/analytics/__tests__/compliance.test.ts` (+71 / -24)
- `src/app/api/medications/[id]/compliance/route.ts` (+9 / -1)
- `src/app/api/gamification/achievements/route.ts` (+3 / -1)
- `src/components/charts/compliance-heatmap.tsx` (+13 / -35)
- `src/lib/medications/scheduling/cadence.ts` (+2 / -2 docstring)

Touch-disjoint from the parallel IW-A / IW-B / IW-D / IW-XML lanes.

## Notes for downstream

- The `early` bucket is opt-in for any new analytics consumer. Today
  the medication compliance route surfaces it as an optional counter
  on `DailyComplianceEntry`; if a future heatmap legend wants to
  distinguish early-vs-on-time visually, the data is there.
- The default `lateMinutes` of 120 still sizes the `late` band, so
  the total "late span" is now `windowEnd + 3h .. windowEnd + 5h`
  before a dose flips to `very_late`. Callers that want a tighter
  tail can pass `lateMinutes: 30` (tested).
- `medication-card.tsx` keeps its independent `MedicationWindowStatus`
  type — no cross-contamination with the classifier bucket names.

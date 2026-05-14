---
file: 16-health-score-logic.md
purpose: Health Score computation contract — what the server emits, what iOS renders, and why iOS never recomputes.
when_to_read: Before designing a Health Score tile or score-detail page on iOS.
prerequisites: 04-data-model.md, 15-insights-architecture.md
estimated_tokens: ~2700
version_anchor: v1.4.25 / sha 49f71c92
---

# Health Score Logic

## TL;DR

A 0..100 composite blended from four pillars (BP-in-target, weight-trend-alignment, mood-stability, medication-compliance). Server-deterministic: same input → same output, no `Date.now()` reaches the math. Provenance is mandatory — every component reports its source attribution (manual / Withings / Apple Health / mixed / none) and an `asOf` timestamp. iOS renders the score and the provenance accordion; iOS does NOT recompute.

## STOP HERE IF

- You think iOS should compute the score "for performance". The server weights, redistribution math, and source-priority pickers will drift if iOS reimplements them.
- You think the score should be displayed without the provenance accordion. It shouldn't — provenance is the "why did my score change" trust surface and is load-bearing per Marc-memory.
- You think the BP-in-target rate is the same as the BP averaging logic. It's NOT — see below.

## Formula

```
score = round(
  0.30 * bpInTargetRate
+ 0.20 * weightTrendAlignment
+ 0.20 * moodStability
+ 0.30 * complianceRate
)
```

| Component             | Weight | Source                                                | Null behaviour                                |
| --------------------- | ------ | ----------------------------------------------------- | --------------------------------------------- |
| `bpInTargetRate`      | 0.30   | `bp-in-target.ts` over all-time paired BP readings    | null if no paired readings                    |
| `weightTrendAlignment`| 0.20   | `weightTrendAlignment(series, target)` (see below)    | null if < 2 readings OR no target             |
| `moodStability`       | 0.20   | `100 - CV*100`, clamped 0..100                        | null if < 5 mood entries                      |
| `complianceRate`      | 0.30   | mean of per-medication 30-day compliance %            | null if no active medications                 |

When a component is null, the remaining weights are **redistributed proportionally**:

```ts
// abridged from src/lib/analytics/health-score.ts:366
const present = ["bp", "weight", "mood", "compliance"].filter(k => values[k] !== null);
const totalBaseWeight = present.reduce((s, k) => s + BASE_WEIGHTS[k], 0);
const weightFor = (k) => values[k] === null ? 0 : BASE_WEIGHTS[k] / totalBaseWeight;
```

So a user without medications has BP=42.86%, weight=28.57%, mood=28.57%. The score never lies about what was actually measured.

## Bands

```ts
// from src/lib/analytics/health-score.ts:263
function bandFor(score: number): HealthScoreBand {
  if (score >= 75) return "green";
  if (score >= 50) return "yellow";
  return "red";
}
```

iOS palette: green (#22c55e or your design-token equivalent), yellow (#eab308), red (#ef4444). Use your design system's token, but the band thresholds are fixed contracts.

## Components in detail

### bpInTargetRate

- Defined in `src/lib/analytics/bp-in-target.ts`.
- Counts paired (systolic + diastolic) readings whose values fall inside the user's stored target band.
- All-time, not windowed — the rate reflects "how often you've hit your target since you've been tracking".
- iOS rule: do NOT recompute from raw measurements. Use the server-emitted `bpInTargetRate` directly.

### weightTrendAlignment

- Defined in `src/lib/analytics/health-score.ts:201`.
- Scores how well the 30-day weight trend is closing the gap to the target band [target ± 2 kg].
  - Already inside band → 100.
  - Above band, slope < 0 (closing) → 50 + 50 * tanh(|slope| / 0.05).
  - Above band, slope > 0 (diverging) → 50 - 50 * tanh(|slope| / 0.05).
  - Saturation point: 0.05 kg/day ≈ 1.5 kg/month (a clinically reasonable rate).
- Default target derived from BMI 22 against the user's height if no explicit target is stored.

### moodStability

```ts
// from src/lib/analytics/health-score.ts:235
export function moodStability(entries) {
  if (entries.length < 5) return null;
  const cv = coefficientOfVariation(entries.map(e => e.score));
  if (cv === null) return null;
  return Math.max(0, Math.min(100, Math.round(100 - cv * 100)));
}
```

Coefficient of variation = stdev / |mean|. Lower variation → higher stability → higher score. A flatlined mood at 3/5 scores 100; a mood bouncing between 1 and 5 scores closer to 50.

### complianceRate

```ts
export function complianceRate(values) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}
```

Plain mean of per-medication 30-day compliance percentages. No medication → null (no penalty).

## Deterministic `asOf` — post-Fix-G discipline

The score is deterministic on input dates, **not** on call time. Two callers passing the same `HealthScoreInput` always get the same `HealthScoreResult`. The optional `attribution.windowEndAt` lets the route stamp a wall-clock anchor; when absent, the helper synthesises one from the freshest weight/mood timestamp:

```ts
// from src/lib/analytics/health-score.ts:429
function deriveWindowEndAt(input: HealthScoreInput): string {
  let latest = -Infinity;
  for (const p of input.weightSeriesLast30d) {
    const t = new Date(p.date).getTime();
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  for (const p of input.moodEntriesLast30d) {
    const t = new Date(p.date).getTime();
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  if (latest === -Infinity) return new Date(0).toISOString();
  return new Date(latest).toISOString();
}
```

iOS Claude implication: never render "Score: 72 — as of now". Always read `components.<pillar>.asOf` from the server and surface it ("BP component as of Tue 13 May, 19:42"). This is how the user can answer "why did my score change since yesterday".

## Source attribution — the v1.4.25 W8e contract

Each component carries `source` ∈ `manual | withings | appleHealth | mixed | none` and an `asOf` ISO timestamp. The shape:

```ts
interface HealthScoreComponentDetail {
  value: number | null;        // 0..100, null when component had no signal
  weight: number;              // 0..1, post-redistribution effective weight
  source: "manual" | "withings" | "appleHealth" | "mixed" | "none";
  asOf: string;                // ISO timestamp
}
```

Resolution rules (from `resolveSourceLabel`):

| hasValue | sources length | source label       |
| -------- | -------------- | ------------------ |
| false    | (any)          | `"none"`           |
| true     | 0 / null       | `"manual"` (pre-W8e backward-compat default) |
| true     | 1              | that single token  |
| true     | >= 2 distinct  | `"mixed"`          |

iOS rendering — the provenance accordion:

```
┌────────────────────────────────────────┐
│ Health Score 72 (green)                │
│ ▾ How is this calculated?              │
│                                        │
│   BP-in-target          81  (Withings) │
│      weight 0.30 · as of Tue 13 May    │
│   Weight trend          —   (none)     │
│      weight 0.00 · no target set       │
│   Mood stability        67  (manual)   │
│      weight 0.28 · as of Tue 13 May    │
│   Medication compliance 89  (manual)   │
│      weight 0.42 · as of Mon 12 May    │
│                                        │
│  Composite: 0.30·81 + 0.28·67 + ...    │
└────────────────────────────────────────┘
```

The accordion is the audit-log surface for "why did my score change". It tells the user **what changed, where it came from, and when it was measured**. Without it the score is opaque and the trust falls apart.

## Source-priority two-axis interaction

The `HealthScoreSourceAttribution` slice fed to the route by the analytics layer is the OUTPUT of the cross-source canonical picker (`src/lib/analytics/source-priority.ts`). That picker:

1. Buckets measurements by user-tz day.
2. For each day, walks the user's per-metric **source priority ladder** (e.g. `[APPLE_HEALTH, WITHINGS, MANUAL]` for steps) and picks the first source that has any row.
3. Among the picked source's rows, walks the **device-type priority ladder** (`watch > band > ring > phone > scale > other > unknown`) and keeps only rows from the top-ranked device type.

So when iOS renders "Mood stability — source: manual", that label has already passed through both ladders. iOS does NOT re-apply ladders.

Implication for the iOS Health app's HealthKit sync: when iOS pushes a measurement, it tags the row with the canonical source = `APPLE_HEALTH` and the `deviceType` ∈ `watch | band | ring | phone | scale | other | unknown`. The server's picker then decides whether that row contributes to the Health Score on a given day.

If two sources (Apple Watch + Withings scale) both record steps for the same day, the picker picks one based on the user's priority. The Health Score component sources field will read `appleHealth` (or `withings`) — never `mixed` for cumulative metrics like steps. For point metrics (latest weight, latest pulse), the picker keeps the latest row from the winning source.

## Delta vs last week

`computeHealthScore(input, previous?)` accepts an optional previous-period input and computes `delta = score - prev.score`. The route fills `previous` with last week's same-day window so the dashboard tile shows "▲ 4 since last week".

iOS Claude implication: **iOS does NOT compute the delta**. The server provides it. If the server provides null (no historical input), iOS renders "—" or hides the delta.

## API contract

```
GET /api/analytics/health-score?asOf=2026-05-14T19:00:00Z
→ {
    data: {
      score: 72,
      band: "green",
      delta: 4,
      components: {
        bp: { value: 81, weight: 0.30, source: "withings", asOf: "..." },
        weight: { value: null, weight: 0, source: "none", asOf: "..." },
        mood: { value: 67, weight: 0.28, source: "manual", asOf: "..." },
        compliance: { value: 89, weight: 0.42, source: "manual", asOf: "..." }
      }
    }
  }
```

`asOf` is an optional query param; when absent, the route uses "now". When provided, the score is reproducible (deterministic on date inputs).

## Why iOS must not recompute server-side weights

1. **Drift**. Weight redistribution math is server-side; an iOS reimplementation will drift the first time `BASE_WEIGHTS` changes (and they have changed before — saturation point in `weightTrendAlignment` was tuned in v1.4.20 phase B5).
2. **Source attribution**. The two-axis picker is not just maths — it reads the user's `sourcePriorityJson` config row. iOS can't see that config without another round-trip.
3. **`asOf` discipline**. iOS doesn't know the wall-clock anchor the server picked. Mirroring it without the anchor leaks `Date.now()` into the result.
4. **Test surface**. The server has 100+ tests over `computeHealthScore`. iOS would reinvent the test surface.
5. **Audit log**. The score-detail accordion is meant to match exactly what the server believes. Reimplementing creates a "your phone says 72, the web app says 71" support burden.

If iOS needs to render a score offline (no network), the iOS app should:

1. Cache the most recent `HealthScoreResult` JSON locally.
2. Stamp it with the timestamp of last successful sync.
3. Surface "Showing last synced score — Tue 13 May, 14:22" when offline.

Never recompute from cached measurements.

## Audit log surface — "why did my score change?"

When the score moves by ≥ 5 points week-over-week, the dashboard surfaces a "what changed" tooltip generated server-side from the component deltas. iOS can render the same tooltip; the data is in the response. Generation logic lives in `src/lib/analytics/health-score-delta-explainer.ts` (planned for v1.4.26 — currently inline in the route).

The provenance accordion is the canonical "why" surface today. Tooltip is the polish layer.

## "Since v1.4.24" diff markers

- **NEW v1.4.25 W8e** — `HealthScoreComponentDetail.source` + `asOf` fields. Pre-W8e responses had `value + weight` only.
- **NEW v1.4.25 Fix-G** — `deriveWindowEndAt()` fallback so the helper stays pure. Pre-Fix-G the route bled `new Date()` into the result.
- **NEW v1.4.25 W8c** — two-axis source-priority picker (`watch > phone > scale`) drives the contributing-source set for cumulative metrics.

## iOS implementation checklist

1. **Read** `GET /api/analytics/health-score` on dashboard load.
2. **Cache** the result locally (Core Data / SQLite / FileManager-blob) for offline display.
3. **Render** the 0..100 number + band colour in the dashboard tile.
4. **Render** the provenance accordion in the score-detail sheet — every pillar with `value`, `weight`, `source`, `asOf`.
5. **Surface delta** when non-null ("▲ 4 since last week").
6. **Do NOT recompute** — even when the user adds a new measurement in-app, wait for the server to recompute on the next read.
7. **Optimistic update** after a measurement add: invalidate the score query so the next render fetches fresh.

## Self-test snippet

```bash
# Probe the score on a local dev server
curl -s "http://localhost:3000/api/analytics/health-score" \
  -H "Authorization: Bearer $TOKEN" | jq '.data | {score, band, delta, components}'
```

```swift
// Decode in Swift
struct HealthScoreResult: Decodable {
    let score: Int
    let band: String          // "green" | "yellow" | "red"
    let delta: Int?
    let components: Components

    struct Components: Decodable {
        let bp: Detail
        let weight: Detail
        let mood: Detail
        let compliance: Detail
    }
    struct Detail: Decodable {
        let value: Double?
        let weight: Double
        let source: String    // "manual" | "withings" | "appleHealth" | "mixed" | "none"
        let asOf: String      // ISO8601
    }
}
```

## Cross-references

- **04-data-model.md** — `User.sourcePriorityJson` schema, `Measurement.deviceType` column.
- **08-locked-contracts.md** — exact `/api/analytics/health-score` response shape.
- **15-insights-architecture.md** — Insights sometimes cite the Health Score in prose; never embed it.
- **07-server-responsibilities.md** — source-priority resolver is server-side; iOS doesn't reinvent.

/**
 * OpenAPI route table — dashboard snapshot, comprehensive insights, analytics range, metric status, derived metrics, correlations.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import { measurementSourceEnum, measurementTypeEnum } from "../shared";
import { METRIC_STATUS_IDS } from "@/lib/insights/metric-status-registry";
import {
  DERIVED_METRIC_IDS,
  VITALS_BASELINE_TYPES,
  SAME_TIME_BASELINE_TYPES,
} from "@/lib/insights/derived/registry";
import {
  DERIVED_MAX_WINDOW_DAYS,
  SPARKLINE_MAX_POINTS,
} from "@/lib/insights/derived/types";
import { ANALYTICS_RANGES } from "@/lib/analytics/range-delta";
import { PROVIDER_CHAIN_TYPES } from "@/lib/ai/provider-chain";
import { PERIOD_DAYS } from "@/lib/insights/narrative/period-narrative";

/** The retrospective periods the narrative route accepts, read off the engine. */
const NARRATIVE_PERIOD_VALUES = Object.keys(PERIOD_DAYS);

export const insightsComprehensiveResponse = z
  .object({
    summary: z.string(),
    recommendations: z.array(z.record(z.string(), z.unknown())),
    citations: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.record(z.string(), z.unknown())),
    dailyBriefing: z.record(z.string(), z.unknown()).nullable().optional(),
    trendAnnotations: z.record(z.string(), z.unknown()).nullable().optional(),
    storyboardAnnotations: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
    metricSource: z.record(z.string(), z.unknown()).optional(),
    revalidating: z
      .boolean()
      .optional()
      .describe(
        "True when the body is served from last-good cache (stale-while-revalidate) while a fresh aggregation runs in the background. The client keeps polling on `revalidating` (bounded) so the open page converges on the fresh body.",
      ),
  })
  .meta({
    id: "InsightsComprehensiveResponse",
    description:
      "AI-generated insights bundle. Strict-schema validated server-side; Coach-routed when the insight surface needs day-level grounding.",
  });

// v1.8.7.1 — generic per-HealthKit-metric assessment. The query enum is
// derived from the same registry the route validates against, so the
// spec, the route, and the cache scope cannot drift. The seven
// specialised metrics (weight / blood-pressure / pulse / bmi / mood /
// medication-compliance) keep their own routes and are NOT accepted here.
export const metricStatusQuery = z
  .object({
    metric: z
      .enum(METRIC_STATUS_IDS as [string, ...string[]])
      .describe(
        "HealthKit metric id to assess (e.g. RESTING_HEART_RATE, SLEEP_DURATION). Closed enum: an unknown id 422s. The seven specialised metrics are served by their own routes and are not accepted here.",
      ),
    locale: z
      .enum(["de", "en"])
      .optional()
      .describe("Optional UI-locale override; defaults to the session locale."),
  })
  .meta({ id: "MetricStatusQuery" });

export const metricStatusResponse = z
  .object({
    hasProvider: z
      .boolean()
      .describe(
        "False when the user has no usable AI provider — `text` then carries the generic no-key guidance.",
      ),
    text: z
      .string()
      .nullable()
      .describe(
        "The assessment narrative (plain text, rendered as React text children). Null while a first generation is preparing, or when the metric has insufficient data.",
      ),
    cached: z
      .boolean()
      .describe("True when `text` is served from cache (incl. last-good)."),
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the served assessment was generated; null when none."),
    preparing: z
      .boolean()
      .optional()
      .describe(
        "True when a first assessment is being generated out of band and no prior text exists yet — the client polls until it lands.",
      ),
    revalidating: z
      .boolean()
      .optional()
      .describe(
        "True when `text` is served from last-good cache (stale-while-revalidate) while a fresh generation is in flight. The payload is otherwise terminal; the client keeps polling on `preparing || revalidating` (bounded) so the open card upgrades to the warmed assessment without a remount.",
      ),
    insufficient: z
      .boolean()
      .optional()
      .describe(
        "True when the metric has no readings; no assessment is generated (no LLM call). The card shows its insufficient-data state.",
      ),
  })
  .meta({
    id: "MetricStatusResponse",
    description:
      "Generic per-metric assessment envelope. Identical shape to the seven specialised `*-status` cards so the `InsightStatusCard` consumes it unchanged. Read-only + stale-while-revalidate: a cache miss warms a generation out of band and serves the last-good text meanwhile.",
  });

// v1.10.0 — generic derived-wellness-metric route. The query enum is
// derived from the same registry the route validates against, so spec +
// route + cache scope cannot drift. `type` sub-targets the single
// measurement type a baseline metric works over.

/**
 * Every value the `type` query parameter accepts, assembled from the two
 * registry sets that define one: `VITALS_BASELINE` bands a single vital,
 * `SAME_TIME_BASELINE` compares one cumulative day metric against the same
 * hour of a typical day. Published as one enum because `type` is a single
 * parameter shared by both metrics — a client picks the subset that belongs
 * to the `metric` it names.
 *
 * Built from the registry rather than restated here, so a type added to
 * either engine reaches the published contract in the same commit.
 * `derived-type-enum-sync.test.ts` pins the equality.
 */
export const DERIVED_TYPE_PARAM_VALUES: string[] = [
  ...VITALS_BASELINE_TYPES,
  ...SAME_TIME_BASELINE_TYPES,
];

export const derivedMetricQuery = z
  .object({
    metric: z
      .enum(DERIVED_METRIC_IDS as [string, ...string[]])
      .describe(
        "Derived-metric id to compute (e.g. VITALS_BASELINE, FITNESS_AGE, VASCULAR_AGE_DELTA, HRV_BALANCE, BMI, READINESS). Closed enum: an unknown id 422s. Metrics whose compute has not yet landed return an `insufficient` value with reason `not_implemented`.",
      ),
    type: z
      .enum(DERIVED_TYPE_PARAM_VALUES as [string, ...string[]])
      .optional()
      .describe(
        "The single measurement type a baseline metric works over. `VITALS_BASELINE` takes one of the eleven vitals (`RESTING_HEART_RATE` through `WEIGHT`; defaults to `RESTING_HEART_RATE`). `SAME_TIME_BASELINE` takes one of the four cumulative day metrics — `ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `WALKING_RUNNING_DISTANCE`, `FLIGHTS_CLIMBED`. Ignored by the composite metrics. A type the named metric does not support yields an `insufficient` value rather than a 422, so client metric combinations stay forgiving.",
      ),
    windowDays: z.coerce
      .number()
      .int()
      .min(1)
      .max(DERIVED_MAX_WINDOW_DAYS)
      .optional()
      .describe(
        `Trailing window the metric summarises, in days (1–${DERIVED_MAX_WINDOW_DAYS}). Omit it and each metric keeps its own default — 14 days for the wellness-score trend, 30 for the vitals baselines, 90 for BMI, 180 for cardio fitness, 365 for the vascular-age delta. A value outside the range is a 422, never a silent clamp; the ceiling is where the derived tier stops resolving against DAY rollup buckets and would fall back to an uncapped raw read. Always read \`provenance.windowDays\` back: it is the window the engine ACTUALLY used, and \`HEALTH_SCORE\` composes fixed per-pillar windows and reports the widest of them rather than the one you asked for. The window is a request, not a promise about coverage — \`coverage.historyDays\` is how many days of record actually backed the answer, and it is smaller than \`windowDays\` for anyone whose history is shorter than the window. Not accepted on the batch route, which always runs the engine defaults.`,
      ),
  })
  .meta({ id: "DerivedMetricQuery" });

/**
 * The `RECOVERY_SCORE` / `STRESS_SCORE` / `STRAIN_SCORE` value object.
 *
 * Modelled here because the free-form `value` record left every derived
 * metric's payload shape undocumented, and a client reading the DTO could not
 * see that `series`, `daysInWindow` and `asOf` were already on the wire.
 *
 * Nothing `$ref`s it — `value` has to stay an open record while one route
 * serves eighteen differently-shaped value objects — so it is registered in
 * the forced-components slot in `../index.ts`, the same slot `Medication` and
 * `CoachPrefs` use. Its fields are held against the runtime interface by
 * `derived-wellness-value-contract.test.ts`, so the published shape cannot
 * drift away from what the engine actually returns.
 *
 * STILL OPAQUE, and known to be: the value shapes of `VITALS_BASELINE` (prose
 * only, in the `value` description), `FITNESS_AGE`, `VASCULAR_AGE_DELTA`,
 * `HRV_BALANCE`, `BMI`, `SLEEP_SCORE`, `READINESS`, `COINCIDENT_DEVIATION`,
 * `TRAJECTORY`, `SAME_TIME_BASELINE`, `SIX_MINUTE_WALK_BAND`, `HEALTH_SCORE`
 * and the three fixed-type baselines. Each is a TypeScript interface next to
 * its engine under `src/lib/insights/derived/`; modelling them is a schema per
 * engine and belongs in its own change rather than riding along here.
 */
export const wellnessScoreValue = z
  .object({
    score: z.number().int().describe("The latest persisted 0–100 score."),
    band: z
      .enum(["green", "yellow", "red"])
      .describe(
        "Server's verdict on the score. Direction-aware: recovery bands high-is-good, stress and strain invert, so a client must never re-band the number itself.",
      ),
    trendDelta: z
      .number()
      .int()
      .nullable()
      .describe(
        "Score minus the mean of the earlier days in the window; null when the window holds only one day.",
      ),
    daysInWindow: z
      .number()
      .int()
      .describe(
        "Days that actually carried a score inside the window. Compare against `provenance.windowDays` — a shorter record answers a wide request with fewer days, and this is where that shows.",
      ),
    asOf: z.iso
      .datetime({ offset: true })
      .describe("`measuredAt` of the latest score."),
    series: z
      .array(z.number())
      .describe(
        `Trailing scores, oldest → newest, capped at ${SPARKLINE_MAX_POINTS} points however wide the window is. For RECOVERY these are the canonical per-night values: a worn band and the server's own proxy write the same night on different clocks, and the server collapses them to one value per night before this array is built.`,
      ),
    anchor: z
      .enum(["personal", "population"])
      .nullable()
      .optional()
      .describe(
        "STRAIN only — whether this score was judged against the user's own training history or the cold-start population reference. Null for recovery and stress.",
      ),
    components: z
      .array(
        z.object({
          key: z.string().describe("Contributor id, e.g. rhr / hrv / sleep."),
          value: z
            .number()
            .nullable()
            .describe("0–100 sub-score, null when the input was missing."),
          weight: z
            .number()
            .describe("Effective weight after redistributing missing inputs."),
        }),
      )
      .nullable()
      .optional()
      .describe(
        "RECOVERY only, and only when the canonical value is the server's computed proxy — a device-native recovery percentage is not our blend and carries no decomposition.",
      ),
  })
  .meta({ id: "WellnessScoreValue" });

export const derivedCoverage = z
  .object({
    requiredInputs: z
      .number()
      .int()
      .describe("Inputs the metric wants (its full input set)."),
    presentInputs: z
      .number()
      .int()
      .describe("Inputs actually present in the user's data."),
    historyDays: z
      .number()
      .int()
      .describe(
        "Distinct days of history backing the value (the gating floor).",
      ),
    missing: z
      .array(z.string())
      .describe(
        "Named inputs still missing — drives the 'track N more' nudge.",
      ),
  })
  .meta({ id: "DerivedCoverage" });

export const derivedConfidence = z
  .object({
    score: z
      .number()
      .describe(
        "0..100 confidence; feeds the shared coverage meter unchanged.",
      ),
    band: z
      .enum(["high", "medium", "low", "draft"])
      .describe("Confidence band the meter renders."),
  })
  .meta({ id: "DerivedConfidence" });

export const derivedProvenance = z
  .object({
    inputs: z
      .array(z.string())
      .describe("Named inputs that actually backed the value."),
    source: z
      .enum(["DAY", "WEEK", "MONTH", "YEAR", "live", "none"])
      .describe(
        "Granularity the dominant read resolved against. 'live' = a coverage-miss live-SQL fallback; 'none' = no data backed the value.",
      ),
    windowDays: z
      .number()
      .int()
      .describe("Trailing window the value summarises, in days."),
    computedAt: z.iso
      .datetime({ offset: true })
      .describe("Compute time (for cache-staleness + the 'as of' chip)."),
  })
  .meta({ id: "DerivedProvenance" });

/**
 * v1.38 — what a Health Score rests on.
 *
 * Declared once and referenced from every surface that carries a score
 * (the full report, the dashboard snapshot's flattened block, the daily
 * digest), so the three cannot drift into describing the same object
 * three different ways.
 *
 * OPTIONAL wherever it appears. It is a new field on shapes that already
 * ship, and a cached snapshot or digest written before this release has
 * no way to grow one; a required field would have made every one of them
 * invalid against the published contract on the day it was published.
 */
export const healthScoreBasis = z
  .object({
    domains: z
      .number()
      .int()
      .min(1)
      .describe(
        "Distinct areas of health counted. NOT the length of `composition` — three of the seven pillars share the cardiometabolic area, so a three-pillar score can rest on one area.",
      ),
    recommended: z
      .number()
      .int()
      .describe(
        "How many distinct areas the method recommends. A recommendation, not a floor: a score below it is computed and served, it is just narrower.",
      ),
    tier: z
      .enum(["full", "partial", "minimal"])
      .describe(
        "`full` = at or above the recommended breadth, `partial` = two areas, `minimal` = one. The arithmetic is identical at every tier — the same mean, the same worst-pillar band drag, the same noise floor — so this is the only thing that distinguishes a narrow score from a broad one on the wire. Render it beside the number.",
      ),
    physiological: z
      .boolean()
      .describe(
        "Whether any counted pillar rests on a physiological measurement (blood pressure, glucose, sleep, body shape, cholesterol). False means the score is built from activity and/or wellbeing alone. A statement of scope, not a warning: the score still exists and is still honest about what produced it.",
      ),
  })
  .meta({
    id: "HealthScoreBasis",
    description:
      "What the Health Score rests on, resolved server-side. Present on every score computed from at least one usable pillar; optional on every shape that carries it, so payloads cached before v1.38 stay valid.",
  });

// v1.13.2 — per-derived-SCORE assessment text. Additive, non-breaking field
// on the derived response; the iOS field-name contract is LOCKED.
export const derivedAssessment = z
  .object({
    text: z
      .string()
      .describe(
        "Short, non-empty explanation of why the score sits where it does, referencing the score's contributors.",
      ),
    source: z
      .string()
      .describe(
        "'deterministic' for the always-on template text, or 'ai' when warmer provider prose has been cached.",
      ),
    updatedAt: z.iso
      .datetime({ offset: true })
      .describe("When the text was produced / last warmed."),
  })
  .meta({ id: "DerivedAssessment" });

export const derivedMetricResponse = z
  .object({
    metric: z
      .enum(DERIVED_METRIC_IDS as [string, ...string[]])
      .describe("Echoes the requested derived-metric id (tags the union)."),
    status: z
      .enum(["ok", "insufficient"])
      .describe(
        "'ok' carries `value` + `confidence`; 'insufficient' carries `reason` and no value, but still carries `coverage` + `provenance` so the surface renders the same gating UI.",
      ),
    value: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        "Metric-specific value object when status is 'ok'; null when 'insufficient'. The shape is chosen by `metric`, and the record stays open because one route serves eighteen of them. `RECOVERY_SCORE` / `STRESS_SCORE` / `STRAIN_SCORE` return the `WellnessScoreValue` schema — field-by-field in `components.schemas`, including the `series`, `daysInWindow` and `asOf` a client would otherwise have to discover by inspecting a live payload. `VITALS_BASELINE` returns { type, center, low, high, spread, sampleDays, k, series }, where `series` is the trailing per-day means for the inline sparkline. The remaining metrics' value objects are not modelled here yet; their shapes are TypeScript interfaces beside their engines under `src/lib/insights/derived/`.",
      ),
    coverage: derivedCoverage,
    confidence: derivedConfidence
      .nullable()
      .describe("Present when status is 'ok'; null when 'insufficient'."),
    provenance: derivedProvenance,
    reason: z
      .string()
      .nullable()
      .describe(
        "Why the value could not be produced; null when status is 'ok'.",
      ),
    assessment: derivedAssessment
      .nullable()
      .describe(
        "v1.13.2 — short 'why is this score what it is' explanation, keyed to the SAME requested id (only for the per-score ids READINESS, SLEEP_SCORE, RECOVERY_SCORE, STRAIN_SCORE, STRESS_SCORE). Null for any other metric and whenever status !== 'ok'. Always non-empty when present: a deterministic text fills it (so provider-less accounts + the demo always get one) and warmer AI prose overrides it once cached.",
      ),
  })
  .meta({
    id: "DerivedMetricResponse",
    description:
      "Flat `Derived<T>` envelope for one derived wellness metric. Pure compute over the rollup tier (no LLM, no narrative). iOS decodes one stable shape and combines values across metrics; coverage/confidence/provenance let it render the same honesty chips.",
  });

// v1.10.0 — batched derived-metric query. The `metrics` CSV carries one
// or more `metric` / `metric:type` tokens; the route fans out server-side
// under a bounded limiter with the profile loaded once, collapsing the
// dashboard's cold-mount fan-out of N single-metric requests into one.
export const derivedBatchQuery = z
  .object({
    metrics: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Comma-separated derived-metric tokens. Each is a `<DERIVED_METRIC_ID>` or `<DERIVED_METRIC_ID>:<MeasurementType>` (the colon sub-targets the single measurement type a baseline metric works over — a vital for `VITALS_BASELINE`, a cumulative day metric for `SAME_TIME_BASELINE`; see the `type` parameter on `GET /api/insights/derived`). An unknown id 422s; a `type` outside the MeasurementType enum 422s; at most 24 tokens; duplicates collapse.",
      ),
  })
  .meta({ id: "DerivedBatchQuery" });

export const derivedBatchResponse = z
  .object({
    metrics: z
      .record(z.string(), derivedMetricResponse)
      .describe(
        "Map keyed by the per-request token (`<metric>` or `<metric>:<type>`). Each value is the same flat `Derived<T>` envelope the single-metric route returns, so a client decodes one shape and reads back exactly the tokens it asked for.",
      ),
  })
  .meta({
    id: "DerivedBatchResponse",
    description:
      "Batched derived-metric values. One request resolves the whole dashboard grid (the wellness scores + the derived re-frames + one baseline per vital) instead of N concurrent single-metric requests sharing the Prisma pool. Pure compute over the rollup tier — no LLM, no narrative, no cache table.",
  });

// v1.10.0 — FDR-controlled correlation discovery result. One discovered,
// statistically-defensible behaviour → next-day-outcome pair.
export const discoveredCorrelation = z
  .object({
    behaviour: z
      .string()
      .describe("Behaviour channel (lag source), e.g. TIME_IN_DAYLIGHT, MOOD."),
    outcome: z
      .string()
      .describe(
        "Outcome channel (lag target), e.g. SLEEP_DURATION, HEART_RATE_VARIABILITY.",
      ),
    behaviourLabel: z
      .string()
      .optional()
      .describe("Display label for a dynamic behaviour channel."),
    outcomeLabel: z
      .string()
      .optional()
      .describe("Display label for a dynamic outcome channel."),
    n: z
      .number()
      .int()
      .describe("Paired-day count after the day+1 lag join (≥ 20)."),
    r: z.number().describe("Pearson r over the lag-joined daily series."),
    pValue: z.number().describe("Two-sided exact Student-t p-value (< 0.05)."),
    qValue: z
      .number()
      .describe(
        "Benjamini-Hochberg FDR-adjusted q-value (≤ the surface threshold).",
      ),
    shrunkR: z
      .number()
      .describe(
        "Sample-size-shrunk effect (r shrunk toward null by depth), used for ranking and the effect-size floor. Display still uses raw `r`.",
      ),
    tier: z
      .enum(["high", "moderate", "faint"])
      .describe(
        "Phrasing-confidence tier the narration honours: `faint` is hedged, `high` is stated plainly, `moderate` sits between. A below-floor pair never reaches this list.",
      ),
    interpretation: z
      .string()
      .describe("Conservative, descriptive interpretation — never causal."),
    lagDays: z.number().int().describe("Lag in days applied (1)."),
    window: z
      .enum(["retrospective", "recent"])
      .optional()
      .describe(
        "v1.22 — which window surfaced the pair. Absent on the 180-day scan (retrospective default); `recent` for an emerging early-detection pair.",
      ),
    provisional: z
      .boolean()
      .optional()
      .describe(
        "v1.22 — true for an emerging recent-window pair: fewer days, hedged as provisional rather than established.",
      ),
    patternId: z
      .string()
      .optional()
      .describe("Account-scoped persisted identity for dismissal."),
    canonicalKey: z
      .string()
      .optional()
      .describe("Stable factor + outcome + lag identity."),
    dismissed: z
      .boolean()
      .optional()
      .describe("Server decision to suppress unchanged evidence."),
  })
  .meta({ id: "DiscoveredCorrelation" });

export const correlationPattern = z
  .object({
    id: z.string(),
    canonicalKey: z.string(),
    family: z.string(),
    factorKey: z.string(),
    outcomeKey: z.string(),
    lagDays: z.number().int(),
    sampleSize: z.number().int(),
    effectSize: z.number(),
    pValue: z.number(),
    qValue: z.number().nullable(),
    evidenceHash: z.string(),
    lastComputedAt: z.string(),
    dismissedAt: z.string().nullable(),
  })
  .meta({ id: "CorrelationPattern" });

export const correlationPatternListResponse = z
  .object({ patterns: z.array(correlationPattern) })
  .meta({ id: "CorrelationPatternListResponse" });

export const updateCorrelationPatternRequest = z
  .strictObject({ dismissed: z.boolean() })
  .meta({ id: "UpdateCorrelationPatternRequest" });

export const updateCorrelationPatternResponse = z
  .object({
    id: z.string(),
    canonicalKey: z.string(),
    dismissed: z.boolean(),
    dismissedAt: z.string().nullable(),
    evidenceHash: z.string(),
  })
  .meta({ id: "UpdateCorrelationPatternResponse" });

// v1.22 — one labs ↔ outcome association (point-vs-window over sparse draws).
export const discoveredLabCorrelation = z
  .object({
    lab: z
      .string()
      .describe("`LAB:<analyte>` channel key (display strips the prefix)."),
    outcome: z
      .string()
      .describe(
        "Outcome channel the marker tracks with (WEIGHT, BLOOD_GLUCOSE, BLOOD_PRESSURE_SYS).",
      ),
    n: z
      .number()
      .int()
      .describe("Draws paired with a usable contemporaneous outcome window."),
    r: z
      .number()
      .describe(
        "Pearson r over (draw value, contemporaneous outcome window-mean).",
      ),
    pValue: z.number().describe("Two-sided exact Student-t p-value (< 0.05)."),
    qValue: z
      .number()
      .describe(
        "Benjamini-Hochberg FDR-adjusted q-value (≤ the surface threshold).",
      ),
    windowDays: z
      .number()
      .int()
      .describe("Trailing days each draw's outcome window spanned."),
    interpretation: z
      .string()
      .describe("Conservative, descriptive interpretation — never causal."),
  })
  .meta({ id: "DiscoveredLabCorrelation" });

// v1.22 — rolling early-detection result (recent-window emerging pairs).
export const emergingCorrelationResult = z
  .object({
    emerging: z
      .array(discoveredCorrelation)
      .describe(
        "Recent-window pairs NOT already established retrospectively — the emerging signals (provisional, hedged).",
      ),
    windowDays: z
      .number()
      .int()
      .describe("Trailing window (days) the early pass scanned."),
    minPairs: z
      .number()
      .int()
      .describe("Paired-day floor enforced for the early pass."),
    fdrQ: z
      .number()
      .describe("FDR target the early pass used (tighter than the main scan)."),
    pairsTested: z.number().int().describe("Pairs tested in the early window."),
  })
  .meta({ id: "EmergingCorrelationResult" });

// v1.22 — labs ↔ outcome pass result.
export const labCorrelationResult = z
  .object({
    discovered: z
      .array(discoveredLabCorrelation)
      .describe(
        "Lab ↔ outcome associations surviving the per-pair floor + BH-FDR.",
      ),
    pairsTested: z.number().int().describe("Lab × outcome pairs assessed."),
    fdrQ: z.number().describe("The FDR target the pass used."),
    minDraws: z
      .number()
      .int()
      .describe("Minimum paired-draw count enforced per pair."),
  })
  .meta({ id: "LabCorrelationResult" });

export const correlationDiscoveryResponse = z
  .object({
    discovered: z
      .array(discoveredCorrelation)
      .describe("Pairs surviving n ≥ 20, p < 0.05, AND the BH-FDR control."),
    pairsTested: z
      .number()
      .int()
      .describe("Behaviour × outcome pairs assessed (for the honest footer)."),
    fdrQ: z.number().describe("The FDR target the surface used."),
    minPairs: z
      .number()
      .int()
      .describe("Minimum paired-day count enforced per pair."),
    emerging: emergingCorrelationResult
      .optional()
      .describe(
        "v1.22 — rolling early-detection pass over the trailing window; emerging pairs not yet established retrospectively (no double-count).",
      ),
    labCorrelations: labCorrelationResult
      .optional()
      .describe(
        "v1.22 — labs ↔ outcome associations (each draw vs the contemporaneous outcome window-mean), FDR-controlled; absent-degrading on sparse draws.",
      ),
  })
  .meta({
    id: "CorrelationDiscoveryResponse",
    description:
      "v1.10.0 — FDR-controlled correlation discovery over a curated behaviour × outcome matrix, lagged behaviour → next-day outcome. Only statistically-defensible pairs surface; descriptive, never causal.",
  });

// v1.28.21 — GLP-1 weight-plateau read. Mirrors the fields of the
// server-side detector context (`Glp1PlateauContext`); `plateau` is null
// whenever the detector bows out.
export const glp1PlateauResponse = z
  .object({
    plateau: z
      .object({
        drug: z.string().describe('Display drug name ("Mounjaro").'),
        doseValue: z.number().describe("Current dose value (e.g. 7.5)."),
        doseUnit: z.string().describe('Dose unit (e.g. "mg").'),
        doseSince: z
          .string()
          .describe("ISO date (YYYY-MM-DD) the current dose started."),
        daysOnDose: z
          .number()
          .int()
          .describe("Days the user has been on the current dose."),
        weightDeltaKg: z
          .number()
          .describe(
            "Weight delta in kg over the trailing window (negative = loss).",
          ),
        readingsCount: z
          .number()
          .int()
          .describe("Number of weight readings considered."),
      })
      .nullable()
      .describe(
        "Null when no plateau is detected (no active GLP-1 medication, < window days on the current dose, weight still dropping, or fewer than two readings).",
      ),
    windowDays: z
      .number()
      .int()
      .describe("Trailing comparison window in days (currently 21)."),
  })
  .meta({
    id: "InsightsGlp1PlateauResponse",
    description:
      "Deterministic weight-plateau detection for users on an active GLP-1 medication: stable dose for ≥ the window with no weight loss beyond the threshold. Association only — carries no verdict or advice.",
  });

// The seven specialised `*-status` routes accept an optional locale
// override (the metric is fixed by the route path, unlike the generic
// metric-status route which carries it as a query field).
export const insightStatusQuery = z
  .object({
    locale: z
      .enum(["de", "en"])
      .optional()
      .describe("Optional UI-locale override; defaults to the session locale."),
  })
  .meta({ id: "InsightStatusQuery" });

// Shared response shape for the five text-bearing specialised status
// routes (blood-pressure, pulse, weight, bmi, mood). Same envelope as
// the generic metric-status card minus the `insufficient` flag, which is
// metric-status-only. Read-only + stale-while-revalidate.
export const insightStatusResponse = z
  .object({
    hasProvider: z
      .boolean()
      .describe(
        "False when the user has no usable AI provider — `text` then carries the generic no-key guidance.",
      ),
    text: z
      .string()
      .nullable()
      .describe(
        "The assessment narrative (plain text, rendered as React text children). Null while a first generation is preparing.",
      ),
    cached: z
      .boolean()
      .describe("True when `text` is served from cache (incl. last-good)."),
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the served assessment was generated; null when none."),
    preparing: z
      .boolean()
      .optional()
      .describe(
        "True when a first assessment is being generated out of band and no prior text exists yet — the client polls until it lands.",
      ),
    revalidating: z
      .boolean()
      .optional()
      .describe(
        "True when `text` is served from last-good cache (stale-while-revalidate) while a fresh generation is in flight. The client keeps polling on `preparing || revalidating` (bounded) so the open card upgrades to the warmed assessment without a remount.",
      ),
  })
  .meta({
    id: "InsightStatusResponse",
    description:
      "Specialised per-metric assessment envelope (blood-pressure, pulse, weight, bmi, mood). Identical shape to the generic metric-status card so the `InsightStatusCard` consumes it unchanged. Read-only + stale-while-revalidate: a cache miss warms a generation out of band and serves the last-good text meanwhile.",
  });

// Per-biomarker assessment. The marker is identified by a user-scoped id
// (the generic metric-status route fixes its metric by a closed registry
// enum; biomarkers are user-defined, so the id is a free-form string).
export const biomarkerAssessmentQuery = z
  .object({
    biomarkerId: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "User-scoped biomarker id to assess. A cross-user or unknown id returns an `insufficient` envelope, not a 404 (existence sealed).",
      ),
    locale: z
      .enum(["de", "en"])
      .optional()
      .describe("Optional UI-locale override; defaults to the session locale."),
  })
  .meta({ id: "BiomarkerAssessmentQuery" });

export const biomarkerAssessmentResponse = z
  .object({
    hasProvider: z
      .boolean()
      .describe(
        "False when the user has no usable AI provider — `text` then carries the generic no-key guidance.",
      ),
    text: z
      .string()
      .nullable()
      .describe(
        "The assessment narrative (plain text, rendered as React text children). Null while a first generation is preparing, or when the marker has no numeric readings.",
      ),
    cached: z
      .boolean()
      .describe("True when `text` is served from cache (incl. last-good)."),
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the served assessment was generated; null when none."),
    preparing: z
      .boolean()
      .optional()
      .describe(
        "True when a first assessment is being generated out of band and no prior text exists yet — the client polls until it lands.",
      ),
    revalidating: z
      .boolean()
      .optional()
      .describe(
        "True when `text` is served from last-good cache (stale-while-revalidate) while a fresh generation is in flight. The client keeps polling on `preparing || revalidating` (bounded) so the open card upgrades to the warmed assessment without a remount.",
      ),
    insufficient: z
      .boolean()
      .optional()
      .describe(
        "True when the marker has no numeric readings; no assessment is generated (no LLM call). The card is not rendered.",
      ),
  })
  .meta({
    id: "BiomarkerAssessmentResponse",
    description:
      "Per-biomarker assessment envelope. Identical shape to the generic metric-status card so the `InsightStatusCard` consumes it unchanged. Read-only + stale-while-revalidate: a cache miss warms a generation out of band and serves the last-good text meanwhile; the assessment regenerates only when a new reading lands.",
  });

// The medication-compliance route carries a richer envelope than the
// other six: a `summary` narrative plus a per-medication `text` array,
// instead of a single `text` field.
export const medicationComplianceStatusResponse = z
  .object({
    hasProvider: z
      .boolean()
      .describe(
        "False when the user has no usable AI provider — `summary` then carries the generic no-key guidance.",
      ),
    summary: z
      .string()
      .nullable()
      .describe(
        "The overall compliance narrative (plain text). Null while a first generation is preparing.",
      ),
    medications: z
      .array(
        z
          .object({
            medicationId: z
              .string()
              .describe("The medication this note belongs to."),
            text: z
              .string()
              .describe("Per-medication compliance note (plain text)."),
          })
          .meta({ id: "MedicationComplianceStatusItem" }),
      )
      .describe(
        "Per-medication compliance notes. Empty while preparing or when no medication qualifies.",
      ),
    cached: z
      .boolean()
      .describe(
        "True when the envelope is served from cache (incl. last-good).",
      ),
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the served assessment was generated; null when none."),
    preparing: z
      .boolean()
      .optional()
      .describe(
        "True when a first assessment is being generated out of band and no prior summary exists yet — the client polls until it lands.",
      ),
    revalidating: z
      .boolean()
      .optional()
      .describe(
        "True when the envelope is served from last-good cache (stale-while-revalidate) while a fresh generation is in flight. The client keeps polling on `preparing || revalidating` (bounded).",
      ),
  })
  .meta({
    id: "MedicationComplianceStatusResponse",
    description:
      "Medication-compliance assessment envelope. Unlike the other six specialised cards it carries a `summary` plus a per-medication `text` array rather than a single `text` field. Read-only + stale-while-revalidate.",
  });

export const analyticsRangeQuery = z
  .object({
    type: measurementTypeEnum.describe(
      "The measurement type to read (single metric — no fan-out). Closed enum: an unknown type 422s.",
    ),
    range: z
      .enum(ANALYTICS_RANGES)
      .describe(
        "Trailing window: `7d` / `30d` / `90d` / `1y`. The previous comparable window is the equally-sized span immediately before it.",
      ),
  })
  .meta({ id: "AnalyticsRangeQuery" });

export const analyticsWindowAggregate = z
  .object({
    count: z.number().int().describe("Reading count composed across buckets."),
    min: z.number().nullable().describe("Window minimum; null when empty."),
    max: z.number().nullable().describe("Window maximum; null when empty."),
    mean: z
      .number()
      .nullable()
      .describe("Count-weighted mean across buckets; null when empty."),
    sum: z
      .number()
      .nullable()
      .describe(
        "Cumulative total for cumulative metrics (steps, energy, distance); null when no bucket carries a sum.",
      ),
  })
  .meta({ id: "AnalyticsWindowAggregate" });

export const analyticsRangeResponse = z
  .object({
    range: z
      .enum(ANALYTICS_RANGES)
      .describe("The range that was read (echoes the request)."),
    windowDays: z
      .number()
      .int()
      .describe("Trailing-window length in days for the chosen range."),
    granularity: z
      .string()
      .describe(
        "Rollup granularity the read resolved against (`DAY` / `WEEK` / `MONTH` / `YEAR`, or `none` on a coverage miss).",
      ),
    current: analyticsWindowAggregate.describe(
      "Aggregate over the current window `[now-N, now)`.",
    ),
    previous: analyticsWindowAggregate.describe(
      "Aggregate over the previous comparable window `[now-2N, now-N)`.",
    ),
    delta: z
      .number()
      .nullable()
      .describe(
        "`current.mean - previous.mean`; null when either window has no data (never a misleading 0).",
      ),
    deltaPct: z
      .number()
      .nullable()
      .describe(
        "`delta / previous.mean` as a fraction (0.03 = +3 %); null when the prior window has no / zero mean (no divide-by-zero). The client shows 'no prior-period data' in that case.",
      ),
  })
  .meta({
    id: "AnalyticsRangeResponse",
    description:
      "Single-metric period-over-period aggregate. Reads the current and previous comparable windows from the WMY rollup tier and composes a count-weighted-mean delta. `count/min/max/mean/sum` are linearly composable across buckets; SD/slope/r² are intentionally excluded (not composable).",
  });

export const insightsPregenerateRequest = z.object({}).meta({
  id: "InsightsPregenerateRequest",
  description:
    "No body fields. The user is taken from the session / Bearer and the locale from the session; the warm covers every assessment for that user.",
});

export const insightsPregenerateResponse = z
  .object({
    queued: z
      .boolean()
      .describe("True when the full warm was accepted and enqueued."),
    locale: z
      .enum(["de", "en"])
      .describe("The locale the assessments are being warmed in."),
  })
  .meta({
    id: "InsightsPregenerateResponse",
    description:
      "Acknowledgement that a full assessment warm was enqueued for the calling user. The generation runs out of band; the text lands in the read-only status routes.",
  });

// v1.7.0 — unified dashboard first-paint snapshot. One GET that
// assembles every above-the-fold tile field in a single round-trip.
// Two-phase shape: `tiles` (fast, always present) + `extras` (thick,
// nullable on a rollup-coverage miss). The nested AI / DataSummary
// blocks are typed loosely (`z.record`) to match the comprehensive
// response style above — the strict shapes live in their own Zod
// modules and the iOS client does not consume this web-only route.
export const dataSummaryRecord = z.record(z.string(), z.unknown());

// v1.17.0 — server-authoritative glucose clinical panel. Mirrors
// `GlucoseClinicalMetrics` from `@/lib/analytics/glucose-metrics`: the
// trailing-30-day TIR / GMI / eA1C / CV% headline plus the advanced
// J-index + LBGI/HBGI tier, gated by a `stillLearning` flag so a thin
// spot-data window is never asserted as a clinical AGP. The iOS client
// renders these numbers verbatim and never re-derives them.
export const glucoseClinicalSchema = z
  .object({
    stillLearning: z.boolean(),
    stillLearningReason: z.string().nullable(),
    windowDays: z.number().int(),
    actualSpanDays: z.number(),
    readingCount: z.number().int(),
    meanMgdl: z.number().nullable(),
    distribution: z
      .object({
        tir: z.number(),
        tbrLevel1: z.number(),
        tbrLevel2: z.number(),
        tarLevel1: z.number(),
        tarLevel2: z.number(),
        minutesEquivalent: z.object({
          tir: z.number(),
          tbrLevel1: z.number(),
          tbrLevel2: z.number(),
          tarLevel1: z.number(),
          tarLevel2: z.number(),
        }),
      })
      .nullable(),
    gmi: z.number().nullable(),
    estimatedA1c: z.number().nullable(),
    variability: z
      .object({
        sd: z.number(),
        cv: z.number(),
        unstable: z.boolean(),
      })
      .nullable(),
    advanced: z
      .object({
        jIndex: z.number().nullable(),
        lbgi: z.number(),
        hbgi: z.number(),
      })
      .nullable(),
    isSpotEstimate: z.boolean(),
  })
  .meta({
    id: "GlucoseClinicalMetrics",
    description:
      "Server-authoritative glucose clinical panel over the trailing 30-day window. Figures from sparse spot data are a SPOT-READING ESTIMATE (a % of readings), not a CGM time-in-range AGP; `isSpotEstimate` is derived from reading density (true below ~hourly, false for a continuous CGM stream such as Nightscout) and `stillLearning` gates assertion when the window has too few readings or too short a span. `distribution` carries the Battelino 2019 TIR/TBR/TAR fractions (level-2 nested in level-1) plus minutes-of-a-day equivalents; `gmi` (Bergenstal 2018) + `estimatedA1c` (Nathan 2008 ADAG) derive from the mean; `variability` is SD + CV% with the Monnier 2017 ≥36% instability flag; `advanced` is the disclosure tier — J-index (Wojcicki 1995) + LBGI/HBGI (Kovatchev hypo/hyper risk). All blocks are null when there are no readings; `advanced.jIndex` is null for a single-reading window.",
  });

export const dashboardSnapshotResponse = z
  .object({
    user: z.object({
      username: z.string(),
      timezone: z.string(),
      heightCm: z.number().nullable(),
      dateOfBirth: z.string().nullable(),
      gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
      glucoseUnit: z.string().nullable(),
      onboardingTourCompleted: z.boolean(),
    }),
    layout: z.record(z.string(), z.unknown()),
    // v1.7.0 — full 27-id widget catalogue (16 server-known + 11
    // iOS-only) so a cold-launch first-paint seeds every tile and the
    // layout round-trips in one key. Additive alongside the web
    // `layout` block, which stays byte-identical.
    layoutCatalogue: z
      .array(
        z.object({
          id: z.string(),
          visible: z.boolean(),
          order: z.number().int(),
        }),
      )
      .describe(
        "Full 27-id widget catalogue (server-known + iOS-only) with per-widget visibility + order. iOS-only ids are appended default-invisible. The web dashboard reads `layout`; this block is the cold-launch seed for the native client.",
      ),
    // v1.7.0 — per-chartable-metric latest reading keyed by iOS
    // `MetricKind` raw value (e.g. `oxygenSaturation`,
    // `heartRateVariability`, `bodyMassIndex`). Derived in-process from
    // the slim summaries slice — no extra DB read.
    metricStates: z
      .record(
        z.string(),
        z.object({
          value: z.number(),
          measuredAt: z.string(),
          unit: z.string(),
        }),
      )
      .describe(
        "Latest reading per chartable metric, keyed by the iOS `MetricKind` raw value (the non-obvious raws: `oxygenSaturation`, `totalBodyWater`, `heartRateVariability`, `bodyMassIndex`, `walkingAsymmetryPercentage`, `walkingDoubleSupportPercentage`, `environmentalAudioExposure`, `headphoneAudioExposure`, `activeEnergyBurned`). Each entry carries `value`, `measuredAt` (ISO8601), and the canonical `unit`. Types the user has never logged are omitted.",
      ),
    // v1.18.6 — server-computed band / target math (audit finding #3),
    // resolved from the user's own profile facts (DOB / gender / height /
    // weight-target override). The dashboard reads these instead of
    // recomputing client-side; always present (every sub-field falls back
    // to a neutral default rather than being omitted).
    targetBands: z
      .object({
        bpTargets: z
          .object({
            sysLow: z.number(),
            sysHigh: z.number(),
            diaLow: z.number(),
            diaHigh: z.number(),
          })
          .nullable()
          .describe(
            "Personalised blood-pressure target numbers. Null when the profile has no date of birth.",
          ),
        bpSysRange: z
          .object({
            greenMin: z.number(),
            greenMax: z.number(),
            orangeMin: z.number(),
            orangeMax: z.number(),
          })
          .nullable()
          .describe(
            "Systolic traffic-light range. Null when the profile has no date of birth.",
          ),
        bpDiaRange: z
          .object({
            greenMin: z.number(),
            greenMax: z.number(),
            orangeMin: z.number(),
            orangeMax: z.number(),
          })
          .nullable()
          .describe(
            "Diastolic traffic-light range. Null when the profile has no date of birth.",
          ),
        pulseDisplayRange: z
          .object({
            greenMin: z.number(),
            greenMax: z.number(),
            orangeMin: z.number(),
            orangeMax: z.number(),
          })
          .describe(
            "Resting-pulse display range. Always present — falls back to the AHA reference range with no date of birth.",
          ),
        pulseBands: z
          .array(
            z.object({
              min: z.number(),
              max: z.number(),
              color: z.string(),
              opacity: z.number().optional(),
              strokeOpacity: z.number().optional(),
            }),
          )
          .describe(
            "Resting-pulse chart bands. Always present — AHA fallback with no date of birth.",
          ),
        bodyFatRange: z
          .object({ min: z.number(), max: z.number() })
          .describe("Gender-aware body-fat target range. Always present."),
        bodyFatBands: z
          .array(
            z.object({
              min: z.number(),
              max: z.number(),
              color: z.string(),
              opacity: z.number().optional(),
              strokeOpacity: z.number().optional(),
            }),
          )
          .describe("Body-fat chart bands. Always present."),
        weightRange: z
          .object({
            greenMin: z.number(),
            greenMax: z.number(),
            orangeMin: z.number(),
            orangeMax: z.number(),
          })
          .nullable()
          .describe(
            "Weight traffic-light range: the user's own target band when set, else the height-derived WHO band, else null (no height and no target).",
          ),
        weightBands: z
          .array(
            z.object({
              min: z.number(),
              max: z.number(),
              color: z.string(),
              opacity: z.number().optional(),
              strokeOpacity: z.number().optional(),
            }),
          )
          .nullable()
          .describe(
            "Weight chart bands, from the same range. Null when `weightRange` is null.",
          ),
      })
      .describe(
        "Server-computed band / target math resolved from the user's profile facts, so the client reads these numbers instead of recomputing them. Every sub-field is null only when the driving profile fact is missing (no date of birth for blood pressure, no height and no weight target for weight).",
      ),
    tiles: z.object({
      summaries: dataSummaryRecord,
      lastSeenByType: z.record(z.string(), z.unknown()),
      mood: z.object({
        summary: dataSummaryRecord.nullable(),
        entries: z.array(
          z.object({
            date: z.string(),
            score: z.number(),
            samples: z.number().int(),
          }),
        ),
      }),
      // v1.28.x — additive: source-discrepancy annotation for the latest
      // night behind `summaries.SLEEP_DURATION.latest`. Same shape as the
      // per-session `sourceDiscrepancy` on the sleep-night resource.
      sleepSourceDiscrepancy: z
        .object({
          deltaMinutes: z.number().int().nonnegative(),
          sources: z.array(
            z.object({
              source: z.string(),
              deviceType: z.string().nullable(),
              asleepMinutes: z.number().int().nonnegative(),
            }),
          ),
        })
        .nullable()
        .optional()
        .describe(
          "Non-null when two writer buckets reported clearly different asleep totals for the latest night's main session (> 45 min apart and > 20% of the larger total). Observational only — the served summary stays the winning writer's totals; clients may show a discreet 'sources disagree' hint next to the sleep tile's headline. Null when the writers agree or the sleep module is off; optional for older cached snapshots.",
        ),
    }),
    extras: z
      .object({
        bpInTargetPct: z.number().nullable(),
        bpInTargetPct7d: z.number().nullable(),
        bpInTargetPct30d: z.number().nullable(),
        bpInTargetPctAllTime: z.number().nullable(),
        bpInTargetPctPriorMonth: z.number().nullable(),
        bpInTargetPctPriorYear: z.number().nullable(),
        bpInTargetCount90: z.number().int().nullable(),
        bpInTargetSpanDays90: z.number().int().nullable(),
        glucoseByContext: dataSummaryRecord,
        glucoseClinical: glucoseClinicalSchema,
      })
      .nullable(),
    // Dashboard hero — today's medication block (fast phase, always
    // present). Projection-backed tally + earliest next-due across
    // active medications.
    medsToday: z
      .object({
        activeCount: z.number().int(),
        scheduledToday: z.number().int(),
        takenToday: z.number().int(),
        skippedToday: z.number().int(),
        nextDueAt: z.string().nullable(),
        nextDueOverdue: z.boolean(),
        nextDueMedicationName: z.string().nullable(),
        nextDueMedicationId: z.string().nullable(),
        dueCandidates: z
          .array(
            z.object({
              medicationId: z.string(),
              medicationName: z.string(),
              dueAt: z.string(),
              overdue: z.boolean(),
              availableFrom: z.string(),
            }),
          )
          .optional(),
      })
      .describe(
        "Today's medication block: active-medication count, today-window tally (scheduled / taken / skipped), every active medication's current display-due candidate, and legacy scalar fields projected from candidate zero. `overdue: true` marks an OPEN overdue slot (anchor passed, still inside its catch-up band); `availableFrom` is the canonical cadence- and dose-window-derived attribution-band start. `dueCandidates` is optional so older cached snapshots remain valid. Medication ids let consumers deep-link straight to the relevant card.",
      ),
    // Dashboard hero health score. The additive metadata lets clients suppress
    // false change narratives when eligibility or the algorithm changes.
    healthScore: z
      .object({
        score: z.number().int().min(0).max(100),
        band: z.enum(["green", "yellow", "red"]),
        delta: z.number().nullable(),
        confidence: derivedConfidence.optional(),
        composition: z
          .array(
            z.enum([
              "BLOOD_PRESSURE",
              "GLYCAEMIA",
              "ACTIVITY",
              "SLEEP",
              "ADIPOSITY",
              "WELLBEING",
              "LIPIDS",
            ]),
          )
          .optional(),
        configured: z
          .boolean()
          .optional()
          .describe(
            "True when the account's own recipe narrows the score's composition below what its defaults would resolve to today. Server-resolved, so a client never interprets a configuration blob: an account that kept every pillar reads false, and so does one whose disabled modules alone narrow the set. The configuration itself is never on this wire. Optional so older cached snapshots without the field stay valid.",
          ),
        scoreBasis: healthScoreBasis
          .optional()
          .describe(
            "What the number rests on. Since v1.38 a score is served from one or two areas of health as well as three, computed identically at each, so this is the only field that tells a narrow score from a broad one — render it beside the number. Optional so older cached snapshots without the field stay valid; the live builder always sets it.",
          ),
        deltaReason: z
          .enum([
            "algorithm_changed",
            "config_changed",
            "composition_changed",
            "first_eligibility_window",
            "below_noise_floor",
            "no_previous_window",
            "no_current_score",
          ])
          .nullable()
          .optional(),
        scoreVersion: z.number().int().positive().optional(),
        bandSetter: z
          .enum([
            "BLOOD_PRESSURE",
            "GLYCAEMIA",
            "ACTIVITY",
            "SLEEP",
            "ADIPOSITY",
            "WELLBEING",
            "LIPIDS",
          ])
          .nullable()
          .optional(),
        restMode: z
          .object({
            active: z.boolean(),
            since: z.string().nullable(),
            episodeCount: z.number().int(),
          })
          .nullable()
          .optional(),
        // v1.21.2 (A5) — the Tension Verdict, locale-agnostic. Fires only
        // when the readiness composite's contributors disagree (>=1
        // strongly favourable AND >=1 strongly unfavourable); suppressed
        // (null) under a clinical red-flag so that path dominates.
        tension: z
          .object({
            band: z.enum(["green", "yellow", "red"]),
            positive: z.array(
              z.enum(["rhr", "hrv", "sleep", "respiratory", "mood"]),
            ),
            negative: z.array(
              z.enum(["rhr", "hrv", "sleep", "respiratory", "mood"]),
            ),
          })
          .nullable()
          .optional()
          .describe(
            "Locale-agnostic tension verdict: present only when the readiness composite's contributors disagree. `positive`/`negative` carry readiness contributor keys the client maps to localised labels. Null on a coherent day or when a clinical red-flag suppresses it. Optional so older cached snapshots without the field stay valid.",
          ),
        // v1.21.2 (A6) — return-to-baseline, locale-agnostic. Present only
        // when a salient metric has come back inside the user's own
        // personal range after a prior out-of-band run; at most one.
        returnToBand: z
          .object({
            metricType: measurementTypeEnum,
            daysInside: z.number().int(),
          })
          .nullable()
          .optional()
          .describe(
            "Locale-agnostic return-to-baseline event: present only when a salient metric (resting heart rate, HRV, respiratory rate, or weight) has come back inside the user's own personal range after a genuine prior out-of-band run. At most one, the most salient. `metricType` is the measurement type the client maps to a localised metric name; `daysInside` is how long it has now sat back inside range. Null otherwise. Optional so older cached snapshots without the field stay valid.",
          ),
      })
      .nullable()
      .describe(
        "Derived reference score summary. Since v1.38 it is null only when no pillar is readable at all: one or two areas of health produce a score too, computed identically, with `scoreBasis` saying how broad it is — render that beside the number rather than assuming three areas. Additive metadata names confidence, ordered composition, the worst-pillar band setter, score version, and why a delta was suppressed. Rest Mode annotates but never changes the score.",
      ),
    // v1.27.7 — user-selected hero score rings (max 3), resolved
    // server-side next to the health score. Additive; optional so
    // cached pre-v1.27.7 snapshots stay decodable.
    scoreRings: z
      .array(
        z.object({
          id: z.enum([
            "READINESS",
            "RECOVERY_SCORE",
            "SLEEP_SCORE",
            "MED_COMPLIANCE",
          ]),
          score: z.number().int(),
          band: z.enum(["green", "yellow", "red"]),
          doses: z
            .object({
              taken: z.number().int(),
              scheduled: z.number().int(),
            })
            .optional()
            .describe(
              "MED_COMPLIANCE only — today's dose tally behind the progress score, for a 'taken/scheduled' ring display (e.g. 1/3). Absent on the derived score rings.",
            ),
        }),
      )
      .optional()
      .describe(
        "User-selected hero score rings (max 3, `selectedScoreRings` on the dashboard layout), resolved server-side: READINESS / RECOVERY_SCORE / SLEEP_SCORE via the derived engines (module-gated like `/api/insights/derived`); MED_COMPLIANCE is TODAY's dose progress off the snapshot's medsToday tally — `score` is the rounded 0..100 progress, `doses` carries the taken/scheduled pair, the band is progress semantics (green once every scheduled dose is taken, yellow while doses remain, never red), and the ring is absent when no dose is scheduled today. Only rings with data appear, in selection order — a missing entry means no data or a disabled module, never zero. Clients render what arrives and never recompute.",
      ),
    briefing: z.record(z.string(), z.unknown()).nullable(),
    // v1.21.2 (A4) — server-resolved recall + forward-look for the
    // briefing card, rides the snapshot DTO so iOS reads the same
    // already-localised block the web card renders verbatim.
    briefingMemory: z
      .object({
        recall: z.string(),
        forward: z.string(),
      })
      .nullable()
      .optional()
      .describe(
        "The briefing recall + forward-look: `recall` is the prior period's narrative headline, `forward` points ahead to the most salient trend drift (or a calm 'holding steady' line). Both are already-localised prose the client renders verbatim. Null when no prior narrative is on file or no briefing is shown. Optional so older cached snapshots without the field stay valid.",
      ),
    briefingState: z.enum(["ready", "preparing", "disabled", "no-provider"]),
    briefingUpdatedAt: z.string().nullable(),
    briefingStale: z
      .boolean()
      .describe(
        "True when `briefing` carries the last good (expired-TTL) briefing while a refresh is pending (`preparing`) or impossible (`no-provider`). Render the stale content with its `briefingUpdatedAt` timestamp instead of a blank tile.",
      ),
    generatedAt: z.string(),
  })
  .meta({
    id: "DashboardSnapshotResponse",
    description:
      "Unified above-the-fold dashboard payload. `tiles` always arrives (slim summaries + mood + resolved widget layout); `extras` (BD-in-target + per-context glucose) is null on a rollup-coverage miss so the strip never waits on the slowest read. `briefing` is lifted read-only from the pre-generated insight cache — never generated synchronously — and reports `ready` / `preparing` / `disabled` / `no-provider` via `briefingState` (`no-provider` = stale-or-missing cache with no AI provider configured anywhere, so no warm pass will fill it; stop polling and surface a connect-provider hint). A stale-but-parseable briefing is still delivered with `briefingStale: true`. `layoutCatalogue` (full 27-id widget catalogue) and `metricStates` (latest reading per metric, keyed by iOS `MetricKind` raw value) are additive cold-launch seeds for the native client; both derive in-process from data already fetched, adding no DB round-trip.",
  });

// v1.4.31 — the iOS "cards" adapter over the same alert rule engine the
// web comprehensive surface consumes. Each card is one `HealthAlert`
// re-shaped to the iOS Insight model. Module-gated on `insights` and the
// operator `insightStatus` assistant surface.
const insightCard = z
  .object({
    id: z.string().describe("Stable per-card id (e.g. `alert-1`)."),
    title: z.string(),
    summary: z.string().describe("One-line alert message."),
    body: z
      .string()
      .nullable()
      .describe("Longer narrative; null on the current rule-engine cards."),
    severity: z
      .enum(["alert", "caution", "info", "good"])
      .describe(
        "Mapped from the underlying alert level (danger→alert, warning→caution, success→good, else info).",
      ),
    recommendations: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          actionURL: z.string().nullable(),
        }),
      )
      .describe(
        "Suggested follow-ups; empty on the current rule-engine cards.",
      ),
    generatedAt: z.iso.datetime({ offset: true }),
    provider: z
      .string()
      .describe(
        "Lower-cased AI provider label for the account (e.g. `claude`).",
      ),
  })
  .meta({
    id: "InsightCard",
    description:
      "One iOS insight card, re-shaped from a server-side HealthAlert. Deterministic rule-engine output — no LLM call on this path.",
  });

export const insightsCardsResponse = z
  .array(insightCard)
  .meta({ id: "InsightsCardsResponse" });

// v1.28.50 — ECG recording surface. The device's own AFib verdict, verbatim.
// Only three RhythmClassification values occur for an ECG strip; the field is
// nullable when the source omitted a classification.
const ecgClassification = z
  .enum(["IRREGULAR", "NOT_DETECTED", "INCONCLUSIVE"])
  .nullable()
  .describe(
    "The RECORDING DEVICE's own rhythm classification, surfaced verbatim: IRREGULAR (device flagged possible atrial fibrillation), NOT_DETECTED (algorithm ran, nothing flagged), INCONCLUSIVE (poor signal / out-of-range HR). Null when the source reported none. HealthLog never re-classifies an ECG — this is the device's certified on-device result, not a HealthLog verdict.",
  );

const ecgRecordingListItem = z
  .object({
    id: z.string().describe("Recording id (cuid)."),
    recordedAt: z.iso
      .datetime({ offset: true })
      .describe("On-device recording time (the display timestamp)."),
    durationSeconds: z
      .number()
      .nullable()
      .describe(
        "`sampleCount / samplingFrequency` in seconds; null when the source omitted the sampling frequency.",
      ),
    samplingFrequency: z
      .number()
      .int()
      .describe(
        "Signal sampling rate in Hz (Withings ScanWatch = 300); 0 when the source omitted it.",
      ),
    sampleCount: z
      .number()
      .int()
      .describe("Number of samples in the (encrypted) waveform array."),
    averageHeartRate: z
      .number()
      .int()
      .nullable()
      .describe(
        "Source-reported average heart rate (BPM) for the strip, when present.",
      ),
    lead: z
      .string()
      .nullable()
      .describe(
        "Recording lead label when the source reports it; null for the single-lead ScanWatch (Lead I).",
      ),
    classification: ecgClassification,
    source: z
      .string()
      .describe("Measurement source that wrote the recording (e.g. WITHINGS)."),
    hasWaveform: z
      .boolean()
      .describe(
        "True when a waveform is stored (`sampleCount > 0`); false for a verdict-only fallback event with no signal to fetch.",
      ),
  })
  .meta({ id: "EcgRecordingListItem" });

export const ecgListResponse = z
  .object({
    recordings: z
      .array(ecgRecordingListItem)
      .describe("The user's ECG recordings, newest first (capped at 200)."),
    hasRecordings: z
      .boolean()
      .describe(
        "False for an account with no recordings — the client un-mounts the whole ECG surface (data-availability floor).",
      ),
  })
  .meta({
    id: "EcgListResponse",
    description:
      "Metadata-only ECG recording list. Never carries the waveform — the per-recording strip is fetched on demand from GET /api/insights/ecg/{id}. Read-only; no LLM call. Reflects only the device's own classification, never a HealthLog interpretation.",
  });

export const ecgDetailQuery = z
  .object({
    full: z
      .literal("1")
      .optional()
      .describe(
        "`1` returns the RAW, un-decimated sample array (the true-calibration 25 mm/s · 10 mm/mV zoom view). Omitted returns the min/max-decimated ~2500-point fit-to-width overview (`decimated: true`).",
      ),
  })
  .meta({ id: "EcgDetailQuery" });

export const ecgDetailResponse = z
  .object({
    recordedAt: z.iso
      .datetime({ offset: true })
      .describe("On-device recording time (the display timestamp)."),
    durationSeconds: z
      .number()
      .nullable()
      .describe(
        "Strip duration in seconds; null when the sampling frequency was 0.",
      ),
    samplingFrequency: z
      .number()
      .int()
      .describe("Signal sampling rate in Hz (300 for a ScanWatch)."),
    averageHeartRate: z
      .number()
      .int()
      .nullable()
      .describe(
        "Source-reported average heart rate (BPM) for the strip, when present.",
      ),
    lead: z
      .string()
      .nullable()
      .describe(
        "Recording lead label when reported; null for the single-lead ScanWatch (Lead I).",
      ),
    classification: ecgClassification,
    source: z.string().describe("Measurement source that wrote the recording."),
    samples: z
      .array(z.number())
      .describe(
        "Micro-volt waveform samples. Min/max-decimated to ~2500 points by default so R-wave peaks survive the fit-to-width compression; the raw array when `?full=1`. The x-position of each sample is implied by its index (an overview trace, not a calibrated-time axis) unless `decimated` is false.",
      ),
    decimated: z
      .boolean()
      .describe(
        "True when `samples` was min/max-decimated for display; false when the raw array is returned (`?full=1`, or a strip already at or below the display budget).",
      ),
  })
  .meta({
    id: "EcgDetailResponse",
    description:
      "One ECG recording's decrypted waveform plus metadata and the DEVICE's verbatim classification. Ownership is narrowed in the query where — a foreign / unknown id 404s. The waveform is AES-256-GCM at rest, decrypted through the fail-closed codec. HealthLog does not interpret the trace, measure intervals, annotate beats, or emit a verdict of its own. no-store.",
  });

// The live ECG ingest. One recording per request: a 30 s Apple Watch strip at
// 512 Hz is ~15 360 samples, so a batch of them is not a shape anyone wants on
// the wire. `userId` is never a body field — it comes from the session.
export const ecgIngestRequest = z
  .object({
    externalRecordingId: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "The recording's stable id AS THE CLIENT KNOWS IT — for an Apple Health client, the `HKSample.uuid`. It is the source's own identity, not a content hash: re-posting the same id overwrites that recording in place. It does not have to agree with the id the `export.zip` importer derives for the same strip; the server reconciles the two doors itself (see `status: duplicate`).",
      ),
    recordedAt: z.iso
      .datetime({ offset: true })
      .describe(
        "When the strip was recorded on-device, with offset. Part of the recording's identity — see `status: duplicate`.",
      ),
    samplingFrequency: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .describe(
        "Signal sampling rate in Hz (an Apple Watch ECG is 512). Part of the recording's identity, and the divisor for the server-derived `durationSeconds`.",
      ),
    samples: z
      .array(z.number().int().min(-1_000_000).max(1_000_000))
      .min(1)
      .max(32_768)
      .describe(
        "The waveform as INTEGER MICRO-VOLTS, in recording order — the same unit the `export.zip` CSV parser produces, so convert from HealthKit's Volts before sending. Capped at 32 768 samples (a clean factor of two above a 30 s / 512 Hz strip). Stored AES-256-GCM encrypted; never persisted as plaintext.",
      ),
    lead: z
      .string()
      .min(1)
      .max(40)
      .nullable()
      .optional()
      .describe("Recording lead label when the device reports one (e.g. `I`)."),
    averageHeartRate: z
      .number()
      .int()
      .min(1)
      .max(300)
      .nullable()
      .optional()
      .describe("The device's average heart rate (BPM) for the strip."),
    classification: ecgClassification
      .optional()
      .describe(
        "The RECORDING DEVICE's own verdict, stored verbatim. Only the three ECG values are accepted here. `RhythmClassification` in the database has six members because walking-steadiness and neutral event verdicts share it, and those appear on GET /api/insights/rhythm-events — a decoder generated from this schema must NOT be reused there. HealthLog never reads the waveform to produce or revise a verdict.",
      ),
    source: z
      .enum(["APPLE_HEALTH"])
      .describe(
        "The client's own source. `APPLE_HEALTH` only: `WITHINGS` rows are minted by the OAuth sync and `COMPUTED` ones by the server, so neither is client-assertable — the same posture POST /api/measurements/batch takes.",
      ),
  })
  .meta({
    id: "EcgIngestRequest",
    description:
      "One Apple Watch ECG recording. Unknown keys are REJECTED with a 422 naming them rather than silently dropped, because every field here is load-bearing metadata for a stored recording. `sampleCount` and `durationSeconds` are derived server-side and must not be sent.",
  });

export const ecgIngestResponse = z
  .object({
    id: z.string().describe("The recording row's id (cuid)."),
    status: z
      .enum(["inserted", "updated", "duplicate"])
      .describe(
        "What the write did. `inserted` — a new recording landed (HTTP 201). `updated` — this `externalRecordingId` was already stored and the row was overwritten in place (HTTP 200); a retry is safe and creates nothing. `duplicate` — this exact recording is already stored under a DIFFERENT id, i.e. it arrived earlier through the `export.zip` importer (HTTP 200); nothing was written and `id` names the row that already holds it. A recording is the same recording when `(source, recordedAt, samplingFrequency)` match, which is enforced by a unique index rather than by convention. All three statuses mean the recording is stored and the client may advance its cursor.",
      ),
    recordedAt: z.iso
      .datetime({ offset: true })
      .describe("The `recordedAt` that was submitted, echoed back."),
    sampleCount: z
      .number()
      .int()
      .describe("Server-derived: the number of samples received."),
    durationSeconds: z
      .number()
      .nullable()
      .describe("Server-derived: `sampleCount / samplingFrequency`."),
  })
  .meta({
    id: "EcgIngestResponse",
    description:
      "The outcome of one ECG ingest. Reported honestly rather than optimistically — a re-post never claims to have inserted.",
  });

// v1.10.0 — device-flagged event timeline (rhythm-events, WX-B). Deliberately
// a SEPARATE enum from `ecgClassification` above: an EVENT row's
// `rhythmClassification` carries the FULL RhythmClassification set (the
// three ECG verdicts + the two walking-steadiness severities + the neutral
// "event occurred" verdict), not just the three ECG-only values. Reusing
// `ecgClassification` here would silently drop LOW / VERY_LOW / FIRED for
// any client that generates its type from this schema.
const rhythmEventType = z
  .enum([
    "IRREGULAR_RHYTHM_NOTIFICATION",
    "HIGH_HEART_RATE_EVENT",
    "LOW_HEART_RATE_EVENT",
    "WALKING_STEADINESS_EVENT",
    "BREATHING_DISTURBANCE_EVENT",
  ])
  .describe(
    "The HealthKit category the device flagged. IRREGULAR_RHYTHM_NOTIFICATION (`HKCategoryTypeIdentifierIrregularHeartRhythmEvent` + ScanWatch AFib screening), HIGH_HEART_RATE_EVENT / LOW_HEART_RATE_EVENT (a sustained heart rate above / below the user's configured threshold while apparently inactive), WALKING_STEADINESS_EVENT (`HKCategoryTypeIdentifierAppleWalkingSteadinessEvent`; the severity rides in `classification`), BREATHING_DISTURBANCE_EVENT (`HKCategoryTypeIdentifierSleepApneaEvent` + `AppleSleepingBreathingDisturbances`, an elevated breathing-disturbance / possible sleep-apnea screening signal).",
  );

const rhythmEventClassification = z
  .enum([
    "IRREGULAR",
    "NOT_DETECTED",
    "INCONCLUSIVE",
    "LOW",
    "VERY_LOW",
    "FIRED",
  ])
  .nullable()
  .describe(
    "The RECORDING DEVICE's own verdict, surfaced verbatim. IRREGULAR / NOT_DETECTED / INCONCLUSIVE are the ECG-style rhythm verdicts (device flagged a possible irregular rhythm / algorithm ran and found nothing / signal too poor to classify) and occur on an `IRREGULAR_RHYTHM_NOTIFICATION` row. LOW / VERY_LOW are walking-steadiness severities and occur on a `WALKING_STEADINESS_EVENT` row. FIRED is the neutral \"event occurred\" verdict with no severity gradient, and occurs on a `HIGH_HEART_RATE_EVENT` / `LOW_HEART_RATE_EVENT` / `BREATHING_DISTURBANCE_EVENT` row. Null when the source reported none. HealthLog never re-classifies — this is the device's certified on-device result. Distinct from `EcgRecordingListItem.classification` / `EcgDetailResponse.classification` above, which are scoped to the three ECG-only values.",
  );

const rhythmEventListItem = z
  .object({
    id: z.string().describe("Measurement row id (cuid)."),
    type: rhythmEventType,
    classification: rhythmEventClassification,
    occurredAt: z.iso
      .datetime({ offset: true })
      .describe("Device-reported event time (`measuredAt`)."),
    source: measurementSourceEnum,
    deviceType: z
      .string()
      .nullable()
      .describe(
        "Device class that reported the event (`watch | band | ring | phone | scale | other | unknown`); null when the source omitted it (treated as `unknown`).",
      ),
  })
  .meta({ id: "RhythmEventListItem" });

export const rhythmEventsResponse = z
  .object({
    events: z
      .array(rhythmEventListItem)
      .describe(
        "The user's device-flagged events, newest first (capped at 200).",
      ),
    hasEvents: z
      .boolean()
      .describe(
        "False for an account with no event rows — the client un-mounts the whole surface (data-availability floor).",
      ),
  })
  .meta({
    id: "RhythmEventsResponse",
    description:
      "Timeline of device-flagged EVENT rows (irregular-rhythm / high-HR / low-HR / walking-steadiness / breathing-disturbance) the user's wearable (Apple Watch / Withings ScanWatch) already produced and synced. AWARENESS / SCREENING of the DEVICE's own decision — HealthLog stores and reflects the classification result verbatim, never a raw waveform, and never re-classifies. Read-only; no LLM call.",
  });

// ── The analytics envelope (`GET /api/analytics`) ─────────────────────
//
// The oldest composite read in the application, and it was never in the
// registry: `openapi:check` compares the registry against the YAML and never
// the ROUTE TREE against the registry, so a route registered nowhere drifted
// with nothing going red.
//
// Two response shapes behind one path. `?slice=summaries` answers the slim
// slice (per-type summaries only, resolved from two SQL passes); every other
// request — including a `slice` value the route does not recognise — answers
// the thick default. They share `summaries` / `lastSeenByType` /
// `sleepSourceDiscrepancy` and agree on nothing else, so both are described
// rather than merged into an all-optional shape that would describe neither.

export const trendSlope = z
  .object({
    slope: z.number().describe("Least-squares slope in units per day."),
    direction: z.enum(["up", "down", "stable"]),
    confidence: z.number().describe("R² of the fit, 0..1."),
  })
  .meta({ id: "TrendSlope" });

export const dataSummary = z
  .object({
    count: z.number().int(),
    latest: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    mean: z.number().nullable(),
    median: z
      .number()
      .nullable()
      .describe(
        "50th percentile over the trailing 90 days on this route (the SQL path fixes that window). Linear-interpolated midpoint. Null on an empty series.",
      ),
    avg7: z.number().nullable(),
    avg30: z.number().nullable(),
    slope7: trendSlope.nullable(),
    slope30: trendSlope
      .nullable()
      .describe(
        "Regression over the trailing window, anchored on NOW rather than on the newest reading — a series that stopped weeks ago reports null rather than a stale slope.",
      ),
    avg30LastMonth: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Mean over the 30 days ending 30 days ago — the prior period a tile's delta caption compares against.",
      ),
    avg30LastYear: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Mean over the 30 days ending 365 days ago. Populated only for types whose WEEK/MONTH/YEAR rollup tier carries the year-ago window.",
      ),
  })
  .meta({
    id: "DataSummary",
    description:
      "Per-measurement-type summary. Every statistic is null on an empty series rather than 0, so a client never charts a zero it was never given. `anomalyCount` and `slope90` were computed here historically and left this wire in v1.37.19 — they are not fields of this shape.",
  });

const lastSeenSlot = z
  .object({
    lastSeenAt: z.iso.datetime({ offset: true }),
    daysAgo: z
      .number()
      .int()
      .describe(
        "Whole days since `lastSeenAt`, re-derived per request rather than served from the cache, so the staleness caption stays correct across a day boundary.",
      ),
  })
  .nullable();

const sleepSourceDiscrepancy = z
  .object({
    deltaMinutes: z.number().int().nonnegative(),
    sources: z.array(
      z.object({
        source: z.string(),
        deviceType: z.string().nullable(),
        asleepMinutes: z.number().int().nonnegative(),
      }),
    ),
  })
  .nullable()
  .describe(
    "Non-null when two writer buckets reported clearly different asleep totals for the night behind `summaries.SLEEP_DURATION.latest`. Observational only — the served summary stays the winning writer's totals.",
  );

export const analyticsSummariesSliceResponse = z
  .object({
    summaries: z
      .record(z.string(), dataSummary)
      .describe("Keyed by MeasurementType. Types with no data are omitted."),
    bmi: z
      .null()
      .describe(
        "Always null on this slice — BMI is derived on the default slice from `summaries.WEIGHT.latest` and the profile height. The key is present so the two slices decode into one type.",
      ),
    lastSeenByType: z.record(z.string(), lastSeenSlot),
    sleepSourceDiscrepancy,
  })
  .meta({
    id: "AnalyticsSummariesSlice",
    description:
      "The slim `?slice=summaries` answer: the per-type summaries the dashboard tile strip needs, resolved from two SQL passes over the rollup tier instead of the default slice's thirty-query chain. Drops correlations, the health score, the BP-in-target block, per-context glucose and the sleep-stage breakdown.",
  });

const analyticsCorrelationOk = z.object({
  kind: z.string().describe("Hypothesis identity."),
  status: z.literal("ok"),
  statistic: z
    .number()
    .describe(
      "Pearson r for the BP-compliance and mood-pulse hypotheses; eta-squared for the weight-weekday one.",
    ),
  n: z.number().int(),
  pValue: z.number().describe("Two-sided. Below 0.05 to surface at all."),
  confidenceBand: z.unknown().describe("95 % confidence band for the UI chip."),
  interpretation: z
    .string()
    .describe(
      "One already-localised conservative sentence, rendered verbatim. Never claims causation. Localised per reader, which is why the cached envelope is keyed by locale.",
    ),
  points: z.array(z.object({ x: z.number(), y: z.number() })),
  xLabel: z.string(),
  yLabel: z.string(),
  patternId: z.string().optional(),
  canonicalKey: z.string().optional(),
  dismissed: z.boolean().optional(),
});

const analyticsCorrelationInsufficient = z.object({
  kind: z.string(),
  status: z.literal("insufficient"),
  n: z.number().int().describe("What was counted, even below the threshold."),
  reason: z.enum(["too_few_pairs", "not_significant", "no_variance"]),
  points: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .describe("Preview points the empty state can hint progress with."),
});

const analyticsCorrelation = z
  .union([analyticsCorrelationOk, analyticsCorrelationInsufficient])
  .describe(
    "Discriminated on `status`. The `ok` arm carries the statistic and its narration; the `insufficient` arm carries neither and says why. The pattern fields (`patternId` / `canonicalKey` / `dismissed`) ride the `ok` arm only, and only once the hypothesis has been persisted.",
  );

const healthScoreDerivedInsufficient = z.object({
  status: z.literal("insufficient"),
  coverage: derivedCoverage,
  provenance: derivedProvenance,
  reason: z
    .string()
    .describe(
      "Why no score exists. `no_usable_data` — not one selected pillar has enough recent data to grade. Since v1.38 this is the only value the composite produces; the former `three_domains_required` / `measured_physiological_domain_required` refusals are gone, because a narrow set now scores and labels itself.",
    ),
});

const healthScoreComposite = z
  .union([
    z.object({
      status: z.literal("ok"),
      value: z.object({
        score: z.number(),
        band: z.enum(["green", "yellow", "red"]),
        bandSetter: z
          .string()
          .nullable()
          .describe(
            "The pillar that lowered the mean score's band; null when no pillar did.",
          ),
        composition: z
          .array(z.string())
          .describe(
            "Registry-ordered eligible pillar ids. Part of the number's identity: two scores with different compositions are not comparable.",
          ),
        configured: z
          .boolean()
          .describe(
            "True when the account's own recipe narrows the composition below what its defaults would resolve to today. The configuration blob itself is never on this wire.",
          ),
        scoreBasis: healthScoreBasis
          .optional()
          .describe(
            "What the number rests on — how many distinct areas of health were counted against how many the method recommends, and whether any of them was a physiological measurement. Optional so a composite cached before v1.38 stays valid; the live scorer always sets it.",
          ),
        noiseFloor: z.number(),
        scoreVersion: z.number().int(),
      }),
      coverage: derivedCoverage,
      confidence: derivedConfidence,
      provenance: derivedProvenance,
    }),
    healthScoreDerivedInsufficient,
  ])
  .describe(
    "Discriminated on `status`. The `insufficient` arm carries NO `value` and NO `confidence` key at all — they are absent, not null — which is how a composite reads when NO pillar has usable data. Since v1.38 that is the only case: one or two eligible areas of health produce a score too, labelled by `value.scoreBasis`.",
  );

const healthScorePillar = z.object({
  id: z.string().describe("Pillar id."),
  domain: z
    .enum(["cardiometabolic", "activity", "sleep", "adiposity", "wellbeing"])
    .describe(
      "Which area the pillar speaks to. Three of the seven pillars share `cardiometabolic`, so four selected pillars can still be one area — which is why `scoreBasis.domains` is served resolved and must not be counted out of `composition`.",
    ),
  result: z
    .union([
      z.object({
        status: z.literal("ok"),
        value: z.object({
          score: z.number(),
          observed: z.object({
            value: z.number(),
            unit: z.string(),
            label: z
              .string()
              .describe("Complete display value, paired values included."),
            asOf: z.string(),
            sources: z.array(z.string()),
          }),
          reference: z.object({
            kind: z.enum([
              "clinical-threshold",
              "population-percentile",
              "guideline-band",
            ]),
            low: z.number().nullable(),
            high: z.number().nullable(),
            label: z.string(),
            source: z.string(),
          }),
          personalReference: z
            .unknown()
            .optional()
            .describe(
              "The user's own yardstick, same shape as `reference`, shown beside the scored one. Absent when there is none — the pillar is always GRADED against the reference, never against this.",
            ),
          scoreBasis: z
            .unknown()
            .optional()
            .describe(
              "Which input set the score and by how much. Blood pressure only today: it is the one pillar that scores the WORSE of two axes, so the number alone cannot say which one it came from. A pillar with nothing of the kind to say omits the key.",
            ),
          noiseFloor: z.number(),
          deltaEligible: z
            .boolean()
            .describe(
              "False for slow markers, which contribute to the level but never to the weekly delta.",
            ),
          deltaIdentity: z.string(),
        }),
        coverage: derivedCoverage,
        confidence: derivedConfidence,
        provenance: derivedProvenance,
      }),
      healthScoreDerivedInsufficient,
    ])
    .describe("Same `Derived<T>` union as the composite."),
});

export const healthScoreReport = z
  .object({
    composite: healthScoreComposite,
    pillars: z
      .array(healthScorePillar)
      .describe("Every pillar the scorer evaluated, eligible or not."),
    delta: z
      .number()
      .nullable()
      .describe(
        "Week-over-week move; null whenever `deltaReason` explains why there is none.",
      ),
    deltaReason: z
      .enum([
        "algorithm_changed",
        "config_changed",
        "composition_changed",
        "first_eligibility_window",
        "below_noise_floor",
        "no_previous_window",
        "no_current_score",
      ])
      .nullable()
      .describe(
        "Why the delta was suppressed. `config_changed` is the one that is easy to misread as a health event: the person changed their own recipe inside the comparison window, so both windows computed under the new recipe and the arithmetic only looks comparable.",
      ),
    scoreVersion: z
      .number()
      .int()
      .describe(
        "The scoring METHOD's identity, not the schema version. It moves when the rules move, which is what lets a stored day say which rules produced it.",
      ),
    weightGoal: z
      .union([
        z.object({
          status: z.literal("ok"),
          value: z.object({
            currentKg: z.number(),
            target: z.object({ min: z.number(), max: z.number() }),
            distanceKg: z.number(),
            deltaKg: z
              .number()
              .nullable()
              .describe("Positive means the distance to the band narrowed."),
            asOf: z.string(),
            source: z.string(),
          }),
          coverage: derivedCoverage,
          confidence: derivedConfidence,
          provenance: derivedProvenance,
        }),
        healthScoreDerivedInsufficient,
      ])
      .describe("Same `Derived<T>` union again."),
    algorithmNotice: z
      .object({ itemKey: z.string(), dismissed: z.boolean() })
      .nullable()
      .describe(
        "The once-per-account notice that the scoring rules moved; null when there is nothing to say.",
      ),
    compositionNotice: z
      .object({
        itemKey: z.string(),
        left: z.array(z.string()),
        joined: z.array(z.string()),
        dismissed: z.boolean(),
      })
      .nullable()
      .optional()
      .describe(
        "A pillar joined or left the set behind the number since the account's last stored local day. Raised only for a change nobody chose — a method move or a recipe change is the algorithm notice's subject, and raising both would announce one event twice. Null when there is nothing to say.",
      ),
    restMode: z
      .object({
        active: z.literal(true),
        since: z.string().nullable(),
        episodeCount: z.number().int(),
      })
      .nullable()
      .optional()
      .describe(
        "Set on every response this route produces (null when no illness episode is active). Rest Mode FRAMES the score and never changes it: the number above is left exactly as computed and this attaches the value-free context. Resolved as of the scored window, not a fresh now.",
      ),
  })
  .meta({
    id: "HealthScoreReport",
    description:
      "The versioned cardiometabolic reference score: the composite, every pillar with its own observation and reference band, the week-over-week delta with the reason it may be absent, the weight-goal derivation and the algorithm notice. Recorded to the score history as a side effect of this read.",
  });

const sleepStageComposition = z
  .object({
    windowDays: z.number().int(),
    nights: z
      .number()
      .int()
      .describe("Nights carrying at least one stage entry in the window."),
    totalMinutes: z
      .number()
      .describe("Sum of every value in `stages` — nights only, naps excluded."),
    stages: z
      .record(z.string(), z.number())
      .describe("Window totals per stage, naps excluded."),
    perNight: z.array(
      z.object({
        dayKey: z
          .string()
          .describe("Wake-day key `YYYY-MM-DD` in the account's timezone."),
        stages: z
          .record(z.string(), z.number())
          .describe(
            "Per-stage minutes of the MAIN night only. `IN_BED` is the session envelope and is carried as such.",
          ),
        napMinutes: z
          .number()
          .optional()
          .describe(
            "Time asleep across the day's naps. ABSENT on a day without one — there is no zero to render and nothing to caption.",
          ),
        napCount: z
          .number()
          .int()
          .optional()
          .describe("Absent alongside `napMinutes`."),
      }),
    ),
  })
  .nullable()
  .describe(
    "Trailing-30-day per-stage breakdown, null when no session in the window carries stage data. Sessions are reconstructed and collapsed to one canonical source per night before the sum, so a dual-source night is not double-counted and a midnight-spanning night is not split across two days.",
  );

export const analyticsDefaultSliceResponse = z
  .object({
    summaries: z.record(z.string(), dataSummary),
    bmi: z
      .number()
      .nullable()
      .describe(
        "Derived from the latest weight and the profile height, one decimal. Null without a height or without a weight reading.",
      ),
    bpInTargetPct: z
      .number()
      .nullable()
      .describe(
        "Trailing-90-day in-target percentage — the headline window. Null without personalised targets (which need a date of birth) or without readings.",
      ),
    bpInTargetPct7d: z.number().nullable(),
    bpInTargetPct30d: z.number().nullable(),
    bpInTargetPctAllTime: z.number().nullable(),
    bpInTargetPctPriorMonth: z.number().nullable(),
    bpInTargetPctPriorYear: z
      .number()
      .nullable()
      .describe(
        "Period-aligned prior windows, so a comparison caption's arithmetic matches its label.",
      ),
    bpInTargetCount90: z
      .number()
      .int()
      .nullable()
      .describe("Readings behind the 90-day figure, for the thin-data gate."),
    bpInTargetSpanDays90: z
      .number()
      .int()
      .nullable()
      .describe("Effective span the 90-day figure actually covers."),
    glucoseByContext: z
      .record(z.string(), dataSummary)
      .nullable()
      .describe(
        "Per-context summaries (`FASTING` / `POSTPRANDIAL` / `RANDOM` / `BEDTIME`, plus `UNSPECIFIED` for readings whose source recorded no meal-time context) over the trailing 30 days, canonical mg/dL. A bucket with no readings is omitted. NULL — not an empty object — when the glucose module is off.",
      ),
    glucoseClinical: glucoseClinicalSchema
      .nullable()
      .describe(
        "The clinical panel over the same 30-day window, always populated when the module is on (even with zero readings, so the client renders the calm still-learning state from an object rather than a missing key). Null when the glucose module is off.",
      ),
    correlations: z
      .object({
        bpCompliance: analyticsCorrelation,
        moodPulse: analyticsCorrelation,
        weightWeekday: analyticsCorrelation,
        degraded: z
          .boolean()
          .describe(
            "Reserved for a load-shedding branch. Pinned false by both current paths — do not branch on it yet.",
          ),
        windowDays: z
          .number()
          .int()
          .describe("The window actually scanned, in days (28 today)."),
        path: z
          .enum(["rollup", "live"])
          .describe(
            "Which read served the measurement side. Falls to `live` for an account more than three hours from UTC, where the rollup table's UTC-midnight day key would slip a calendar day against the mood and intake streams.",
          ),
      })
      .describe(
        "The three pre-defined hypotheses over a 28-day window. Descriptive, never causal.",
      ),
    healthScore: healthScoreReport,
    sleepStages: sleepStageComposition,
    sleepSourceDiscrepancy,
    lastSeenByType: z.record(z.string(), lastSeenSlot),
  })
  .meta({
    id: "AnalyticsDefaultSlice",
    description:
      "The thick default answer: per-type summaries plus BMI, the blood-pressure in-target windows, the glucose blocks, the three correlation hypotheses, the full health-score report, the sleep-stage breakdown and the freshness map. Every block is deterministic — no LLM is reachable from this path.",
  });

export const analyticsQuery = z
  .object({
    slice: z
      .literal("summaries")
      .optional()
      .describe(
        "Send `summaries` for the slim slice. Any OTHER value — including a misspelling — falls through to the thick default rather than 422-ing, so a typo costs latency and not an error.",
      ),
  })
  .meta({ id: "AnalyticsQuery" });

export const analyticsResponse = z
  .union([analyticsDefaultSliceResponse, analyticsSummariesSliceResponse])
  .describe(
    "Which shape arrives is decided by `slice`, not by the data: `?slice=summaries` answers `AnalyticsSummariesSlice`, everything else answers `AnalyticsDefaultSlice`.",
  );

// ── Insights provider settings (`/api/insights/settings`) ─────────────

export const insightsSettingsResponse = z
  .object({
    codexStatus: z
      .string()
      .describe(
        "The account's own ChatGPT-OAuth connection state; `disconnected` when the account row carries none.",
      ),
    codexConnectedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When that connection was made; null when never connected."),
    hasAdminKey: z
      .boolean()
      .describe(
        "Presence only: whether the operator has stored a shared AI key. The key itself never leaves the server.",
      ),
    codexOauthConfigured: z
      .boolean()
      .describe(
        "Whether the operator configured an OAuth client id. False means the connect flow is dead end-to-end, so hide the button rather than sending the user to a login they can never complete.",
      ),
    centralCodexAvailable: z
      .boolean()
      .describe(
        "Presence only: whether the operator has connected the shared central ChatGPT account AND all three of its stored credentials are present. The encrypted credentials themselves are NEVER returned to a non-admin client.",
      ),
    useCentralCodex: z
      .boolean()
      .describe(
        "The account's own opt-in to that shared connection. Off by default everywhere.",
      ),
    privacyMode: z
      .enum(["aggregated", "raw"])
      .describe(
        "What leaves for the provider: aggregated figures or raw readings. `aggregated` when the account has never chosen.",
      ),
    lastInsightAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the cached insight text was last written."),
  })
  .meta({
    id: "InsightsSettingsResponse",
    description:
      "The account's AI-provider settings as the settings surface reads them. Every operator-side field is presence-only — no key, token or account id is ever on this wire.",
  });

export const insightsSettingsPutRequest = z
  .object({
    privacyMode: z
      .enum(["aggregated", "raw"])
      .optional()
      .describe(
        "The only field this endpoint writes. Changing it CLEARS the cached insight text and its timestamp, so the next read regenerates under the new mode rather than serving text produced under the old one.",
      ),
  })
  .meta({
    id: "InsightsSettingsPutRequest",
    description:
      "Partial settings update. The body is read key by key rather than parsed as a whole: unknown keys are IGNORED, not refused, and a body that changes nothing recognised is refused with 422 rather than answered as a no-op. `privacyMode` is the only writable field today.",
  });

// ── Target tiles (`GET /api/insights/targets`) ────────────────────────

const targetItem = z
  .object({
    type: z
      .string()
      .describe(
        "Target identity. A MeasurementType token for the vital tiles, and a domain token for the derived ones (sleep, medication compliance, mood, the glucose tiles).",
      ),
    label: z.string().describe("Already-resolved display label."),
    current: z.number().nullable(),
    average30: z.number().nullable(),
    trend: z
      .enum(["up", "down", "stable"])
      .nullable()
      .describe("Null when there is not enough series to call one."),
    unit: z.string(),
    range: z
      .object({ min: z.number(), max: z.number() })
      .nullable()
      .describe(
        "The band the tile grades against, resolved from the account's own profile facts and any personal override. Null when no band can be resolved.",
      ),
    classification: z
      .object({ category: z.string(), color: z.string() })
      .nullable()
      .describe("Where the current value sits in the band; null without one."),
    source: z
      .string()
      .describe("Provenance token for the 'where this comes from' link."),
    daysInRange7d: z.number().int(),
    daysLogged7d: z.number().int(),
    daysInRange30d: z.number().int(),
    daysLogged30d: z.number().int(),
    lastMetGoalAt: z.string().nullable(),
    streakDays: z.number().int(),
    insufficientData: z
      .boolean()
      .describe(
        "True when the consistency figures are below their floor. Render the calm learning state instead of the strip.",
      ),
    consistency7d: z
      .array(z.enum(["in", "near", "out"]).nullable())
      .describe(
        "Seven day bands, oldest first. A null entry is an UNLOGGED day, which is not the same as an out-of-range one.",
      ),
    details: z
      .object({
        medications: z
          .array(
            z.object({
              name: z.string(),
              compliance7: z.number(),
              compliance30: z.number(),
            }),
          )
          .optional(),
      })
      .optional()
      .describe(
        "Per-tile extras. Only the medication-compliance tile carries any today; every other tile omits the key.",
      ),
  })
  .meta({
    id: "TargetItem",
    description:
      "One target tile: the current value against its band, plus the consistency strip behind it. The tile array's membership varies per account — a medication tile appears only with active medications, and the glucose tiles only with readings.",
  });

export const targetsResponse = z
  .object({
    targets: z
      .array(targetItem)
      .describe(
        "Vital tiles in registry order with the sleep tile spliced in after pulse, then the medication tile when one applies, then the mood tiles, then the glucose tiles.",
      ),
    pageSummary: z.object({
      targetsMetThisWeek: z.number().int(),
      totalTargets: z.number().int(),
      streakHighlight: z
        .object({ metric: z.string(), days: z.number().int() })
        .nullable(),
    }),
    bpDiastolic: z
      .object({
        current: z.number().nullable(),
        average30: z.number().nullable(),
        range: z.object({ min: z.number(), max: z.number() }).nullable(),
      })
      .describe(
        "The diastolic half, carried beside the tiles rather than as one: the blood-pressure tile grades on systolic, and this is what the card needs to render the pair.",
      ),
    profile: z
      .object({
        heightCm: z.number().nullable(),
        age: z.number().int().nullable(),
        gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable(),
        glucoseUnit: z.string(),
      })
      .describe(
        "The profile facts the bands were resolved from, echoed so a client can explain a band instead of guessing at it.",
      ),
  })
  .meta({
    id: "TargetsResponse",
    description:
      "Per-metric target tiles with their consistency strips, the page-level summary, the diastolic companion figures and the profile facts every band was resolved from. Pure compute over the record's own data; no provider anywhere on the path.",
  });

// ── The AI-provider chain (`/api/insights/provider-chain`) ────────────
//
// Nothing on either wire carries a key, a token or an account id. The GET
// answers provider TYPES and boolean state; the PUT accepts the same. Worth
// stating explicitly because the surface sits next to the credential settings
// and the obvious assumption about it is wrong.

export const providerChainResponse = z
  .object({
    activeProvider: z
      .string()
      .nullable()
      .describe(
        "The provider type the runner would reach first — the head of the RESOLVED chain, which drops disabled entries. Null when the account has none configured.",
      ),
    cachedActiveProvider: z
      .string()
      .nullable()
      .describe(
        "The last provider that actually worked, from the in-process cache. Present when the runner has rerouted to a fallback, so the settings surface can say `active: codex (cached: openai)` instead of leaving the reroute in the logs. In-process, so it resets on restart and can differ between instances.",
      ),
    configuredChain: z
      .array(
        z.object({
          providerType: z.string(),
          enabled: z
            .boolean()
            .describe("Whether the runner may reach this entry."),
          available: z
            .boolean()
            .describe(
              "Always `true` today. Reserved for rendering an unconfigured slot with a needs-setup pill; do not branch on it as if it reported credential presence.",
            ),
        }),
      )
      .describe(
        "The PERSISTED chain in priority order, disabled entries INCLUDED — that is the difference from `activeProvider`, and it is deliberate: reading the resolved list here once made a disabled entry vanish from the settings list along with its toggle position.",
      ),
  })
  .meta({
    id: "ProviderChainResponse",
    description:
      "The account's AI-provider chain as the settings surface reads it. Provider TYPES and boolean state only — no key, token or account id is ever on this wire.",
  });

export const providerChainPutRequest = z
  .object({
    chain: z
      .array(
        z.object({
          providerType: z
            .enum(PROVIDER_CHAIN_TYPES as unknown as [string, ...string[]])
            .describe(
              "Closed allow-list. The mock provider is excluded from it structurally, which is what keeps production from reaching one.",
            ),
          priority: z
            .number()
            .int()
            .optional()
            .describe(
              "ACCEPTED AND IGNORED. Priority is recomputed from the array's insertion order, so a stale client cannot persist a chain whose displayed order disagrees with its stored one. Send the order you want as the order of the array.",
            ),
          enabled: z.boolean(),
        }),
      )
      .min(1)
      .describe(
        "The whole chain, in the order it should be walked. At least one entry and at most one per known provider type; a repeated type is refused.",
      ),
  })
  .meta({
    id: "ProviderChainPutRequest",
    description:
      "Replaces the account's provider chain wholesale. No credential is written or read here — only which provider types exist, in what order, and which are enabled.",
  });

// ── Read-only advisor + generation (`/api/insights/generate`) ─────────

export const insightsGenerateReadResponse = z
  .object({
    insights: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        "The cached insight payload, verbatim from the account's cache row. Null when nothing is cached or the stored row failed to parse — the two are indistinguishable here, and the second also silently enqueues a repair.",
      ),
    cached: z
      .boolean()
      .describe("True when a payload was served from the cache."),
    cachedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe(
        "When that payload was written. Present only on the cached branch — the empty branch omits the key rather than sending null.",
      ),
    legacyPayload: z
      .boolean()
      .describe(
        "True when the cached payload predates the rationale fields, so the client can offer a regenerate. Never auto-regenerated: that would burn a rate-limit token on a cache hit without the user asking.",
      ),
    revalidating: z
      .boolean()
      .describe(
        "True when this read enqueued an out-of-band warm because the cache was stale or missing AND a provider exists. Poll (bounded) until it clears rather than sitting on the stale payload.",
      ),
    hasProvider: z
      .boolean()
      .describe(
        "False when no AI provider is configured anywhere. The served briefing can then NEVER refresh — no warm pass will fill it — so pair its age with a connect-a-provider affordance and stop polling.",
      ),
    generationFailed: z
      .boolean()
      .describe(
        "True when the most recent generation attempt failed after the last successful one. The last good text is still served, so this is the only honest signal that what is shown is held rather than fresh.",
      ),
    generationFailureClass: z
      .string()
      .nullable()
      .describe(
        "Coarse class of that failure, so the empty state can point at the right lever (raise the response timeout versus re-check the provider). Null when the last attempt succeeded.",
      ),
    briefingOmittedReason: z
      .literal("ungrounded")
      .nullable()
      .describe(
        "Non-null when a generation SUCCEEDED but the grounding gate withheld the briefing — a different state from `generationFailed`, and the reason the card can say 'withheld' instead of showing a silent empty tile.",
      ),
  })
  .meta({
    id: "InsightsGenerateReadResponse",
    description:
      "The read-only advisor payload. This route NEVER calls a provider: it serves the cache and, when the cache is stale and a provider exists, enqueues a warm out of band.",
  });

export const insightsGeneratePostRequest = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe(
        'Send `true` to bypass the 24-hour cache and generate now. Anything other than the boolean `true` — including the string `"true"` — is treated as absent. Forcing also means an exhausted hourly quota answers an honest 429 instead of degrading to the cached payload.',
      ),
  })
  .meta({
    id: "InsightsGeneratePostRequest",
    description:
      "Optional body for the generating POST. Capped at 16 KiB. `userId` is taken from the session or the Bearer token and is never a body field.",
  });

export const insightsGeneratePostResponse = z
  .object({
    insights: z
      .record(z.string(), z.unknown())
      .describe("The insight payload, fresh or cached depending on `cached`."),
    cached: z.boolean(),
    cachedAt: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Present on the cached branch only."),
    legacyPayload: z.boolean(),
    briefingOmittedReason: z
      .literal("ungrounded")
      .nullable()
      .optional()
      .describe(
        "Non-null when the grounding gate stripped the briefing from THIS generation. Present on the freshly-generated branch.",
      ),
  })
  .meta({
    id: "InsightsGeneratePostResponse",
    description:
      "The generating POST's answer. A 200 does not mean a provider was called — a cache hit inside the 24-hour window, and an exhausted hourly quota on a briefingless cache, both answer 200 with `cached: true`.",
  });

// ── Coach read strip (`/api/insights/coach-read`) ─────────────────────

export const coachReadQuery = z
  .object({
    metric: measurementTypeEnum.describe(
      "The metric the strip is about. Closed enum: an unknown value 422s.",
    ),
  })
  .meta({ id: "CoachReadQuery" });

export const coachReadStripResponse = z
  .object({
    baseline: z
      .object({
        low: z.number().describe("Robust lower edge of the personal range."),
        high: z.number().describe("Robust upper edge."),
        latest: z.number().describe("Today's latest reading, same units."),
        placement: z.enum(["within", "above", "below"]),
        sampleDays: z
          .number()
          .int()
          .describe("Distinct days behind the band, for transparency."),
      })
      .nullable()
      .describe(
        "Line one. Null when the band could not be established or there is no reading to place — and then `learning` is true. Mutually exclusive with it.",
      ),
    learning: z
      .boolean()
      .describe(
        "True when history is below the engine's seven-day floor or there are no readings. Render 'still learning your range' rather than inventing one.",
      ),
    driver: z
      .object({
        note: z
          .string()
          .describe(
            "An already-localised, conservative, descriptive sentence the client prints VERBATIM. Never causal. Written in the reader's language server-side, which is why it is not a key.",
          ),
        behaviour: z.string().describe("Lower-cased behaviour label."),
        outcome: z.string().describe("Lower-cased outcome label."),
      })
      .nullable()
      .describe(
        "Line two: the single strongest lagged association whose outcome is this metric. Null when none clears the effect-size floor, and null when the correlation read failed — the failure is deliberately swallowed so a hiccup there never sinks line one.",
      ),
  })
  .meta({
    id: "CoachReadStrip",
    description:
      "The two server-authoritative lines a metric sub-page renders above its chart. Pure compute over the baseline and correlation engines — no provider call, no cache table — so web and native decode the same resolved DTO.",
  });

// ── Coach seeded opener (`/api/insights/coach/seeded-question`) ───────

export const coachSeededQuestionResponse = z
  .object({
    signal: z
      .object({
        sourceMetric: z
          .string()
          .describe(
            "Sentinel id the client keys its localised copy on (`readiness` / `recovery`).",
          ),
        score: z.number().describe("The latest 0..100 score."),
        band: z
          .string()
          .describe(
            "`yellow` or `red`. Green never surfaces — a good day is not notable.",
          ),
      })
      .nullable()
      .describe(
        "Null whenever nothing crossed the detector's confidence and notability gate, AND whenever the account has turned proactive suggestions off — the two are indistinguishable on the wire, and both mean the hero keeps its neutral greeting rather than showing a fabricated opener.",
      ),
  })
  .meta({
    id: "CoachSeededQuestion",
    description:
      "Today's single most notable derived wellness signal, resolved server-side into a tappable opener for the Coach's blank-chat hero. The client renders the resolved DTO and never recomputes the selection.",
  });

// ── Period narrative (`/api/insights/narrative`) ──────────────────────

export const narrativeQuery = z
  .object({
    period: z
      .enum(NARRATIVE_PERIOD_VALUES as [string, ...string[]])
      .describe("Which retrospective to read. Closed enum: unknown 422s."),
    locale: z
      .string()
      .optional()
      .describe(
        "Override the reader's resolved locale. The narrative row is keyed per locale, so this selects a different stored row rather than translating one; an unrecognised value falls back to the app default instead of 422-ing.",
      ),
  })
  .meta({ id: "NarrativeQuery" });

export const narrativeResponse = z
  .object({
    period: z.string().describe("Echoes the requested period."),
    locale: z.string().describe("The locale the row was read for."),
    narrative: z
      .object({
        text: z.string().describe("The retrospective prose, rendered as-is."),
        provenance: z
          .string()
          .describe(
            "Where the text came from — provider prose or the deterministic non-causal fallback a provider-less account gets.",
          ),
        updatedAt: z.iso.datetime({ offset: true }),
      })
      .nullable()
      .describe("Null when no row exists for this period and locale yet."),
    revalidating: z
      .boolean()
      .describe(
        "True when this read enqueued a warm. Always FALSE on a delegated request even when the row is stale: this route warms unconditionally rather than on a miss, so a manager's first navigation here would otherwise be an egress of the owner's record the owner never asked for. The stale row is still served; only the warm is withheld.",
      ),
  })
  .meta({
    id: "NarrativeResponse",
    description:
      "The latest generated period retrospective. Read-only by construction — it never blocks on a provider, serves the last good row immediately, and warms out of band.",
  });

// ── GLP-1 therapy timeline (`/api/insights/glp1-timeline`) ────────────

export const glp1TimelineQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(60)
      .describe(
        "Entry cap, 1..200, default 60. A non-integer, out-of-range or non-numeric value falls back to the default rather than 422-ing.",
      ),
  })
  .meta({ id: "Glp1TimelineQuery" });

export const glp1TimelineResponse = z
  .object({
    hasGlp1: z
      .boolean()
      .describe(
        "False when the record holds no medication classified GLP-1. `entries` is then empty and the surface hides cleanly.",
      ),
    entries: z
      .array(
        z.object({
          date: z.iso
            .datetime({ offset: true })
            .describe(
              "When it happened. A `side-effect` entry is a DAY rather than an instant, and is stamped at 12:00 UTC of that day so it sorts — do not read it as a capture time.",
            ),
          kind: z.enum([
            "dose-change",
            "injection",
            "inventory",
            "side-effect",
          ]),
          medicationName: z
            .string()
            .optional()
            .describe("Absent on a `side-effect` entry."),
          doseValue: z.number().optional(),
          doseUnit: z.string().optional(),
          doseDelta: z
            .enum(["up", "down"])
            .nullable()
            .optional()
            .describe("Titration direction against the previous step."),
          note: z
            .string()
            .nullable()
            .optional()
            .describe("The titration note, decrypted."),
          injectionSite: z.string().nullable().optional(),
          inventoryDelta: z.number().int().optional(),
          reason: z.string().optional(),
          tags: z
            .array(
              z.enum([
                "nausea",
                "constipation",
                "diarrhea",
                "fatigue",
                "appetite-loss",
                "heartburn",
                "headache",
              ]),
            )
            .optional()
            .describe(
              "Catalogue keys of the side effects tagged that day, deduplicated. These are STABLE KEYS, not the strings the entries were written with: the capture chip writes its label in the writer's language, and the matcher indexes every shipped locale's label back to the key, so the same recorded symptom yields the same key whether it was tagged in German, English, Spanish, French, Italian or Polish. Render the key in the reader's own language rather than echoing it. A mood tag that is not a catalogue side effect — anything the user typed freehand — is not reported here; it is not a side effect, and a therapy timeline is not the place for the rest of somebody's day.",
            ),
        }),
      )
      .describe(
        "Newest first, capped at `limit`. A heterogeneous union: which optional keys are present depends on `kind`, and no entry carries all of them.",
      ),
  })
  .meta({
    id: "Glp1TimelineResponse",
    description:
      "A chronological merge of the GLP-1-relevant events the record holds: titration steps, injections with their sites, legacy stock-ledger movements, and side-effect-tagged mood days from the trailing 90 days. Inventory entries come from the legacy running-sum ledger only, so a medication tracked with per-container inventory shows none.",
  });

// ── Intraday pulse (`/api/insights/pulse/intraday`) ───────────────────

export const intradayPulseQuery = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "The local day to read. Defaults to the record's local today. Anything but a `YYYY-MM-DD` literal is a 422 — this parameter is strict where most of the surface's date filters are forgiving.",
      ),
  })
  .meta({ id: "IntradayPulseQuery" });

export const intradayPulseResponse = z
  .object({
    dateKey: z.string().describe("The local day that was read."),
    timezone: z.string().describe("The zone the day was anchored to."),
    bucketMinutes: z.number().int().describe("Width of one bucket."),
    series: z
      .array(
        z.object({
          startMinute: z
            .number()
            .int()
            .describe("Minutes since local midnight at the bucket start."),
          mean: z.number(),
          count: z
            .number()
            .int()
            .describe(
              "Raw samples behind the mean. A bucket below the density floor is a GAP that breaks a candidate tension run, not a thin data point — a lone reading is a point, not a bucket.",
            ),
          min: z
            .number()
            .optional()
            .describe("Bucket low, when the source carries a spread."),
          max: z.number().optional().describe("Bucket high, same condition."),
        }),
      )
      .describe("The day's shape, ascending."),
    baseline: z
      .number()
      .nullable()
      .describe("The resting baseline the day was judged against."),
    baselineSource: z
      .enum(["resting", "proxy", "none"])
      .describe(
        "`resting` from recorded resting heart rate, `proxy` when those rows are stale or absent and the pulse history stood in, `none` when no baseline could be formed.",
      ),
    tension: z
      .object({
        startMinute: z.number().int(),
        endMinute: z.number().int(),
        partOfDay: z.enum(["morning", "afternoon", "evening", "night"]),
        meanHr: z.number(),
        baseline: z.number(),
        hrvConfirmed: z
          .boolean()
          .describe("True when intraday HRV independently confirmed it."),
      })
      .nullable()
      .describe(
        "At most ONE cautious elevated-at-rest window, and only when every confidence gate holds — the bar is set high and under-flagging is the intended failure mode. ALWAYS null on an `hourly` day, because a tension read needs per-sample resolution.",
      ),
    resolution: z
      .enum(["tenMin", "hourly"])
      .describe(
        "`tenMin` when the series was folded from live raw samples, `hourly` when the day fell outside the dense-retention window and the coarser folded tier answered instead. An older day reads back coarser rather than empty.",
      ),
  })
  .meta({
    id: "IntradayPulseResponse",
    description:
      "One local day's intraday heart-rate shape, plus at most one cautious elevated-at-rest window. Computed from raw samples through the read-swap pattern rather than persisted as ten-minute rollups for all history. Awareness only, never a diagnosis.",
  });

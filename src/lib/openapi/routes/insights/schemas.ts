/**
 * OpenAPI route table — dashboard snapshot, comprehensive insights, analytics range, metric status, derived metrics, correlations.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { METRIC_STATUS_IDS } from "@/lib/insights/metric-status-registry";
import {
  DERIVED_METRIC_IDS,
  VITALS_BASELINE_TYPES,
} from "@/lib/insights/derived/registry";
import { ANALYTICS_RANGES } from "@/lib/analytics/range-delta";

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
// route + cache scope cannot drift. `type` sub-targets the single vital
// a baseline metric (VITALS_BASELINE) bands over.
export const derivedMetricQuery = z
  .object({
    metric: z
      .enum(DERIVED_METRIC_IDS as [string, ...string[]])
      .describe(
        "Derived-metric id to compute (e.g. VITALS_BASELINE, FITNESS_AGE, VASCULAR_AGE_DELTA, HRV_BALANCE, BMI, READINESS). Closed enum: an unknown id 422s. Metrics whose compute has not yet landed return an `insufficient` value with reason `not_implemented`.",
      ),
    type: z
      .enum(VITALS_BASELINE_TYPES as [string, ...string[]])
      .optional()
      .describe(
        "For VITALS_BASELINE only — the single vital to band (defaults to RESTING_HEART_RATE). Ignored by composites. An unsupported value yields an `insufficient` value rather than a 422 so iOS metric combinations stay forgiving.",
      ),
  })
  .meta({ id: "DerivedMetricQuery" });

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
        "Metric-specific value object when status is 'ok' (e.g. { type, center, low, high, spread, sampleDays, k, series } for VITALS_BASELINE, where `series` is the trailing per-day mean values for the inline sparkline); null when 'insufficient'.",
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
        "Comma-separated derived-metric tokens. Each is a `<DERIVED_METRIC_ID>` or `<DERIVED_METRIC_ID>:<MeasurementType>` (the colon sub-targets a VITALS_BASELINE vital). An unknown id 422s; a `type` outside the MeasurementType enum 422s; at most 24 tokens; duplicates collapse.",
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
  })
  .meta({ id: "DiscoveredCorrelation" });

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
      gender: z.enum(["MALE", "FEMALE"]).nullable(),
      glucoseUnit: z.string().nullable(),
      onboardingTourCompleted: z.boolean(),
      greetingHour: z.number().int(),
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
    // Dashboard hero — health score (warm phase, nullable on a
    // rollup-coverage miss). Score + band + delta only; the per-pillar
    // component breakdown stays on the analytics route.
    healthScore: z
      .object({
        score: z.number().int(),
        band: z.enum(["green", "yellow", "red"]),
        delta: z.number().nullable(),
      })
      .nullable()
      .describe(
        "Personal health score summary (0..100 score, traffic-light band, week-over-week delta). Null on a rollup-coverage miss (it rides the thick phase alongside `extras`) and when no pillar is computable. Component breakdown is deliberately not serialised here.",
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

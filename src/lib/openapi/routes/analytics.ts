/**
 * OpenAPI route table — the dashboard analytics aggregate (`/api/analytics`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * This is the web dashboard's one big read. Two shapes come out of the same
 * path: `?slice=summaries` answers the tile strip from two SQL passes, and
 * everything else answers the thick default body (BP-in-target windows, the
 * glucose panel, the three fixed correlation hypotheses, the Health Score and
 * the sleep-stage composition). One route, two response schemas, chosen by a
 * query parameter — documented as a union rather than pretended into one
 * object.
 *
 * Nothing here is `Derived<T>` by accident: the score report and the weight
 * goal are the shared derived-metrics union, so the four facets (value,
 * coverage, confidence, provenance) are re-used from the insights module
 * rather than restated. Those schemas are imported, not copied, so a change
 * to the derived contract cannot leave this document behind.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { SCORE_PILLAR_IDS } from "@/lib/analytics/score/types";
import {
  derivedConfidence,
  derivedCoverage,
  derivedProvenance,
  glucoseClinicalSchema,
  healthScoreBasis,
} from "./insights/schemas";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// ── The per-type summary the tile strip renders ──────────────────────

const trendSlope = z
  .object({
    slope: z.number().describe("Least-squares slope, in units per day."),
    direction: z
      .enum(["up", "down", "stable"])
      .describe("`stable` when |slope| < 0.01, not when the slope is zero."),
    confidence: z
      .number()
      .describe("R² of the fit, 0–1. Reported as 0 when it cannot be formed."),
  })
  .meta({
    id: "TrendSlope",
    description:
      "A linear trend over a trailing window. The window is anchored on NOW, not on the newest reading, so a series that stopped weeks ago reports `null` for the slope instead of describing a trend that has not been observed since.",
  });

const dataSummary = z
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
        "50th percentile over the trailing 90 days on this route (the SQL summaries path fixes that window). Linear-interpolated midpoint.",
      ),
    avg7: z.number().nullable(),
    avg30: z.number().nullable(),
    slope7: trendSlope.nullable(),
    slope30: trendSlope.nullable(),
    avg30LastMonth: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Mean over the 30-day window that ended 30 days ago — the prior period the tile's delta callout compares against.",
      ),
    avg30LastYear: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Mean over the 30-day window that ended 365 days ago. Populated only for types whose WEEK/MONTH/YEAR rollup tier reaches that far back; null otherwise, which is not the same as 'the year-ago window was empty'.",
      ),
  })
  .meta({
    id: "MetricDataSummary",
    description:
      "Per-measurement-type summary. Every statistic is null on an empty series rather than zero — a zero here would render as a real reading. `anomalyCount` and `slope90` left this wire in v1.37.19: the SQL path could never compute the first and nobody read the second.",
  });

const summariesByType = z
  .record(z.string(), dataSummary)
  .describe(
    "Keyed by `MeasurementType`. Only types the account has data for are present.",
  );

const lastSeenByType = z
  .record(
    z.string(),
    z
      .object({
        lastSeenAt: z.iso.datetime({ offset: true }),
        daysAgo: z
          .number()
          .int()
          .describe(
            "Whole days since `lastSeenAt`. Re-derived per request rather than served from the cache, so it stays right across a day boundary the cached body straddles.",
          ),
      })
      .nullable(),
  )
  .describe(
    "Per-type freshness, driving the 'last value N days ago' caption. A type the account has never logged reads `null`.",
  );

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
    "Non-null when two writer buckets reported clearly different asleep totals for the latest night's main session. Observational only — the served summary stays the winning writer's totals.",
  );

// ── The slim slice ───────────────────────────────────────────────────

const analyticsSummariesSlice = z
  .object({
    summaries: summariesByType,
    bmi: z
      .null()
      .describe(
        "Always null on this slice — BMI needs the profile height the slim path does not load. Re-derive it client-side from `summaries.WEIGHT.latest`, or read the default slice.",
      ),
    lastSeenByType,
    sleepSourceDiscrepancy,
  })
  .meta({
    id: "AnalyticsSummariesSlice",
    description:
      "What `?slice=summaries` answers: the per-type summaries and their freshness, and nothing thick. Four keys, and the caller gets them from two SQL passes rather than the default slice's chain.",
  });

// ── Correlations ─────────────────────────────────────────────────────

const correlationPoint = z.object({ x: z.number(), y: z.number() });

const correlationOk = z.object({
  kind: z.enum(["bp-compliance", "mood-pulse", "weight-weekday"]),
  status: z.literal("ok"),
  statistic: z
    .number()
    .describe(
      "Pearson r for the two paired hypotheses; eta-squared for the weekday ANOVA.",
    ),
  n: z.number().int().describe("Paired rows behind the statistic."),
  pValue: z.number(),
  confidenceBand: z.object({
    low: z.number(),
    high: z.number(),
    label: z.enum(["low", "moderate", "high"]),
  }),
  interpretation: z
    .string()
    .describe(
      "One conservative sentence, localised to the reader. Never claims causation. This is why the response cache is keyed per locale.",
    ),
  points: z.array(correlationPoint),
  xLabel: z.string(),
  yLabel: z.string(),
  patternId: z
    .string()
    .optional()
    .describe(
      "Present once the pattern ledger has a row for this pair — the handle `PATCH /api/insights/correlations/patterns/{id}` takes.",
    ),
  canonicalKey: z.string().optional(),
  dismissed: z
    .boolean()
    .optional()
    .describe("True when the reader has dismissed this pattern."),
});

const correlationInsufficient = z.object({
  kind: z.enum(["bp-compliance", "mood-pulse", "weight-weekday"]),
  status: z.literal("insufficient"),
  n: z.number().int(),
  reason: z.enum(["too_few_pairs", "not_significant", "no_variance"]),
  points: z
    .array(correlationPoint)
    .describe(
      "What was collected anyway, so the empty state can hint at progress.",
    ),
});

const correlationResult = z
  .union([correlationOk, correlationInsufficient])
  .meta({
    id: "FixedCorrelationResult",
    description:
      "One of the three fixed hypotheses. The `insufficient` arm is the normal case for a young account: the surface gate wants at least 20 paired rows and p < 0.05, and it says which of the two it missed.",
  });

const analyticsCorrelations = z
  .object({
    bpCompliance: correlationResult,
    moodPulse: correlationResult,
    weightWeekday: correlationResult,
    degraded: z
      .boolean()
      .describe(
        "Reserved for a future load-shedding branch and pinned to `false` by both current branches. Read it, do not assume it will ever be true today.",
      ),
    windowDays: z
      .number()
      .int()
      .describe("Days the runner actually scanned. 28 on both branches."),
    path: z
      .enum(["rollup", "live"])
      .describe(
        "`rollup` when the SYS / PULSE / WEIGHT series came off `measurement_rollups`. Mood and medication-intake reads are always live — there is no rollup equivalent for them.",
      ),
  })
  .meta({
    id: "AnalyticsCorrelations",
    description:
      "The three pre-defined correlation hypotheses over a 28-day window. Accepted results are also synced into the pattern ledger on this read, which is where `patternId` / `dismissed` come from.",
  });

// ── Health Score ─────────────────────────────────────────────────────

const scorePillarIdEnum = z.enum(SCORE_PILLAR_IDS);

const pillarValue = z.object({
  score: z.number(),
  observed: z.object({
    value: z.number(),
    unit: z.string(),
    label: z
      .string()
      .describe("The complete display value, paired or panel values included."),
    asOf: z.iso.datetime({ offset: true }),
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
    .object({
      kind: z.enum([
        "clinical-threshold",
        "population-percentile",
        "guideline-band",
      ]),
      low: z.number().nullable(),
      high: z.number().nullable(),
      label: z.string(),
      source: z.string(),
    })
    .optional()
    .describe(
      "The reader's own yardstick, shown beside the scored reference. It is displayed, never scored — the pillar always grades against the clinical band.",
    ),
  scoreBasis: z
    .object({
      axis: z.enum(["systolic", "diastolic"]),
      relation: z.enum(["above_ceiling", "below_floor", "in_band"]),
      offsetMmHg: z.number(),
      boundaryMmHg: z.number(),
    })
    .optional()
    .describe(
      "Blood pressure only, and only because that pillar takes the WORSE of two axes — the number alone cannot say which one produced it. A pillar with nothing of the kind to say omits the key.",
    ),
  noiseFloor: z
    .number()
    .describe("Score points a weekly move must clear before it is narrated."),
  deltaEligible: z
    .boolean()
    .describe(
      "False for slow markers: they set the level but never contribute to the weekly delta.",
    ),
  deltaIdentity: z
    .string()
    .describe(
      "Input/scoring-mode identity. Two windows only form a delta when their identities match.",
    ),
});

const compositeValue = z.object({
  score: z.number(),
  band: z.enum(["green", "yellow", "red"]),
  bandSetter: scorePillarIdEnum
    .nullable()
    .describe(
      "The pillar that pulled the band down, non-null only when the worst pillar's band is below the mean score's.",
    ),
  composition: z
    .array(scorePillarIdEnum)
    .describe(
      "Registry-ordered eligible pillars. Part of the number's identity: two scores built from different compositions are not comparable.",
    ),
  configured: z
    .boolean()
    .describe(
      "True when the account's own recipe narrows the composition below what its defaults would resolve to today. The configuration itself never rides this wire.",
    ),
  scoreBasis: healthScoreBasis
    .optional()
    .describe(
      "What the number rests on. Since v1.38 a score is produced from one or two areas of health as well as three, with identical arithmetic at each, so this block is the only thing on the wire that distinguishes them. Optional so a composite cached before v1.38 stays valid; the live scorer always sets it.",
    ),
  noiseFloor: z.number(),
  scoreVersion: z.number().int(),
});

const weightGoalValue = z.object({
  currentKg: z.number(),
  target: z.object({ min: z.number(), max: z.number() }),
  distanceKg: z.number(),
  deltaKg: z
    .number()
    .nullable()
    .describe("Positive means the distance to the personal band narrowed."),
  asOf: z.iso.datetime({ offset: true }),
  source: z.string(),
});

/**
 * The `Derived<T>` union, spelled out per payload.
 *
 * The gated arm still carries coverage and provenance so a surface renders
 * "track N more days" rather than a blank — which is the whole reason the
 * derived layer is a union and not a nullable value.
 */
function derived<T extends z.ZodType>(value: T, id: string) {
  return z
    .union([
      z.object({
        status: z.literal("ok"),
        value,
        coverage: derivedCoverage,
        confidence: derivedConfidence,
        provenance: derivedProvenance,
      }),
      z.object({
        status: z.literal("insufficient"),
        coverage: derivedCoverage,
        provenance: derivedProvenance,
        reason: z.string(),
      }),
    ])
    .meta({ id });
}

const healthScoreReport = z
  .object({
    composite: derived(compositeValue, "DerivedHealthScoreComposite"),
    pillars: z.array(
      z.object({
        id: scorePillarIdEnum,
        domain: z.enum([
          "cardiometabolic",
          "activity",
          "sleep",
          "adiposity",
          "wellbeing",
        ]),
        result: derived(pillarValue, "DerivedScorePillarValue"),
      }),
    ),
    delta: z
      .number()
      .nullable()
      .describe("Move against the previous window, or null when none forms."),
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
        "Why there is no delta, or why the one there is should not be narrated as a health event. `config_changed` is the reader changing their own recipe mid-window — the arithmetic looks comparable and is not.",
      ),
    scoreVersion: z.number().int(),
    weightGoal: derived(weightGoalValue, "DerivedWeightGoal"),
    algorithmNotice: z
      .object({ itemKey: z.string(), dismissed: z.boolean() })
      .nullable(),
    compositionNotice: z
      .object({
        itemKey: z.string(),
        left: z.array(scorePillarIdEnum),
        joined: z.array(scorePillarIdEnum),
        dismissed: z.boolean(),
      })
      .nullable()
      .optional()
      .describe(
        "A pillar joined or left the set behind the number since the account's last stored local day. Raised only for a change nobody chose: a method move or a recipe change is the algorithm notice's subject instead, and raising both would announce one event twice. Optional so a payload cached before the field existed stays valid; null when there is nothing to say. Dismissed through `POST /api/daily/digest/dismiss` with this `itemKey`, which is keyed on the resulting SET so it re-raises when the set moves again rather than every day.",
      ),
    restMode: z
      .object({
        active: z.literal(true),
        since: z.iso.datetime({ offset: true }).nullable(),
        episodeCount: z.number().int(),
      })
      .nullable()
      .optional()
      .describe(
        "Attached when an illness episode was active as of the scored instant — the instant the score was computed for, not a fresh now. The score is NOT penalised; this frames it. Null when no episode was open. On this route the key is always present; it is optional in the shape because other producers of the report omit it.",
      ),
  })
  .meta({
    id: "HealthScoreReport",
    description:
      "The full Health Score report as the scorer produced it. Note this is the raw report, not the flattened hero block the dashboard snapshot serves — a client that reads both should not expect the same field names.",
  });

// ── Sleep-stage composition ──────────────────────────────────────────

const sleepStageComposition = z
  .object({
    windowDays: z.number().int(),
    nights: z
      .number()
      .int()
      .describe("Nights inside the window carrying at least one stage entry."),
    totalMinutes: z
      .number()
      .describe("Sum of every value in `stages`. Nights only, naps excluded."),
    stages: z
      .record(z.string(), z.number())
      .describe(
        "Window totals per stage, keyed by the `SleepStage` enum. `IN_BED` is the session envelope and is carried alongside the asleep stages.",
      ),
    perNight: z.array(
      z.object({
        dayKey: z
          .string()
          .describe("Wake-day key (YYYY-MM-DD) in the reader's timezone."),
        stages: z.record(z.string(), z.number()),
        napMinutes: z
          .number()
          .optional()
          .describe(
            "Time asleep across this day's naps. ABSENT on a day without one — there is no zero to render.",
          ),
        napCount: z.number().int().optional(),
      }),
    ),
  })
  .nullable()
  .describe(
    "Trailing-30-day per-stage breakdown, or null when no session in the window carries stage data. Sessions are reconstructed and collapsed to one canonical source per night first, so a night written by two devices is counted once and a midnight-spanning night lands on its wake day.",
  );

// ── The default slice ────────────────────────────────────────────────

const analyticsDefaultResponse = z
  .object({
    summaries: summariesByType,
    bmi: z
      .number()
      .nullable()
      .describe(
        "Derived from `summaries.WEIGHT.latest` and the profile height; null when either is missing.",
      ),
    bpInTargetPct: z
      .number()
      .nullable()
      .describe("Trailing 90 days — the headline the BP tile shows."),
    bpInTargetPct7d: z.number().nullable(),
    bpInTargetPct30d: z.number().nullable(),
    bpInTargetPctAllTime: z.number().nullable(),
    bpInTargetPctPriorMonth: z.number().nullable(),
    bpInTargetPctPriorYear: z.number().nullable(),
    bpInTargetCount90: z
      .number()
      .int()
      .nullable()
      .describe("Readings behind the 90-day figure, for the thin-data gate."),
    bpInTargetSpanDays90: z
      .number()
      .int()
      .nullable()
      .describe("Effective span the 90-day window actually covers."),
    glucoseByContext: z
      .record(z.string(), dataSummary)
      .nullable()
      .describe(
        "Per-context glucose summaries (FASTING / POSTPRANDIAL / RANDOM / BEDTIME, plus UNSPECIFIED for readings whose source recorded no meal-time context) over the trailing 30 days, canonical mg/dL. Buckets with no readings are omitted; the whole block is null when the glucose module is off.",
      ),
    glucoseClinical: glucoseClinicalSchema
      .nullable()
      .describe("Null when the glucose module is off for this account."),
    correlations: analyticsCorrelations,
    healthScore: healthScoreReport,
    sleepStages: sleepStageComposition,
    sleepSourceDiscrepancy,
    lastSeenByType,
  })
  .meta({
    id: "AnalyticsDefaultResponse",
    description:
      "The thick dashboard body. The BP figures are computed against the CLINICAL band even when the account keeps a personal target — the personal one is displayed beside the number and scores nothing.",
  });

export const analyticsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/analytics": {
    get: {
      tags: ["Analytics"],
      summary: "The dashboard analytics aggregate",
      description:
        "The web dashboard's aggregate read, in two shapes chosen by `?slice=`.\n\n`?slice=summaries` returns the slim tile-strip body from two SQL passes; omitting the parameter returns the thick default body. Any OTHER value is refused with 422 (`meta.errorCode` = `analytics.invalid_query`). It used to fall through to the default instead, which made `?slice=summary` answer 200 after running the heaviest chain on the surface — the typo was invisible and expensive at the same time.\n\nBoth shapes are served through a stale-while-revalidate cache. A cached body can be up to a minute old, and the default slice's cache key includes the reader's locale because the correlation `interpretation` sentences are narrated per reader. `Cache-Control: private, max-age=0, must-revalidate` on both — bfcache-friendly rather than the framework's stock `no-store`.\n\nThis GET is not free of side effects, and a caller polling it should know: it records a Health Score row for the scored instant, syncs accepted correlation hypotheses into the pattern ledger (which is what mints the `patternId` the dismissal endpoint takes), and kicks a background rollup-freshness refresh. The refresh is fire-and-forget by design — awaiting it stalled the event loop for tens of seconds on large accounts — so a value can be up to about a minute behind a measurement that just landed, and the next read has it.\n\nAuth is a cookie session or a wildcard (`*`) Bearer token; a narrow-scope token is refused. NOT delegable: it resolves the caller's own record, so a switched session still reads its own analytics.",
      parameters: [
        {
          name: "slice",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["summaries"] },
          description:
            "`summaries` selects the slim tile-strip body. Omit it for the default body. Any other value is a 422 — it is not treated as an omission.",
        },
      ],
      responses: {
        "200": {
          description:
            "The analytics body. `AnalyticsSummariesSlice` for `?slice=summaries`, `AnalyticsDefaultResponse` otherwise.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.union([analyticsDefaultResponse, analyticsSummariesSlice]),
                "AnalyticsEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
        "422": {
          description:
            "`slice` carried a value outside the closed set. `meta.errorCode` = `analytics.invalid_query`, with the offending path under `details.issues`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};

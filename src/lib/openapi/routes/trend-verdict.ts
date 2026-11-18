/**
 * OpenAPI schemas — server-resolved verdicts for the native client (v1.43,
 * ios #116 items 3, 4, 5, 6 and 9).
 *
 * Shared by the dashboard, insights, measurement, record, mood and cycle
 * route tables. Every value here is resolved on the server; clients render
 * it and never apply thresholds of their own.
 */
import { z } from "zod/v4";

export const trendVerdict = z
  .object({
    direction: z
      .enum(["up-good", "up-bad", "neutral", "hold"])
      .describe(
        "How a change counts: `up-good` a rise is progress, `up-bad` a fall is progress, `hold` staying is progress and a move either way is no setback, `neutral` no judgement. `hold` covers a value inside its band, a blood pressure, resting pulse or body fat below a profile-default band (a default's lower edge is no goal; below the person's own target a rise stays `up-good`), and steps or oxygen saturation above their band (more is never worse).",
      ),
    targetPosition: z
      .enum(["below", "inside", "above"])
      .nullable()
      .describe("Where the value sits against the band; null without one."),
    basis: z
      .enum(["personal_target", "profile_default", "metric_default"])
      .describe(
        "What the verdict was judged against: the person's own target, a profile-derived default (e.g. the age-based blood pressure target), or the metric's default direction.",
      ),
  })
  .meta({
    id: "TrendVerdict",
    description:
      "Which way a change of a metric counts as progress for this person. The generalisation of `tiles.weightTrend`.",
  });

export const trendSentiment = z.enum(["positive", "negative", "neutral"]).meta({
  id: "TrendSentiment",
  description:
    "The verdict applied to one delivered change, with the noise floor applied. Colour the change from this.",
});

export const seriesChange = z
  .object({
    from: z.number(),
    to: z.number(),
    delta: z.number(),
    sentiment: trendSentiment,
  })
  .meta({
    id: "SeriesChange",
    description:
      "First and last day value in the window (by the metric's day statistic) and how the change counts. Null under two days.",
  });

export const seriesReferenceLine = z
  .object({
    value: z.number().describe("In the unit of the response."),
    kind: z.enum(["lower", "upper"]),
    source: z.enum(["personal", "clinical"]),
    appliesTo: z
      .enum(["value", "secondary"])
      .describe("`secondary` is the diastolic value of a blood pressure."),
    labelKey: z.string(),
    label: z.string().describe("In the account language."),
  })
  .meta({
    id: "SeriesReferenceLine",
    description:
      "A horizontal line to draw on the chart. A personal line replaces the clinical one for the same edge. Empty list when there is nothing to draw.",
  });

export const recordBenchmark = z
  .object({
    low: z.number(),
    high: z.number(),
    unit: z.string(),
    source: z.string(),
    sourceLabel: z.string(),
  })
  .meta({
    id: "RecordBenchmark",
    description:
      "An age- and sex-aware comparison band from a cited norm, in the record's unit.",
  });

export const moodPattern = z
  .object({
    id: z
      .string()
      .describe(
        "Stable: `previous_day`, `weekend`, `best_weekday`, `notes`, `multiple_entries` or `delayed_tag:<tagKey>`.",
      ),
    kind: z.enum([
      "previous_day",
      "weekend",
      "best_weekday",
      "notes",
      "delayed_tag",
      "multiple_entries",
    ]),
    strength: z.enum(["weak", "moderate", "strong"]),
    direction: z.enum(["higher", "lower", "none"]),
    values: z
      .object({
        subject: z.number(),
        comparison: z.number(),
        delta: z.number(),
        weekday: z.number().int().min(0).max(6).optional(),
        tagKey: z.string().optional(),
        tagLabel: z.string().optional(),
      })
      .describe(
        "`subject` and `comparison` are mean daily mood scores on the mood scale entries are logged on (1 to 5, the scale of `summary` in the same response), rounded to two places; `delta` is their difference. Never rescaled.",
      ),
    sampleSize: z.object({
      subject: z.number().int(),
      comparison: z.number().int(),
    }),
  })
  .meta({
    id: "MoodPattern",
    description:
      "A mood pattern that passed the server's gate (at least 8 days on each side, Welch test, false discovery control). Skip an unknown `kind`.",
  });

export const cycleRestoredStart = z
  .object({
    cycleId: z.string(),
    startDate: z.string(),
  })
  .meta({
    id: "CycleRestoredStart",
    description:
      "A cycle start that was folded into another start, or given back after the start it was folded into went away.",
  });

export const cycleDeleteOutcome = z
  .object({
    removedCycleId: z.string().nullable(),
    restored: z.array(cycleRestoredStart),
  })
  .meta({
    id: "CycleDeleteOutcome",
    description:
      "What a delete changed, answered with 200 when the request sent `Prefer: return=representation` (RFC 7240; the response carries `Preference-Applied`). Without the header the delete answers 204 as before.",
  });

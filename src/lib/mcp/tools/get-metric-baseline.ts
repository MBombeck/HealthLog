import { z } from "zod/v4";

import { getMetricBaseline } from "@/lib/mcp/rich-reads";
import { bandShape } from "./output-shapes";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

const getMetricBaselineOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  metric: z.string().optional(),
  unit: z.string().optional(),
  baseline: z
    .object({ low: z.number(), high: z.number(), sampleDays: z.number() })
    .optional(),
  latest: z.number().optional(),
  latestDate: z
    .string()
    .optional()
    .describe(
      "Calendar day of `latest` in the user's time zone, `YYYY-MM-DD`.",
    ),
  latestIsToday: z
    .boolean()
    .optional()
    .describe(
      "True when `latest` is from today. When false, `latest` is an older reading: name its date, never call it today's.",
    ),
  placement: z.enum(["within", "above", "below"]).optional(),
  basis: z
    .literal("sameHours")
    .optional()
    .describe(
      "Present when today is still in progress for a metric whose day mean moves with the hour (blood glucose): `latest` is today's mean so far and `baseline` the usual range for the same hours of earlier days, not the whole-day range.",
    ),
  referenceBand: bandShape,
  driver: z
    .object({ note: z.string(), behaviour: z.string(), outcome: z.string() })
    .nullable()
    .optional(),
};

export const getMetricBaselineTool: McpToolDefinition = {
  name: "get_metric_baseline",
  title: "Get a metric's personal baseline",
  description:
    "Fetch where the user's latest reading for ONE metric sits against their own usual range (median ± robust deviation), plus the strongest lagged driver of that metric. Re-exports the same baseline engine the metric page renders. Also resolves the clinical-signal metrics (grip strength, pain 0–10 NRS, waist circumference, waist-to-height ratio). A metric can be named by its alias, its key, or its display name in any language HealthLog ships (e.g. 'poids', 'Blutzucker'). Returns the personal band, the latest value with its date and whether it is from today (latestDate, latestIsToday) + placement (within/above/below), and the population reference band. Returns { present: false } with reason 'insufficient_history' below the 7-day learning floor — never a fabricated range.",
  inputShape: {
    metric: z.string().min(1).max(60),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getMetricBaselineOutput,
  run(ctx, args) {
    return getMetricBaseline(ctx.userId, {
      metric: String(args.metric ?? ""),
    });
  },
};

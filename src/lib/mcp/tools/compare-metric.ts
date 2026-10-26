import { z } from "zod/v4";

import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import { compareMetric, type DateRange } from "@/lib/mcp/rich-reads";
import { bandShape, dateRangeShape } from "./output-shapes";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

const metricWindowSnapshotSchema = z.object({
  label: z.string(),
  unit: z.string(),
  band: bandShape,
  windowDays: z.number(),
  granularity: z.string(),
  count: z.number(),
  mean: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  // Present only when the side was an explicit `{from,to}` range.
  from: z.string().optional(),
  to: z.string().optional(),
});

const compareMetricOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  mode: z.enum(["metric_vs_metric", "window_vs_window"]).optional(),
  a: metricWindowSnapshotSchema.optional(),
  b: metricWindowSnapshotSchema.optional(),
  delta: z
    .object({ mean: z.number(), pct: z.number().nullable() })
    .nullable()
    .optional(),
};

export const compareMetricTool: McpToolDefinition = {
  name: "compare_metric",
  title: "Compare metrics or windows",
  description:
    "Compare one metric against another over the same horizon, OR a single metric across two horizons. A horizon is either one of the five fixed trailing windows OR an explicit {from,to} date range (use `range`/`rangeB` for before-vs-after-a-date). Also resolves the clinical-signal metrics (grip strength, pain 0–10 NRS, waist circumference, waist-to-height ratio). A metric can be named by its alias, its key, or its display name in any language HealthLog ships (e.g. 'poids', 'Blutzucker'). Returns each side's rollup statistics (count, mean, min, max) with units and reference bands, plus a delta + percent change when both sides share a unit. Returns { present: false } when a side has no data.",
  inputShape: {
    metric: z.string().min(1).max(60),
    metricB: z.string().min(1).max(60).optional(),
    window: coachScopeWindowSchema.optional(),
    windowB: coachScopeWindowSchema.optional(),
    range: dateRangeShape.optional(),
    rangeB: dateRangeShape.optional(),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: compareMetricOutput,
  run(ctx, args) {
    return compareMetric(ctx.userId, {
      metric: String(args.metric ?? ""),
      metricB: typeof args.metricB === "string" ? args.metricB : undefined,
      window: args.window as never,
      windowB: args.windowB as never,
      range: args.range as DateRange | undefined,
      rangeB: args.rangeB as DateRange | undefined,
    });
  },
};

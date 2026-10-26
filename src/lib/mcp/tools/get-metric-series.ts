import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
} from "@/lib/ai/coach/types";
import { coachReadOutput } from "./output-shapes";
import { runCoachTool } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

export const getMetricSeriesTool: McpToolDefinition = {
  name: "get_metric_series",
  title: "Get a metric time series",
  description:
    "Fetch the user's own time series for ONE metric (e.g. bp, weight, pulse, hrv, resting_hr, steps, sleep, body composition, vo2_max). Returns an aggregate (count, min, max, mean, slope) plus recent-daily and weekly timelines, with units and population reference bands for safe phrasing. Returns { present: false } when the user has no data for that metric.",
  inputShape: {
    metric: coachScopeSourceSchema,
    window: coachScopeWindowSchema.optional(),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: coachReadOutput,
  run(ctx, args) {
    return runCoachTool(ctx, "get_metric_series", args);
  },
};

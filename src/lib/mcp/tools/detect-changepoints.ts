import { z } from "zod/v4";

import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import { detectChangepoints, type DateRange } from "@/lib/mcp/rich-reads";
import { dateRangeShape } from "./output-shapes";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

const detectChangepointsOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  metric: z.string().optional(),
  unit: z.string().optional(),
  granularity: z.string().optional(),
  windowDays: z.number().optional(),
  bucketsAnalysed: z.number().optional(),
  changepoints: z
    .array(
      z.object({
        at: z.string(),
        direction: z.enum(["increase", "decrease"]),
        beforeMean: z.number(),
        afterMean: z.number(),
        delta: z.number(),
      }),
    )
    .optional(),
};

export const detectChangepointsTool: McpToolDefinition = {
  name: "detect_changepoints",
  title: "Detect level shifts in a metric",
  description:
    "Surface points where a metric's level shifted over a trailing window OR an explicit {from,to} date range (e.g. 'when did my weight trend change?'). Also resolves the clinical-signal metrics (grip strength, pain 0–10 NRS, waist circumference, waist-to-height ratio). A metric can be named by its alias, its key, or its display name in any language HealthLog ships (e.g. 'poids', 'Blutzucker'). Runs a conservative changepoint scan over the rollup tier's bucket means and reports each shift's date, direction, and before/after means with units. High firing bar — returns { present: false } when too little data exists or no shift clears the threshold.",
  inputShape: {
    metric: z.string().min(1).max(60),
    window: coachScopeWindowSchema.optional(),
    range: dateRangeShape.optional(),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: detectChangepointsOutput,
  run(ctx, args) {
    return detectChangepoints(ctx.userId, {
      metric: String(args.metric ?? ""),
      window: args.window as never,
      range: args.range as DateRange | undefined,
    });
  },
};

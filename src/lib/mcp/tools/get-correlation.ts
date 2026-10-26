import { z } from "zod/v4";

import { getCorrelation } from "@/lib/mcp/rich-reads";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

const getCorrelationOutput: z.ZodRawShape = {
  present: z.boolean(),
  reason: z.string().optional(),
  pair: z
    .object({
      behaviour: z.string(),
      outcome: z.string(),
      direction: z.enum(["higher", "lower"]),
      lagDays: z.number(),
      n: z.number(),
      r: z.number(),
      note: z.string(),
    })
    .optional(),
  pairsTested: z.number().optional(),
  windowDays: z.number().optional(),
  association: z.literal("descriptive").optional(),
};

export const getCorrelationTool: McpToolDefinition = {
  name: "get_correlation",
  title: "Get a correlation between two metrics",
  description:
    "Fetch the statistically-vetted (FDR-controlled), lag-aware association between TWO named metrics the user tracks (e.g. 'sleep' and 'resting heart rate'). Re-exports the same discovery engine the other correlation surfaces run; returns the matched pair's direction, lag, sample size, Pearson r, and a descriptive — never causal — note. Returns { present: false } when no significant pattern links the pair (sparse data or the link did not clear the engine's floors).",
  inputShape: {
    metricA: z.string().min(1).max(60),
    metricB: z.string().min(1).max(60),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: getCorrelationOutput,
  run(ctx, args) {
    return getCorrelation(ctx.userId, {
      metricA: String(args.metricA ?? ""),
      metricB: String(args.metricB ?? ""),
    });
  },
};

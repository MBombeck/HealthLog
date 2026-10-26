import { coachReadOutput } from "./output-shapes";
import { runCoachTool } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

export const getCorrelationsTool: McpToolDefinition = {
  name: "get_correlations",
  title: "Get discovered correlations",
  description:
    "Fetch the user's statistically-vetted (FDR-controlled) driver pairs between behaviours (daylight, mood, glucose, blood pressure, steps, and with the environment module the weather, fine particles, ozone and pollen) and outcomes (sleep, HRV, resting HR, weight, mood, symptoms), each with direction, lag, sample size, and a descriptive — never causal — note over a fixed trailing window. Season and trend are removed from both series first. lagDays 1 pairs a day with the next day's outcome; lagDays 0 (the environment channels) pairs the mean of the day before and the day itself with that same day's outcome. Returns { present: false } when too little paired data exists.",
  inputShape: {},
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: coachReadOutput,
  run(ctx, args) {
    return runCoachTool(ctx, "get_correlations", args);
  },
};

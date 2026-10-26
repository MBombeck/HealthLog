import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import { coachReadOutput } from "./output-shapes";
import { runCoachTool } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

export const getSleepTool: McpToolDefinition = {
  name: "get_sleep",
  title: "Get sleep",
  description:
    "Fetch the user's sleep: per-night asleep + stage minutes plus the sleep-rhythm summary (sleep debt + chronotype). Returns { present: false } when no sleep is tracked.",
  inputShape: {
    window: coachScopeWindowSchema.optional(),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: coachReadOutput,
  run(ctx, args) {
    return runCoachTool(ctx, "get_sleep", args);
  },
};

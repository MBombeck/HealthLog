import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import { coachReadOutput } from "./output-shapes";
import { runCoachTool } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

export const getWorkoutsTool: McpToolDefinition = {
  name: "get_workouts",
  title: "Get workouts",
  description:
    "Fetch the user's workouts: the most recent sessions (sport, duration, energy, distance, avg/max HR) plus a per-sport rollup over the window. Use for training-load and 'how were my runs / am I overtraining?' questions. Returns { present: false } when no workouts are tracked.",
  inputShape: {
    window: coachScopeWindowSchema.optional(),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: coachReadOutput,
  run(ctx, args) {
    return runCoachTool(ctx, "get_workouts", args);
  },
};

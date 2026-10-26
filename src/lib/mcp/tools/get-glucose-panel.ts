import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import { coachReadOutput } from "./output-shapes";
import { runCoachTool } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

export const getGlucosePanelTool: McpToolDefinition = {
  name: "get_glucose_panel",
  title: "Get the glucose panel",
  description:
    "Fetch the user's glucose data: per-context daily means plus the trailing-30-day clinical panel (time-in-range, GMI, CV%, estimated A1c). Returns { present: false } when the user logs no glucose.",
  inputShape: {
    window: coachScopeWindowSchema.optional(),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: coachReadOutput,
  run(ctx, args) {
    return runCoachTool(ctx, "get_glucose_panel", args);
  },
};

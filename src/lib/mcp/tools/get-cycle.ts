import { coachReadOutput } from "./output-shapes";
import { runCoachTool } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

export const getCycleTool: McpToolDefinition = {
  name: "get_cycle",
  title: "Get menstrual cycle",
  description:
    "Fetch the user's menstrual-cycle context: current phase + day-of-cycle, the next predicted event, and the headline phase-correlation finding. Descriptive only — never a contraception-grade or 'safe day' claim. Gated on cycle tracking being enabled for the account; returns { present: false } when cycle tracking is off or there is no data.",
  inputShape: {},
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: coachReadOutput,
  run(ctx, args) {
    return runCoachTool(ctx, "get_cycle", args);
  },
};

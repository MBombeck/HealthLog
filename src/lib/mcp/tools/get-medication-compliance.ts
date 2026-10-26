import { coachScopeWindowSchema } from "@/lib/ai/coach/types";
import { coachReadOutput } from "./output-shapes";
import { runCoachTool, whenModuleOn } from "./shared";
import { READ_ONLY_ANNOTATIONS, type McpToolDefinition } from "./types";

export const getMedicationComplianceTool: McpToolDefinition = {
  name: "get_medication_compliance",
  title: "Get medication compliance",
  description:
    'Fetch the user\'s cadence-aware medication adherence: the dose-weighted compliance rate, expected vs taken/missed counts, current-cycle status, and any GLP-1 titration context. Returns { present: false } when no medications are tracked, and { present: false, reason: "module_disabled" } when the medications module is switched off.',
  inputShape: {
    window: coachScopeWindowSchema.optional(),
  },
  annotations: READ_ONLY_ANNOTATIONS,
  outputShape: coachReadOutput,
  run(ctx, args) {
    return whenModuleOn(ctx, "medications", "get_medication_compliance", () =>
      runCoachTool(ctx, "get_medication_compliance", args),
    );
  },
};

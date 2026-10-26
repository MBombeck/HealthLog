import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { getMedicationComplianceArgsSchema } from "../definitions";
import { subjectForTool } from "../availability";
import {
  badArgs,
  emptyRead,
  limitWindow,
  pickSection,
  readToolSnapshot,
} from "./shared";
import type { CoachToolResult } from "./types";

export async function getMedicationCompliance(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getMedicationComplianceArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return badArgs("get_medication_compliance", parsed.error);
  }
  const snapshot = await readToolSnapshot(
    userId,
    ["compliance"],
    ["compliance", "weeklyContext"],
    parsed.data.window,
    fallbackWindow,
    sharedScope,
    reach,
  );
  const compliance = pickSection(snapshot.sections, "compliance");
  // GLP-1 context rides the `weeklyContext` block.
  const weeklyContext = pickSection(snapshot.sections, "weeklyContext") as
    { glp1?: unknown } | undefined;
  const glp1 = weeklyContext?.glp1;
  if (compliance === undefined && glp1 === undefined) {
    return emptyRead(
      userId,
      "compliance",
      subjectForTool("get_medication_compliance"),
      limitWindow(parsed.data.window ?? fallbackWindow, reach),
      reach,
    );
  }
  return {
    present: true,
    data: {
      ...(compliance !== undefined ? { compliance } : {}),
      ...(glp1 !== undefined ? { glp1 } : {}),
    },
  };
}

import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { getGlucosePanelArgsSchema } from "../definitions";
import { subjectForTool } from "../availability";
import {
  badArgs,
  emptyRead,
  limitWindow,
  pickSection,
  readToolSnapshot,
} from "./shared";
import type { CoachToolResult } from "./types";

export async function getGlucosePanel(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getGlucosePanelArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_glucose_panel", parsed.error);
  const snapshot = await readToolSnapshot(
    userId,
    ["glucose"],
    ["glucose"],
    parsed.data.window,
    fallbackWindow,
    sharedScope,
    reach,
  );
  const section = pickSection(snapshot.sections, "glucose");
  if (section === undefined) {
    return emptyRead(
      userId,
      "glucose",
      subjectForTool("get_glucose_panel"),
      limitWindow(parsed.data.window ?? fallbackWindow, reach),
      reach,
    );
  }
  return {
    present: true,
    data: section,
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

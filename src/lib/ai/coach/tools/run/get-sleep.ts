import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { getSleepArgsSchema } from "../definitions";
import { subjectForTool } from "../availability";
import {
  badArgs,
  emptyRead,
  limitWindow,
  pickSection,
  readToolSnapshot,
} from "./shared";
import type { CoachToolResult } from "./types";

export async function getSleep(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getSleepArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_sleep", parsed.error);
  const snapshot = await readToolSnapshot(
    userId,
    ["sleep"],
    ["sleep", "sleepRhythm"],
    parsed.data.window,
    fallbackWindow,
    sharedScope,
    reach,
  );
  const nights = pickSection(snapshot.sections, "sleep");
  const rhythm = pickSection(snapshot.sections, "sleepRhythm");
  if (nights === undefined && rhythm === undefined) {
    return emptyRead(
      userId,
      "sleep",
      subjectForTool("get_sleep"),
      limitWindow(parsed.data.window ?? fallbackWindow, reach),
      reach,
    );
  }
  return {
    present: true,
    data: {
      ...(nights !== undefined ? { nights } : {}),
      ...(rhythm !== undefined ? { rhythm } : {}),
    },
    grounding: snapshot.referenceGrounding ?? undefined,
  };
}

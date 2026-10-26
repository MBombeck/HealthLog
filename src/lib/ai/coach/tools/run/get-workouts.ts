import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { getWorkoutsArgsSchema } from "../definitions";
import { subjectForTool } from "../availability";
import {
  badArgs,
  emptyRead,
  limitWindow,
  pickSection,
  readToolSnapshot,
} from "./shared";
import type { CoachToolResult } from "./types";

export async function getWorkouts(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getWorkoutsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_workouts", parsed.error);
  // The workouts block builds when the `workouts` cluster is active AND the
  // user has workout rows in the window. Scope the read to that single source.
  const snapshot = await readToolSnapshot(
    userId,
    ["workouts"],
    ["workouts"],
    parsed.data.window,
    fallbackWindow,
    sharedScope,
    reach,
  );
  const workouts = pickSection(snapshot.sections, "workouts");
  if (workouts === undefined) {
    return emptyRead(
      userId,
      "workouts",
      subjectForTool("get_workouts"),
      limitWindow(parsed.data.window ?? fallbackWindow, reach),
      reach,
    );
  }
  return { present: true, data: workouts };
}

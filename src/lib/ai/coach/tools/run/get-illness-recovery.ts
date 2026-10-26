import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import { buildIllnessScores } from "@/lib/ai/coach/illness-snapshot";
import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import {
  isBounded,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import { getIllnessRecoveryArgsSchema } from "../definitions";
import {
  OUTSIDE_REACH_REASON,
  illnessBeyondReach,
  subjectForTool,
} from "../availability";
import { emptyRead, limitWindow, pickSection, scopeFor } from "./shared";
import type { CoachToolResult } from "./types";

export async function getIllnessRecovery(
  userId: string,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  // Validate the (empty) args shape for consistency; an empty object always
  // passes.
  getIllnessRecoveryArgsSchema.parse({});
  // Recovery composites gate on the `recovery` module + the HRV/RHR/VO2max
  // sources; request them so the derived / dayStrain / trajectory blocks can
  // build when the module is on. Illness rides the snapshot unconditionally.
  //
  // Honour the conversation's window so the recovery/strain/
  // trajectory composites are computed over the horizon the caller asked for
  // rather than the builder default.
  //
  // Prefer the turn's shared full-source scope (which already
  // carries hrv/resting_hr/vo2_max + illness + derived) so this read lands the
  // inventory's cache entry; the narrow scope is the window-mismatch fallback.
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor(
      ["hrv", "resting_hr", "vo2_max"],
      fallbackWindow,
      fallbackWindow,
      sharedScope,
      reach,
    ),
    { reach },
  );
  const illness = pickSection(snapshot.sections, "illness");
  const derived = pickSection(snapshot.sections, "derived");
  const dayStrain = pickSection(snapshot.sections, "dayStrain");
  const trajectory = pickSection(snapshot.sections, "trajectory");
  // The computed illness retrospective the card shows
  // (recovery-gap, gap-driver, nadir, pre-onset, red flags) for the most
  // relevant episode. Read-only, coverage-gated (null when the engine
  // withholds), and the SAME engine the card + the red-flag notifier run, so
  // the Coach restates the numbers the user sees rather than the composite.
  const illnessScores = await buildIllnessScores(userId, undefined, reach);
  if (
    illness === undefined &&
    derived === undefined &&
    dayStrain === undefined &&
    trajectory === undefined &&
    illnessScores === null
  ) {
    // No row-backed subject: illness episodes + the recovery composites are
    // computed / module-gated, not a window slice of one table, so there is
    // nothing an availability probe could establish. Honest absence, unless
    // a lookback limit is what hid the episodes.
    if (isBounded(reach) && (await illnessBeyondReach(userId, reach))) {
      return { present: false, reason: OUTSIDE_REACH_REASON };
    }
    return emptyRead(
      userId,
      "illness_recovery",
      subjectForTool("get_illness_recovery"),
      limitWindow(fallbackWindow, reach),
      reach,
    );
  }
  return {
    present: true,
    data: {
      ...(illness !== undefined ? { illness } : {}),
      ...(illnessScores !== null ? { illnessScores } : {}),
      ...(derived !== undefined ? { derived } : {}),
      ...(dayStrain !== undefined ? { dayStrain } : {}),
      ...(trajectory !== undefined ? { trajectory } : {}),
    },
  };
}

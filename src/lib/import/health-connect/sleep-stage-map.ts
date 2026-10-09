/**
 * Health Connect sleep stages onto HealthLog's `SleepStage`.
 *
 * Health Connect (`SleepSessionRecord.StageType`):
 *   0 unknown, 1 awake, 2 sleeping, 3 out of bed, 4 light, 5 deep, 6 REM,
 *   7 awake in bed.
 *
 * Light sleep is what Apple calls core sleep, and both "awake" stages are
 * awake time inside the session. "Out of bed" is time the person was not in
 * bed at all, so it is no part of the night and is left out.
 *
 * "Unknown" (0) is the stage an app writes when it knows the person was in a
 * session but not what kind of sleep. Inside a session that also carries
 * real stages it is a gap the app could not classify, and counting it as
 * sleep would inflate the night; it is left out there. In a session made of
 * nothing but unknown stages it is the only record of the night, and it is
 * counted as plain sleep (`ASLEEP`), the same way a session without any
 * stages is.
 */
import type { SleepStage } from "@/generated/prisma/client";

export const HC_STAGE_UNKNOWN = 0;
export const HC_STAGE_OUT_OF_BED = 3;

const KNOWN_STAGES: Readonly<Record<number, SleepStage>> = {
  1: "AWAKE",
  2: "ASLEEP",
  4: "CORE",
  5: "DEEP",
  6: "REM",
  7: "AWAKE",
};

/** Why a stage was not mapped, for the result's skip counters. */
export type SleepStageSkip = "unknown_stage" | "out_of_bed" | "unmapped_stage";

/**
 * Map one stage. `sessionHasKnownStages` is whether the stage's session
 * carries at least one stage other than unknown and out of bed.
 */
export function mapHealthConnectSleepStage(
  stageType: number,
  sessionHasKnownStages: boolean,
): { stage: SleepStage } | { skip: SleepStageSkip } {
  if (stageType === HC_STAGE_OUT_OF_BED) return { skip: "out_of_bed" };
  if (stageType === HC_STAGE_UNKNOWN) {
    return sessionHasKnownStages
      ? { skip: "unknown_stage" }
      : { stage: "ASLEEP" };
  }
  const stage = KNOWN_STAGES[stageType];
  return stage ? { stage } : { skip: "unmapped_stage" };
}

/** Whether `stageType` is a classified stage (not unknown, not out of bed). */
export function isKnownSleepStage(stageType: number): boolean {
  return stageType in KNOWN_STAGES;
}

import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import type { CoachScope } from "@/lib/ai/coach/types";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import {
  isBounded,
  type CoachHistoryReach,
} from "@/lib/ai/coach/history-reach";
import { getCycleArgsSchema } from "../definitions";
import {
  OUTSIDE_REACH_REASON,
  cycleRecorded,
  subjectForTool,
} from "../availability";
import { badArgs, emptyRead, pickSection } from "./shared";
import type { CoachToolResult } from "./types";

export async function getCycle(
  userId: string,
  rawArgs: unknown,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getCycleArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_cycle", parsed.error);
  // The cycle block predicts from every logged cycle, so the snapshot leaves
  // it out under any lookback limit. Say why, rather than that it is absent.
  if (isBounded(reach)) {
    return (await isCycleAvailableForUser(userId)) &&
      (await cycleRecorded(userId))
      ? { present: false, reason: OUTSIDE_REACH_REASON }
      : { present: false, reason: "no_data" };
  }
  // The cycle block is gated INSIDE the builder by `isCycleAvailableForUser`
  // (the per-user toggle AND the operator switch), independent of `sources` —
  // so a minimal scope still surfaces it when the account tracks cycles, and a
  // non-cycle account structurally produces no block (→ present:false).
  //
  // Prefer the turn's shared full-source scope so this read
  // lands the inventory's cache entry; the empty-source scope is the fallback
  // when no shared scope is threaded.
  const snapshot = await buildCoachSnapshot(
    userId,
    sharedScope ?? { sources: [] },
    { reach },
  );
  const cycle = pickSection(snapshot.sections, "cycle");
  if (cycle === undefined) {
    // No row-backed subject: the cycle block is gated by the per-user toggle
    // AND the operator switch inside the builder, so an absent block is a gate
    // verdict rather than a window artefact.
    return emptyRead(
      userId,
      "cycle",
      subjectForTool("get_cycle"),
      sharedScope?.window,
      reach,
    );
  }
  return { present: true, data: cycle };
}

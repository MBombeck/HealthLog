import { buildCoachSnapshot } from "@/lib/ai/coach/snapshot";
import { buildLabsSnapshotBlock } from "@/lib/ai/coach/labs-snapshot";
import type { CoachScope, CoachScopeWindow } from "@/lib/ai/coach/types";
import type { CoachHistoryReach } from "@/lib/ai/coach/history-reach";
import { isModuleEnabled } from "@/lib/modules/gate";
import { getLabsArgsSchema } from "../definitions";
import { subjectForTool } from "../availability";
import { badArgs, emptyRead, pickSection, scopeFor } from "./shared";
import type { CoachToolResult } from "./types";

export async function getLabs(
  userId: string,
  rawArgs: unknown,
  fallbackWindow: CoachScopeWindow | undefined,
  sharedScope: CoachScope | undefined,
  reach: CoachHistoryReach,
): Promise<CoachToolResult> {
  const parsed = getLabsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return badArgs("get_labs", parsed.error);
  // The labs module off: said as such, not probed for rows (the block below
  // would be empty and the availability probe would count lab rows).
  if (!(await isModuleEnabled(userId, "labs"))) {
    return { present: false, reason: "module_disabled" };
  }
  // Labs ride the snapshot regardless of `sources` (attached unconditionally),
  // so a minimal scope still surfaces them.
  //
  // The labs block is intentionally window-AGNOSTIC: the latest
  // reading per biomarker with its summarised history, over the whole record
  // or the user's lookback limit (#1263). We still thread the conversation's
  // window onto the scope so the snapshot's `scope` block reports the right
  // horizon for the turn; it does not move the labs read.
  //
  // Prefer the turn's shared full-source scope so this read
  // lands the inventory's cache entry; fall back to a tight empty-source scope
  // (labs ride unconditionally) when no shared scope or a window mismatch.
  const snapshot = await buildCoachSnapshot(
    userId,
    scopeFor([], fallbackWindow, fallbackWindow, sharedScope, reach),
    { reach },
  );
  const labs = pickSection(snapshot.sections, "labs") as
    { recent?: Array<{ name?: string; analyte?: string }> } | undefined;
  if (labs === undefined) {
    // The labs read is window-AGNOSTIC: it searched the whole record, or up to
    // the lookback limit when there is one. A panel older than the limit must
    // not read as "no labs on file", so the limit is the searched window.
    return emptyRead(
      userId,
      "labs",
      subjectForTool("get_labs"),
      reach.window,
      reach,
    );
  }

  const analyte = parsed.data.analyte?.trim().toLowerCase();
  if (analyte) {
    // #1263 — a named read carries each matching marker's history over the
    // whole record (or the limit), summarised. Read on its own rather than
    // out of the snapshot, whose labs block holds the latest values only.
    const named = await buildLabsSnapshotBlock(userId, new Date(), reach, {
      analyte,
    });
    if (!named) return { present: false, reason: "analyte_not_found" };
    return { present: true, data: named };
  }
  return { present: true, data: labs };
}

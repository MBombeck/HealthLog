import type { DayRunningItem } from "@/lib/day/contract";

import { CYCLE_PHASE_LINE_KEY } from "./label-keys";

/**
 * The quiet line under a running cycle: "Cycle day 12, follicular phase",
 * or the cycle day alone when the server could not place a phase. The
 * server sends the phase as a closed code in `sub`; it is worded here, in
 * the reader's language. Null for anything but a counted cycle.
 */
export function cycleRunningLine(
  item: Pick<DayRunningItem, "kind" | "sub" | "dayIndex">,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (item.kind !== "cyclePhase" || item.dayIndex === null) return null;
  const key =
    item.sub === null
      ? undefined
      : (CYCLE_PHASE_LINE_KEY as Readonly<Record<string, string>>)[item.sub];
  if (key) return t(key, { n: item.dayIndex });
  return t("day.cycleDay", { n: item.dayIndex });
}

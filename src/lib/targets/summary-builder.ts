import type { TargetItem, TargetPageSummary } from "./types";

type SummaryTarget = Pick<
  TargetItem,
  "type" | "daysInRange7d" | "insufficientData" | "streakDays"
>;

export function buildTargetPageSummary(
  targets: ReadonlyArray<SummaryTarget>,
): TargetPageSummary {
  const targetsMetThisWeek = targets.filter(
    (target) => !target.insufficientData && target.daysInRange7d >= 4,
  ).length;
  let streakHighlight: TargetPageSummary["streakHighlight"] = null;
  for (const target of targets) {
    if (target.streakDays < 3) continue;
    if (!streakHighlight || target.streakDays > streakHighlight.days) {
      streakHighlight = { metric: target.type, days: target.streakDays };
    }
  }
  return {
    targetsMetThisWeek,
    totalTargets: targets.length,
    streakHighlight,
  };
}

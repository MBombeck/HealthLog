/**
 * The logged periods the calendar feed may include as history (#1350).
 *
 * Pure. A period runs from the cycle's start to its `periodEndDate` when one
 * is recorded, otherwise across its observed bleeding days (the engine's own
 * §2 run rule), otherwise it is the start day alone. It never runs past today
 * or into the next cycle.
 */
import { addDays, dayDiff } from "@/lib/cycle/day-math";
import { observedPeriodLength } from "@/lib/cycle/prediction";
import type { DayLogInput, FlowLevel } from "@/lib/cycle/types";

import type { HistoryPeriod } from "./events";

export interface HistoryCycleRow {
  id: string;
  startDate: string;
  periodEndDate: string | null;
}

/** The earliest start of the last `count` cycles at or before today. */
export function historyWindowStart(
  cycles: readonly HistoryCycleRow[],
  today: string,
  count: number,
): string | null {
  return recent(cycles, today, count)[0]?.startDate ?? null;
}

function recent(
  cycles: readonly HistoryCycleRow[],
  today: string,
  count: number,
): HistoryCycleRow[] {
  if (count <= 0) return [];
  return [...cycles]
    .filter((c) => dayDiff(today, c.startDate) >= 0)
    .sort((a, b) => dayDiff(a.startDate, b.startDate))
    .slice(-count);
}

export function historyPeriods(
  cycles: readonly HistoryCycleRow[],
  flowDays: ReadonlyArray<{ date: string; flow: FlowLevel | null }>,
  today: string,
  count: number,
): HistoryPeriod[] {
  const chosen = recent(cycles, today, count);
  const sortedStarts = [...cycles]
    .map((c) => c.startDate)
    .sort((a, b) => dayDiff(a, b));
  const logs: DayLogInput[] = flowDays.map((d) => ({
    date: d.date,
    flow: d.flow,
    basalBodyTempC: null,
    ovulationTest: null,
    cervicalMucus: null,
  }));

  return chosen.map((c) => {
    let end = c.startDate;
    if (c.periodEndDate && dayDiff(c.periodEndDate, c.startDate) >= 0) {
      end = c.periodEndDate;
    } else {
      const observed = observedPeriodLength(c.startDate, logs);
      if (observed > 1) end = addDays(c.startDate, observed - 1);
    }
    const nextStart = sortedStarts.find((s) => dayDiff(s, c.startDate) > 0);
    if (nextStart && dayDiff(end, nextStart) >= 0) end = addDays(nextStart, -1);
    if (dayDiff(end, today) > 0) end = today;
    return { cycleId: c.id, start: c.startDate, end };
  });
}

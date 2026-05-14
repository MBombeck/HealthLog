/**
 * v1.4.25 W19e — pure compliance chip aggregator.
 *
 * Reuses `buildCadenceTimeline` to count taken vs missed slots over a
 * rolling window. The W19e detail page surfaces four chips: adherence
 * rate, current streak (days), longest streak (days), missed in last
 * 30 days. Each chip is monochrome — Marc-memory: no gamified badges.
 *
 * Distinct from `src/lib/analytics/compliance.ts.calculateCompliance`:
 * that helper computes against expected counts (schedules-per-day ×
 * days) and is used by the existing /api/medications/[id]/compliance
 * route. This module computes against the pair-matched timeline so
 * the chips and the cadence chart agree on every single dose.
 */

import {
  buildCadenceTimeline,
  type IntakeEventLike,
  type PairedDose,
  type ScheduleLike,
} from "./cadence";

export interface ComplianceChips {
  /** 0-100, taken / (taken + missed). Skipped doses are excluded from
   *  the denominator — they represent a deliberate user decision, not
   *  a compliance failure. Null when no doses were expected in the
   *  window (e.g. brand-new medication, paused). */
  adherenceRate: number | null;
  /** Consecutive days, ending at `asOf`, where every expected dose
   *  for the day was taken (or skipped). Days without any expected
   *  dose advance the streak; missed days break it. */
  currentStreak: number;
  /** Longest run of all-taken-or-skipped days anywhere in the window. */
  longestStreak: number;
  /** Count of `status === "missed"` doses inside the window. */
  missedLast30: number;
  /** Window size used (mirrors the input for the chart legend). */
  windowDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Group paired doses by local day, then evaluate each day's status:
 *   - all-good : every slot taken or skipped or upcoming
 *   - bad      : at least one slot missed
 *
 * Streak rules: consecutive all-good days from `asOf` backwards
 * (inclusive of today). The streak does not reset on a day that had
 * no expected doses — the user gets credit for not breaking on
 * non-scheduled days.
 */
function streaksFromTimeline(
  timeline: PairedDose[],
  asOf: Date,
  windowDays: number,
): { current: number; longest: number } {
  const byDay = new Map<string, "all-good" | "bad">();
  for (const slot of timeline) {
    const key = localDayKey(slot.day);
    const existing = byDay.get(key);
    const isBad = slot.status === "missed";
    if (isBad) {
      byDay.set(key, "bad");
    } else if (existing !== "bad") {
      byDay.set(key, "all-good");
    }
  }

  let current = 0;
  let longest = 0;
  let run = 0;

  // Iterate from oldest day in the window forward to `asOf`. Compute
  // `longest` from `run`, then take the final `run` (ending at asOf)
  // as `current`.
  const startOfToday = new Date(asOf);
  startOfToday.setHours(0, 0, 0, 0);
  const from = new Date(startOfToday.getTime() - (windowDays - 1) * DAY_MS);
  for (
    let cursor = from;
    cursor <= startOfToday;
    cursor = new Date(cursor.getTime() + DAY_MS)
  ) {
    const key = localDayKey(cursor);
    const state = byDay.get(key);
    if (state === "bad") {
      if (run > longest) longest = run;
      run = 0;
    } else {
      run++;
    }
  }
  if (run > longest) longest = run;
  current = run;

  return { current, longest };
}

export function complianceChips(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  asOf: Date,
  windowDays = 30,
  anchor?: Date,
): ComplianceChips {
  const timeline = buildCadenceTimeline(
    schedules,
    events,
    asOf,
    windowDays,
    anchor,
  );
  const taken = timeline.filter((d) => d.status === "taken").length;
  const missed = timeline.filter((d) => d.status === "missed").length;
  const denom = taken + missed;
  const adherenceRate = denom === 0 ? null : Math.round((taken / denom) * 100);
  const { current, longest } = streaksFromTimeline(
    timeline,
    asOf,
    windowDays,
  );
  return {
    adherenceRate,
    currentStreak: current,
    longestStreak: longest,
    missedLast30: missed,
    windowDays,
  };
}

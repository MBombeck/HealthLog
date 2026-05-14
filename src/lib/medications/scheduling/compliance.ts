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
 *
 * v1.4.25 W21 Fix-O — accepts an optional IANA `timeZone` argument
 * forwarded into the timeline + streak math so a user in Tokyo gets
 * the same chip values as a user in Berlin even when the host's
 * system time is set differently. Omitting the argument keeps the
 * legacy system-local behaviour the W19e tests pin.
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

/**
 * Day-key in the user's timezone (or system-local when `tz` is
 * undefined). `Intl.DateTimeFormat` with `en-CA` reliably returns
 * `YYYY-MM-DD`, which sorts lexically and matches the chart
 * legend's `day` ticks.
 */
function localDayKey(d: Date, tz: string | undefined): string {
  if (!tz) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
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
  timeZone: string | undefined,
): { current: number; longest: number } {
  const byDay = new Map<string, "all-good" | "bad">();
  for (const slot of timeline) {
    const key = localDayKey(slot.day, timeZone);
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

  // Walk the window day-by-day from oldest to newest. Stepping by
  // 25 h then re-keying via `localDayKey` keeps the cursor inside
  // the right calendar day across DST boundaries — the absolute
  // distance between two consecutive local midnights is 23/24/25 h
  // around spring-forward / fall-back.
  let cursor = new Date(asOf.getTime() - (windowDays - 1) * DAY_MS);
  let lastKey = "";
  for (let i = 0; i < windowDays; i++) {
    const key = localDayKey(cursor, timeZone);
    if (key !== lastKey) {
      const state = byDay.get(key);
      if (state === "bad") {
        if (run > longest) longest = run;
        run = 0;
      } else {
        run++;
      }
      lastKey = key;
    }
    cursor = new Date(cursor.getTime() + DAY_MS);
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
  timeZone?: string,
): ComplianceChips {
  const timeline = buildCadenceTimeline(
    schedules,
    events,
    asOf,
    windowDays,
    anchor,
    timeZone,
  );
  const taken = timeline.filter((d) => d.status === "taken").length;
  const missed = timeline.filter((d) => d.status === "missed").length;
  const denom = taken + missed;
  const adherenceRate = denom === 0 ? null : Math.round((taken / denom) * 100);
  const { current, longest } = streaksFromTimeline(
    timeline,
    asOf,
    windowDays,
    timeZone,
  );
  return {
    adherenceRate,
    currentStreak: current,
    longestStreak: longest,
    missedLast30: missed,
    windowDays,
  };
}

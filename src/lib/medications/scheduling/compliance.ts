/**
 * v1.4.25 — pure compliance chip aggregator.
 *
 * Reuses `buildCadenceTimeline` to count taken vs missed slots over a
 * rolling window. The W19e detail page surfaces four chips: adherence
 * rate, current streak (days), longest streak (days), missed in last
 * 30 days. Each chip is monochrome — maintainer note: no gamified badges.
 *
 * Adherence and missed doses come from the compliance ledger the
 * /api/medications/[id]/compliance route reads, so the chips and the
 * detail page's rate agree; the streaks walk the pair-matched timeline
 * the cadence chart draws.
 *
 * The timeline and streak math run in the context's IANA zone, so a user
 * in Tokyo gets the same chip values as a user in Berlin whatever the
 * host's system time is.
 */

import {
  buildCadenceTimeline,
  startOfLocalDay,
  type IntakeEventLike,
  type PairedDose,
  type ScheduleLike,
} from "./cadence";
import {
  trailingComplianceLedger,
  trailingComplianceTally,
} from "@/lib/analytics/compliance/ledger";
import type { ComplianceMedicationContext } from "@/lib/analytics/compliance/types";
import { userDayKey } from "@/lib/tz/resolver";

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
 * undefined). Routes through the canonical `userDayKey` so the
 * `YYYY-MM-DD` bucket stays byte-for-byte aligned with every other
 * day-bucketed surface; the host-local branch covers the pre-per-user
 * callers that pass no zone.
 */
function localDayKey(d: Date, tz: string | undefined): string {
  if (!tz) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return userDayKey(d, tz);
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
 *
 * Exported so `src/lib/analytics/compliance.ts` can share this exact
 * timezone-aware streak math instead of duplicating it with host-tz
 * day keys — the two call sites stay byte-for-byte identical on the
 * streak rule.
 */
export function streaksFromTimeline(
  timeline: PairedDose[],
  asOf: Date,
  windowDays: number,
  timeZone: string | undefined,
): { current: number; longest: number } {
  // A day with a missed slot breaks the run. A day whose slots are all
  // still upcoming (today before its doses) neither extends nor breaks it:
  // counting it as good showed a one-day streak the morning after two
  // missed days. A run starts on a day with an answered dose, so a streak
  // is never a number without a dose behind it.
  const byDay = new Map<string, "all-good" | "bad" | "open">();
  for (const slot of timeline) {
    const key = localDayKey(slot.day, timeZone);
    const existing = byDay.get(key);
    if (slot.status === "missed") {
      byDay.set(key, "bad");
    } else if (slot.status === "upcoming") {
      if (existing === undefined) byDay.set(key, "open");
    } else if (existing !== "bad") {
      byDay.set(key, "all-good");
    }
  }

  let current = 0;
  let longest = 0;
  let run = 0;

  // Walk the window day-by-day from oldest to newest. Snap each cursor
  // to the user-local midnight and advance by +25 h then re-snap — the
  // distance between two consecutive local midnights is 23 / 24 / 25 h
  // around spring-forward / fall-back, and +25 h always clears the
  // shortest (23 h) day while the re-snap collapses the longest (25 h)
  // day back to its own midnight. This visits every local calendar day
  // in the window exactly once instead of the prior fixed +24 h step
  // that could skip a day on a 23 h spring-forward boundary (its
  // comment already claimed 25 h while the code stepped 24 h).
  const startDay = startOfLocalDay(
    new Date(asOf.getTime() - (windowDays - 1) * DAY_MS),
    timeZone,
  );
  const endDay = startOfLocalDay(asOf, timeZone);
  for (
    let cursor = startDay;
    cursor.getTime() <= endDay.getTime();
    cursor = startOfLocalDay(
      new Date(cursor.getTime() + 25 * 60 * 60 * 1000),
      timeZone,
    )
  ) {
    const state = byDay.get(localDayKey(cursor, timeZone));
    if (state === "bad") {
      if (run > longest) longest = run;
      run = 0;
    } else if (state === "all-good" || (state === undefined && run > 0)) {
      // A day without an expected dose carries a run on, and never starts
      // one: before the first answered dose there is nothing to count, and
      // a new medication read "1 day streak" with no dose yet.
      run++;
    }
  }
  if (run > longest) longest = run;
  current = run;

  return { current, longest };
}

/**
 * The four chips: adherence and missed doses from the compliance ledger the
 * detail page's rate reads (`trailingComplianceTally`, with the medication's
 * pause eras and courses), the streaks from the cadence timeline (a
 * day-grain "every dose taken or skipped" rule, orthogonal to per-dose
 * attribution).
 */
export function complianceChips(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  ctx: ComplianceMedicationContext,
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
    ctx.timeZone,
    ctx,
  );
  const { taken, missed } = trailingComplianceTally(
    trailingComplianceLedger(events, schedules, ctx, asOf),
    windowDays,
    asOf,
  );
  const denom = taken + missed;
  const adherenceRate = denom === 0 ? null : Math.round((taken / denom) * 100);
  const { current, longest } = streaksFromTimeline(
    timeline,
    asOf,
    windowDays,
    ctx.timeZone,
  );
  return {
    adherenceRate,
    currentStreak: current,
    longestStreak: longest,
    missedLast30: missed,
    windowDays,
  };
}

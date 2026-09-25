/**
 * v1.4.25 W19e — pure compliance chip aggregator.
 *
 * Reuses `buildCadenceTimeline` to count taken vs missed slots over a
 * rolling window. The W19e detail page surfaces four chips: adherence
 * rate, current streak (days), longest streak (days), missed in last
 * 30 days. Each chip is monochrome — maintainer note: no gamified badges.
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

import type { SlotBand } from "./attribution";
import { type BandMinterMedication } from "./band-minter";
import { buildBandsForSchedulesWithEras } from "./schedule-eras";
import {
  buildCadenceTimeline,
  startOfLocalDay,
  type CadenceEngineContext,
  type IntakeEventLike,
  type PairedDose,
  type ScheduleLike,
} from "./cadence";
import { reconstructDoseHistory, type HistoryIntake } from "./dose-history";
import { type CanonicalSchedule, type RecurrenceContext } from "./recurrence";
import { normaliseDoseWindows } from "./worker-helpers";
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
    } else {
      run++;
    }
  }
  if (run > longest) longest = run;
  current = run;

  return { current, longest };
}

/**
 * v1.15.18 — band-ledger tally counts for the detail-page chips.
 *
 * When the route threads an engine context (RRULE / rolling / cyclic /
 * one-shot / PRN / legacy) the adherence rate + missed count come from the
 * SAME unified dose-history ledger the compliance % and the history view
 * read — so the chips can never contradict either. The streak still walks
 * the cadence timeline (its day-grain "every dose taken or skipped" rule is
 * orthogonal to per-dose attribution). Returns null when there is no engine
 * context (a pure-math caller) — the caller then falls back to the legacy
 * timeline tally.
 */
function ledgerChipCounts(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  asOf: Date,
  windowDays: number,
  timeZone: string | undefined,
  engineCtx: CadenceEngineContext | undefined,
): { taken: number; missed: number } | null {
  if (!engineCtx) return null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const from = new Date(asOf.getTime() - windowDays * DAY_MS);
  const userTz = engineCtx.timeZone || timeZone || "UTC";

  const medication: BandMinterMedication = {
    id: "chips-tally",
    startsOn: engineCtx.startsOn,
    endsOn: engineCtx.endsOn,
    oneShot: engineCtx.oneShot,
    createdAt: engineCtx.createdAt,
  };
  const recurrenceCtx: RecurrenceContext = {
    medication: {
      id: "chips-tally",
      startsOn: engineCtx.startsOn,
      endsOn: engineCtx.endsOn,
      oneShot: engineCtx.oneShot,
      createdAt: engineCtx.createdAt,
    },
    timeZone: userTz,
    lastIntakeAt: engineCtx.lastIntakeAt,
  };
  const canonicalSchedules: CanonicalSchedule[] = schedules.map((s, i) => {
    const base: CanonicalSchedule = {
      id: s.id ?? `chips-${i}`,
      rrule: s.rrule ?? null,
      rollingIntervalDays: s.rollingIntervalDays ?? null,
      timesOfDay: s.timesOfDay ?? [],
      daysOfWeek: s.daysOfWeek ?? null,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      reminderGraceMinutes: s.reminderGraceMinutes ?? null,
      scheduleType: s.scheduleType ?? "SCHEDULED",
      cyclicOnWeeks: s.cyclicOnWeeks ?? null,
      cyclicOffWeeks: s.cyclicOffWeeks ?? null,
      doseWindows: normaliseDoseWindows(s.doseWindows),
    };
    // Surface windowStart as the single time-of-day for a legacy daily row
    // so the band minter's cadence gate mints its daily band (see the
    // analytics/compliance tally for the same normalisation).
    if (
      base.timesOfDay.length === 0 &&
      base.rrule === null &&
      base.rollingIntervalDays === null &&
      base.scheduleType !== "PRN" &&
      !engineCtx.oneShot
    ) {
      return { ...base, timesOfDay: [base.windowStart] };
    }
    return base;
  });

  const intakeInstants = events
    .filter((e) => !e.skipped && e.takenAt !== null && e.takenAt <= asOf)
    .map((e) => e.takenAt as Date)
    .sort((a, b) => a.getTime() - b.getTime());

  const groups = buildBandsForSchedulesWithEras({
    medication,
    schedules: canonicalSchedules,
    revisions: engineCtx.scheduleRevisions ?? [],
    ctx: recurrenceCtx,
    userTz,
    range: { from, to: asOf },
    now: asOf,
    intakeInstants,
  });
  const bands: SlotBand[] = [];
  for (const g of groups) {
    if (g.hasExpectedSlots) bands.push(...g.bands);
  }

  const intakes: HistoryIntake[] = events
    .filter((e) => e.scheduledFor >= from && e.scheduledFor <= asOf)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
      // v1.15.20 — pinned takes bind by anchor (taken-late, slot served).
      pinned: e.attributionSource === "USER_PIN",
    }));

  const rows = reconstructDoseHistory(
    bands,
    intakes,
    asOf,
    engineCtx.createdAt,
  );
  let taken = 0;
  let missed = 0;
  for (const row of rows) {
    if (row.status === "taken_on_time" || row.status === "taken_late") taken++;
    else if (row.status === "missed") missed++;
  }
  return { taken, missed };
}

export function complianceChips(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  asOf: Date,
  windowDays = 30,
  anchor?: Date,
  timeZone?: string,
  engineCtx?: CadenceEngineContext,
): ComplianceChips {
  const timeline = buildCadenceTimeline(
    schedules,
    events,
    asOf,
    windowDays,
    anchor,
    timeZone,
    engineCtx,
  );
  // v1.15.18 — adherence + missed come from the unified band ledger when an
  // engine context is present (so the chips agree with the % and the history
  // view); the legacy timeline tally is the fallback for pure-math callers.
  const ledger = ledgerChipCounts(
    schedules,
    events,
    asOf,
    windowDays,
    timeZone,
    engineCtx,
  );
  const taken = ledger
    ? ledger.taken
    : timeline.filter((d) => d.status === "taken").length;
  const missed = ledger
    ? ledger.missed
    : timeline.filter((d) => d.status === "missed").length;
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

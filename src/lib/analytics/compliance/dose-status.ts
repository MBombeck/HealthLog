// Extracted from the former single-file `compliance.ts`. See `../compliance.ts`
// (the barrel) for the module map. Pure move — no logic changes.

import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";
import type { ComplianceSchedule } from "./types";

/**
 * v1.15.9 — cadence-aware per-dose grace/miss window model.
 *
 * A medication's dose either is on-time, is still takeable but late
 * (counts when taken), or has slipped past the point where a self-hoster
 * could plausibly still take it (a MISS). The cutoffs differ by cadence:
 * an intraday/daily dose has tight hour-scale windows; a weekly/rolling
 * injectable (the GLP-1 case) follows the clinical "take it within 4 days,
 * otherwise skip to the next scheduled dose" rule.
 *
 * The defaults below are centralised named constants so a future revision
 * can expose them per-medication without re-deriving the boundaries. Make
 * it correct first; configurability later.
 *
 * DAILY / INTRADAY (minute-scale windows around the target instant):
 *   - on-time:    target − 60 min … target + 60 min
 *   - overdue:    target + 60 min … target + 240 min  (still takeable)
 *   - missed:     > target + 240 min, OR the next dose's on-time window
 *                 starts first (whichever is sooner — adjacent doses never
 *                 overlap).
 *
 * WEEKLY / ROLLING injectable (day-scale windows; the 4-day clinical rule):
 *   - on-time:    target day ± 1 day
 *   - overdue:    up to target + 4 days  (late-but-counts)
 *   - missed:     > target + 4 days
 */
export { DOSE_WINDOW_DEFAULTS };

/**
 * v1.15.9 — the derived per-dose state the medication card renders.
 *
 *   - `on_time_window` — due now, inside the on-time window (green).
 *   - `overdue`        — past on-time, before the miss cutoff (still
 *                        takeable; the card escalates the tint as it nears
 *                        the cutoff — "stark überfällig").
 *   - `missed`         — past the miss cutoff, never acted on.
 *   - `taken_on_time`  — taken inside the on-time window.
 *   - `taken_late`     — taken in the overdue window (still counts).
 *   - `skipped`        — a deliberate user skip (excluded from the rate).
 *   - `upcoming`       — the on-time window has not opened yet.
 *
 * PRN doses are never scheduled and so never produce a status — callers
 * exclude them before resolving a dose.
 */
export type DoseStatus =
  | "upcoming"
  | "on_time_window"
  | "overdue"
  | "missed"
  | "taken_on_time"
  | "taken_late"
  | "skipped";

/** Cadence family the window math keys off. */
export type DoseCadenceFamily = "daily" | "weekly";

const HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * HOUR_MS;

/**
 * The default-window band of a dose at `targetAt`, for a dose the ledger has
 * not minted (a future one). The state itself is resolved by
 * `dose-state/resolve.ts`, the one place that turns a band into a state.
 */
export function defaultDoseBand(
  targetAt: Date,
  cadence: DoseCadenceFamily,
  options?: {
    nextDoseAt?: Date | null;
    windows?: Partial<typeof DOSE_WINDOW_DEFAULTS>;
  },
): {
  at: Date;
  onTimeStart: Date;
  onTimeEnd: Date;
  overdueEnd: Date;
  earlyStart: Date;
} {
  const w = { ...DOSE_WINDOW_DEFAULTS, ...(options?.windows ?? {}) };
  const target = targetAt.getTime();

  let onTimeStart: number;
  let onTimeEnd: number;
  let overdueEnd: number;
  if (cadence === "weekly") {
    onTimeStart = target - w.weeklyOnTimeDays * ONE_DAY_MS;
    onTimeEnd = target + w.weeklyOnTimeDays * ONE_DAY_MS;
    overdueEnd = target + w.weeklyOverdueDays * ONE_DAY_MS;
  } else {
    onTimeStart = target - w.dailyOnTimeMinutes * 60_000;
    onTimeEnd = target + w.dailyOnTimeMinutes * 60_000;
    overdueEnd = onTimeEnd + w.dailyOverdueMinutes * 60_000;
  }

  // Never let the miss cutoff bleed into the next dose's on-time window.
  if (options?.nextDoseAt) {
    const nextOnTimeStart =
      cadence === "weekly"
        ? options.nextDoseAt.getTime() - w.weeklyOnTimeDays * ONE_DAY_MS
        : options.nextDoseAt.getTime() - w.dailyOnTimeMinutes * 60_000;
    if (nextOnTimeStart < overdueEnd) overdueEnd = nextOnTimeStart;
  }
  return {
    at: targetAt,
    onTimeStart: new Date(onTimeStart),
    onTimeEnd: new Date(onTimeEnd),
    overdueEnd: new Date(overdueEnd),
    earlyStart: new Date(onTimeStart),
  };
}

/**
 * v1.15.9 — classify a schedule's cadence into the {@link DoseCadenceFamily}
 * the window model uses. A rolling cadence, or any RRULE / legacy weekly
 * cadence that emits less often than daily, is `weekly` (day-scale windows +
 * the 4-day rule); everything denser (daily, intraday multi-dose) is
 * `daily` (minute-scale windows).
 */
export function doseCadenceFamily(
  schedule: ComplianceSchedule,
): DoseCadenceFamily {
  if (
    schedule.rollingIntervalDays != null &&
    schedule.rollingIntervalDays >= 2
  ) {
    return "weekly";
  }
  const rrule = schedule.rrule ?? "";
  if (/FREQ=(WEEKLY|MONTHLY|YEARLY)/i.test(rrule)) return "weekly";
  // A legacy daysOfWeek restriction to specific weekdays (not every day)
  // dosed once a day is still effectively daily-cadence on the days it
  // fires; the per-slot window is minute-scale either way. Only the rolling
  // / calendar-sparse shapes use the day-scale 4-day rule.
  return "daily";
}

/**
 * When a planned dose counts as on time, late and missed, in words, for the
 * person setting the plan up ("08:00: on time until 09:00, late until 12:00,
 * then missed").
 *
 * The instants come from the band minter the dose history, the compliance
 * rate and the reminders use (`buildSlotBands`), not from a second copy of
 * the arithmetic: the late tail is capped at the next dose's window, so two
 * doses close together show the cutoff the server will actually apply. The
 * plan is minted on a fixed reference day in UTC and read back as wall-clock
 * `HH:mm`; a daylight-saving day shifts real instants, never these words.
 *
 * Client-safe: pure, no clock, no time zone.
 */
import { buildSlotBands, type SlotWindowInput } from "./attribution";
import { DOSE_WINDOW_DEFAULTS } from "./dose-window-defaults";
import { hhmmToMinutesOrNull } from "./hhmm";

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
/** Any fixed day; only wall-clock differences are read back. */
const REFERENCE_DAY_MS = Date.UTC(2000, 0, 3);

export interface DoseWindowPlanLine {
  timeOfDay: string;
  /** End of the on-time window, `HH:mm`. */
  onTimeUntil: string;
  /** End of the late tail (the miss cutoff), `HH:mm`. */
  lateUntil: string;
}

function hhmm(minutes: number): string {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function slot(
  minutes: number,
  timeOfDay: string,
  window: { start: number; end: number } | null,
): SlotWindowInput {
  const at = new Date(REFERENCE_DAY_MS + minutes * MINUTE_MS);
  const half = DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes;
  const dayStart = minutes - (hhmmToMinutesOrNull(timeOfDay) ?? minutes);
  return {
    at,
    timeOfDay,
    onTimeStart: new Date(
      REFERENCE_DAY_MS +
        (window ? dayStart + window.start : minutes - half) * MINUTE_MS,
    ),
    onTimeEnd: new Date(
      REFERENCE_DAY_MS +
        (window ? dayStart + window.end : minutes + half) * MINUTE_MS,
    ),
    lateGraceMs: DOSE_WINDOW_DEFAULTS.dailyOverdueMinutes * MINUTE_MS,
  };
}

/**
 * The plan of a daily (minute-scale) schedule: one line per dose time, in
 * time order. `windows` are the schedule's explicit per-dose windows; a time
 * without one keeps the default band.
 */
export function intradayDoseWindowPlan(
  timesOfDay: readonly string[],
  windows: readonly { timeOfDay: string; start: string; end: string }[] = [],
): DoseWindowPlanLine[] {
  const byTime = new Map(windows.map((w) => [w.timeOfDay, w]));
  const times = [...new Set(timesOfDay)]
    .map((t) => ({ t, m: hhmmToMinutesOrNull(t) }))
    .filter((x): x is { t: string; m: number } => x.m !== null)
    .sort((a, b) => a.m - b.m);
  if (times.length === 0) return [];
  const windowOf = (t: string) => {
    const w = byTime.get(t);
    const start = w ? hhmmToMinutesOrNull(w.start) : null;
    const end = w ? hhmmToMinutesOrNull(w.end) : null;
    return start !== null && end !== null && start < end
      ? { start, end }
      : null;
  };
  // The next day's first dose caps the last dose's tail, as it does on the
  // server; it is minted and then left out of the answer.
  const slots = [
    ...times.map(({ t, m }) => slot(m, t, windowOf(t))),
    slot(times[0].m + DAY_MINUTES, times[0].t, windowOf(times[0].t)),
  ];
  return buildSlotBands(slots)
    .slice(0, times.length)
    .map((band) => ({
      timeOfDay: band.timeOfDay,
      onTimeUntil: hhmm(
        (band.onTimeEnd.getTime() - REFERENCE_DAY_MS) / MINUTE_MS,
      ),
      lateUntil: hhmm(
        (band.overdueEnd.getTime() - REFERENCE_DAY_MS) / MINUTE_MS,
      ),
    }));
}

/** The late tail of a weekly or rolling (day-scale) schedule, in days. */
export function dayScaleLateDays(): number {
  return DOSE_WINDOW_DEFAULTS.weeklyOverdueDays;
}

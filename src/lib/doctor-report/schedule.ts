/**
 * The scheduled doctor report: the stored shape of `User.reportScheduleJson`
 * and the period maths the daily `report-schedule` job runs on.
 *
 * A schedule names a cadence (a calendar month, quarter or year) and a
 * window (the closed period itself, or the last 90 or 365 days up to its
 * end). Once a period has closed on the record's own clock, the job renders
 * the report for it and files it into the document vault under the source
 * key `REPORT_SCHEDULE` / `<cadence>:<period>`, so a re-run, a retry or a
 * second worker finds the key and files nothing twice. A report the owner
 * deleted stays deleted: the vault remembers the key.
 *
 * Every boundary is a local midnight in the record's timezone, built from
 * day keys rather than from 24-hour steps, so a month with a clock change
 * still starts and ends at midnight and counts its real number of days.
 */
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

import type {
  ReportSchedule,
  ReportScheduleCadence,
  ReportScheduleOutcome,
  ReportScheduleWindow,
} from "./schedule-shape";

/** One closed period: its key and its local-day bounds. */
export interface ReportPeriod {
  cadence: ReportScheduleCadence;
  /** `2026-10`, `2026-Q3` or `2025`. */
  key: string;
  /** First local day of the period, `YYYY-MM-DD`. */
  firstDay: string;
  /** Last local day of the period, `YYYY-MM-DD`. */
  lastDay: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The most recent period of `cadence` that has fully closed by `now` on the
 * record's clock. On the first day of a month the month before it is the
 * one that just closed; on any other day it is the same answer.
 */
export function latestClosedPeriod(
  cadence: ReportScheduleCadence,
  now: Date,
  tz: string,
): ReportPeriod {
  const today = userDayKey(now, tz);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  let first: string;
  let nextFirst: string;
  let key: string;
  if (cadence === "MONTHLY") {
    const y = month === 1 ? year - 1 : year;
    const m = month === 1 ? 12 : month - 1;
    first = `${y}-${pad2(m)}-01`;
    nextFirst = `${year}-${pad2(month)}-01`;
    key = `${y}-${pad2(m)}`;
  } else if (cadence === "QUARTERLY") {
    const current = Math.floor((month - 1) / 3); // 0..3
    const y = current === 0 ? year - 1 : year;
    const q = current === 0 ? 3 : current - 1;
    first = `${y}-${pad2(q * 3 + 1)}-01`;
    nextFirst = `${year}-${pad2(current * 3 + 1)}-01`;
    key = `${y}-Q${q + 1}`;
  } else {
    first = `${year - 1}-01-01`;
    nextFirst = `${year}-01-01`;
    key = String(year - 1);
  }
  return {
    cadence,
    key,
    firstDay: first,
    lastDay: shiftDateKey(nextFirst, -1),
  };
}

/** Days a window reaches back from the end of the period. */
const WINDOW_DAYS: Record<Exclude<ReportScheduleWindow, "PERIOD">, number> = {
  LAST_90_DAYS: 90,
  LAST_365_DAYS: 365,
};

/**
 * The instant bounds of the report for `period`: from local midnight of its
 * first day (or of the day the window reaches back to) to the last
 * millisecond before local midnight after its last day.
 */
export function reportRangeForPeriod(
  period: ReportPeriod,
  window: ReportScheduleWindow,
  tz: string,
): { start: Date; end: Date; firstDay: string } {
  const endExclusiveDay = shiftDateKey(period.lastDay, 1);
  const firstDay =
    window === "PERIOD"
      ? period.firstDay
      : shiftDateKey(endExclusiveDay, -WINDOW_DAYS[window]);
  const start = startOfLocalDayKey(firstDay, tz);
  const end = new Date(startOfLocalDayKey(endExclusiveDay, tz).getTime() - 1);
  return { start, end, firstDay };
}

/** The vault source id of a period's report: `<cadence>:<period>`. */
export function reportScheduleSourceId(period: ReportPeriod): string {
  return `${period.cadence}:${period.key}`;
}

/** The schedule after a run, with only the stamp fields changed. */
export function stampReportSchedule(
  schedule: ReportSchedule,
  period: ReportPeriod,
  outcome: ReportScheduleOutcome,
  now: Date,
): ReportSchedule {
  return {
    v: 1,
    cadence: schedule.cadence,
    window: schedule.window,
    lastPeriod: period.key,
    lastOutcome: outcome,
    lastRunAt: now.toISOString(),
  };
}

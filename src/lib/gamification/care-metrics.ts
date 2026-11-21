/**
 * v1.16.1 — care-routine metrics for the achievement route.
 *
 * Pure helpers over typed rows (no prisma import) so the unit tests can
 * drive synthetic data, mirroring `expansion-metrics.ts`. Two metrics
 * live here:
 *
 *   - `missFreeDayStreak` — consecutive Berlin-local days on which every
 *     resolved dose landed without an auto-miss. A day qualifies when it
 *     carries at least one RESOLVED slot (taken or deliberately skipped)
 *     and zero `autoMissed` rows; a day whose slots are all still
 *     pending is not counted yet (today, typically) but simply stays out
 *     of the series — the historical streak up to yesterday is what the
 *     badge measures. Deliberate skips do not break the run: the
 *     compliance engine treats them as a planned break, and "no missed
 *     dose" is about forgetting, not pausing. Calendar-gap semantics
 *     match the existing day-streak badges (a weekly-only cadence will
 *     not build this streak — same trade-off `onTimePerfectDayStreak`
 *     makes).
 *
 *   - `measurementConsistencyWeeks` — longest run of consecutive
 *     ISO-style (Monday-anchored) weeks each carrying at least
 *     `minDaysPerWeek` distinct active measurement days. Rewards the
 *     boring, clinically useful habit of measuring most days of the
 *     week, week after week, without demanding a perfect daily streak.
 */
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

export interface CareIntakeEventRecord {
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  autoMissed: boolean;
}

/**
 * Qualifying day keys for the miss-free streak, sorted ascending.
 * Feed the result to `calculateLongestStreak` /
 * `findStreakCompletionDate` like every other day series.
 *
 * `tz` defaults to `DEFAULT_TIMEZONE` ("Europe/Berlin") so every existing
 * caller/fixture that never set one keeps its prior behaviour byte-for-
 * byte (DATAINT M4) — the achievements builder now threads the badge
 * owner's real `User.timezone` in.
 */
export function getMissFreeDayKeys(
  events: CareIntakeEventRecord[],
  tz: string = DEFAULT_TIMEZONE,
): string[] {
  const byDay = new Map<string, { resolved: number; missed: number }>();
  for (const event of events) {
    const dayKey = userDayKey(event.scheduledFor, tz);
    const bucket = byDay.get(dayKey) ?? { resolved: 0, missed: 0 };
    // A recorded outcome answers the dose even if the auto-miss stamp is
    // still on the row; only an unanswered auto-missed dose is a miss.
    if (event.takenAt !== null || event.skipped) {
      bucket.resolved += 1;
    } else if (event.autoMissed) {
      bucket.missed += 1;
    }
    byDay.set(dayKey, bucket);
  }
  const qualifying: string[] = [];
  for (const [dayKey, bucket] of byDay) {
    if (bucket.missed === 0 && bucket.resolved > 0) {
      qualifying.push(dayKey);
    }
  }
  return qualifying.sort();
}

function dayKeyToSerial(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/**
 * Monday-anchored week index for a day serial. Serial 0 is 1970-01-01
 * (a Thursday); the Monday of that week sits at serial −3, so shifting
 * by +3 aligns the integer division to Monday boundaries.
 */
function weekSerialOf(daySerial: number): number {
  return Math.floor((daySerial + 3) / 7);
}

export interface WeeklyConsistencyResult {
  /** Longest run of consecutive qualifying weeks. */
  longestRunWeeks: number;
  /**
   * Day key on which the first run of `targetWeeks` consecutive
   * qualifying weeks was completed — the `minDaysPerWeek`-th active day
   * of that run's final week. `null` while no run has reached the
   * target. Drives the achievement's `completedAt`.
   */
  completionDayKey: string | null;
}

/**
 * Fold distinct active day keys into the weekly-consistency metric: a
 * week qualifies with ≥ `minDaysPerWeek` distinct active days; runs are
 * consecutive week serials.
 */
export function getWeeklyConsistency(
  dayKeys: string[],
  minDaysPerWeek: number,
  targetWeeks: number,
): WeeklyConsistencyResult {
  const uniqueDays = [...new Set(dayKeys)].sort();
  const daysByWeek = new Map<number, string[]>();
  for (const dayKey of uniqueDays) {
    const week = weekSerialOf(dayKeyToSerial(dayKey));
    const list = daysByWeek.get(week) ?? [];
    list.push(dayKey);
    daysByWeek.set(week, list);
  }

  const qualifyingWeeks = [...daysByWeek.entries()]
    .filter(([, days]) => days.length >= minDaysPerWeek)
    .map(([week]) => week)
    .sort((a, b) => a - b);

  let longestRunWeeks = 0;
  let completionDayKey: string | null = null;
  let run = 0;
  for (let i = 0; i < qualifyingWeeks.length; i++) {
    run =
      i > 0 && qualifyingWeeks[i] - qualifyingWeeks[i - 1] === 1 ? run + 1 : 1;
    longestRunWeeks = Math.max(longestRunWeeks, run);
    if (run === targetWeeks && completionDayKey === null) {
      // The run reached the target the moment this week qualified —
      // i.e. on its minDaysPerWeek-th active day.
      const weekDays = daysByWeek.get(qualifyingWeeks[i]) ?? [];
      completionDayKey = weekDays[minDaysPerWeek - 1] ?? null;
    }
  }

  return { longestRunWeeks, completionDayKey };
}

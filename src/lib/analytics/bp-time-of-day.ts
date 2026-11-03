/**
 * Blood pressure by part of the day (#1331).
 *
 * Home blood-pressure monitoring is read as a morning set and an evening set:
 * the ESH position paper on home monitoring (Parati et al., J Hypertens 2021;
 * 39:1742, Box 15) asks for "duplicate morning and evening measurements",
 * the morning one "before drug intake if treated", over 3 to 7 days, and the
 * AHA statement on blood-pressure measurement (Muntner et al., Hypertension
 * 2019;73:e35) likewise asks for a morning set before medication and an
 * evening set. Neither names clock hours, and national guidelines disagree on
 * the evening (before the evening meal, after it, or before bed): the parts
 * are defined by what the person does, not by the clock.
 *
 * The boundaries below are therefore wide windows that catch those readings
 * for ordinary schedules, cut at the hour in the person's own zone:
 *
 *   morning 04:00 to 11:59  waking and before the first dose, early risers
 *                           and late sleepers alike;
 *   midday  12:00 to 17:59  readings that are neither, kept apart so they do
 *                           not blur either set;
 *   evening 18:00 to 03:59  before supper through to a late bedtime: a reading
 *                           at 01:00 is the evening reading of a night owl,
 *                           never a morning one.
 *
 * So the day of a reading, for this view, starts at 04:00 local
 * ({@link BP_DAY_START_HOUR}); an evening reading taken after midnight belongs
 * to the evening before. The SQL fold behind the narrowed chart uses the same
 * hours and the same day start, so the averages and the narrowed chart cut
 * the readings at one place.
 *
 * The numbers are the person's own data side by side. Whether a difference
 * matters is for them and their clinician; nothing here grades it.
 */
import { wallClockInTz } from "@/lib/tz/wall-clock";

export const BP_PARTS_OF_DAY = ["morning", "midday", "evening"] as const;
export type BpPartOfDay = (typeof BP_PARTS_OF_DAY)[number];

/** `[startHour, endHour)` in local wall-clock hours; evening wraps midnight. */
export const BP_PART_HOURS: Readonly<
  Record<BpPartOfDay, { startHour: number; endHour: number }>
> = {
  morning: { startHour: 4, endHour: 12 },
  midday: { startHour: 12, endHour: 18 },
  evening: { startHour: 18, endHour: 4 },
};

/** The local hour a blood-pressure day starts at (the morning's first hour). */
export const BP_DAY_START_HOUR = BP_PART_HOURS.morning.startHour;

/**
 * Readings a part needs before its mean is shown. Three is the smallest
 * schedule the ESH paper accepts (three days); fewer is shown as a count
 * without a mean rather than as a number that one reading can swing.
 */
export const BP_PART_MIN_READINGS = 3;

/** The part a local wall-clock hour (0..23) falls in. */
export function bpPartOfDayForHour(hour: number): BpPartOfDay {
  for (const part of BP_PARTS_OF_DAY) {
    const { startHour, endHour } = BP_PART_HOURS[part];
    const inside =
      startHour < endHour
        ? hour >= startHour && hour < endHour
        : hour >= startHour || hour < endHour;
    if (inside) return part;
  }
  // Unreachable for 0..23: the three windows tile the day.
  throw new Error(`hour out of range: ${hour}`);
}

/** One paired reading: systolic and diastolic, with the pulse taken with it. */
export interface BpTimedReading {
  at: Date;
  systolic: number;
  diastolic: number;
  pulse: number | null;
}

export interface BpPartSummary {
  part: BpPartOfDay;
  startHour: number;
  endHour: number;
  /** Paired readings in this part over the window. */
  readingCount: number;
  /** Whole-mmHg means; `null` below {@link BP_PART_MIN_READINGS}. */
  systolic: number | null;
  diastolic: number | null;
  /** Readings in this part that carried a pulse. */
  pulseReadingCount: number;
  /** Whole-bpm mean; `null` below the same floor of pulse readings. */
  pulse: number | null;
}

export interface BpTimeOfDaySummary {
  timeZone: string;
  minReadings: number;
  /** Every paired reading in the window, across the three parts. */
  readingCount: number;
  parts: BpPartSummary[];
  /**
   * Morning minus evening, from the two shown means (so the figure on screen
   * is exactly the difference of the two figures beside it). `null` unless
   * both parts clear the floor.
   */
  morningEveningDifference: { systolic: number; diastolic: number } | null;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Bucket paired readings by the local hour they were taken at, in `timeZone`. */
export function computeBpTimeOfDay(
  readings: readonly BpTimedReading[],
  timeZone: string,
): BpTimeOfDaySummary {
  const byPart = new Map<BpPartOfDay, BpTimedReading[]>(
    BP_PARTS_OF_DAY.map((part) => [part, []]),
  );
  for (const reading of readings) {
    const { hour } = wallClockInTz(reading.at, timeZone);
    byPart.get(bpPartOfDayForHour(hour))!.push(reading);
  }

  const parts = BP_PARTS_OF_DAY.map<BpPartSummary>((part) => {
    const rows = byPart.get(part)!;
    const enough = rows.length >= BP_PART_MIN_READINGS;
    const pulses = rows
      .map((r) => r.pulse)
      .filter((p): p is number => p !== null);
    return {
      part,
      ...BP_PART_HOURS[part],
      readingCount: rows.length,
      systolic: enough ? Math.round(mean(rows.map((r) => r.systolic))) : null,
      diastolic: enough ? Math.round(mean(rows.map((r) => r.diastolic))) : null,
      pulseReadingCount: pulses.length,
      pulse:
        pulses.length >= BP_PART_MIN_READINGS ? Math.round(mean(pulses)) : null,
    };
  });

  const morning = parts.find((p) => p.part === "morning")!;
  const evening = parts.find((p) => p.part === "evening")!;
  const morningEveningDifference =
    morning.systolic !== null &&
    morning.diastolic !== null &&
    evening.systolic !== null &&
    evening.diastolic !== null
      ? {
          systolic: morning.systolic - evening.systolic,
          diastolic: morning.diastolic - evening.diastolic,
        }
      : null;

  return {
    timeZone,
    minReadings: BP_PART_MIN_READINGS,
    readingCount: readings.length,
    parts,
    morningEveningDifference,
  };
}

/**
 * The readings of one local day and the person's usual range beside each
 * (v1.42, #613).
 *
 * One entry per reading for the types a person takes by hand or a device
 * takes a few times a day (weight, blood pressure, glucose). A type that
 * arrives as a day total is one entry with the total; a type sampled all day
 * long (pulse, gait figures, a watch's background readings) is one entry with
 * the day value instead of hundreds of points. "All day long" is a fixed list
 * plus a count: more than {@link MAX_READINGS_PER_TYPE} canonical readings of
 * one type collapse to the day value too, so a CGM day does not send 288 rows.
 * The collapsed entry carries the time of the last reading it folds.
 *
 * The range is the record's own: median ± a scaled MAD over the daily values
 * of the 30 local days before, the same band the vitals baseline draws, with
 * at least {@link MIN_BAND_DAYS} days behind it. It describes, it does not
 * grade; nothing here says "high".
 */
import type { MeasurementType } from "@/generated/prisma/enums";

import type { DayValue } from "@/lib/day/contract";
import { readLocalDailyStats } from "@/lib/day/daily-stats";
import { buildBaselineBand } from "@/lib/insights/derived/baseline";
import { HIGH_FREQUENCY_MEAN_TYPES } from "@/lib/measurements/apple-health-mapping";
import { isCumulativeDaySumType } from "@/lib/measurements/cumulative-day-sum";
import { dayValue } from "@/lib/measurements/day-mean";
import { HOURLY_MEAN_DAY_TYPES } from "@/lib/measurements/day-statistic";
import type { DayReadingRow, DayReadings } from "@/lib/mood/linked-context";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import { shiftDateKey } from "@/lib/tz/format";

/** More canonical readings of one type than this fold to the day value. */
export const MAX_READINGS_PER_TYPE = 24;

/** Days of history the usual range needs before it is drawn. */
export const MIN_BAND_DAYS = 7;

/** Local days the usual range looks back over. */
export const BAND_WINDOW_DAYS = 30;

/** How a type's readings of one day become entries. */
export type DayValueShape = "readings" | "total" | "dayValue";

export function dayValueShape(
  type: MeasurementType,
  readingCount: number,
): DayValueShape {
  if (isCumulativeDaySumType(type)) return "total";
  if (HOURLY_MEAN_DAY_TYPES.has(type) || HIGH_FREQUENCY_MEAN_TYPES.has(type)) {
    return "dayValue";
  }
  return readingCount > MAX_READINGS_PER_TYPE ? "dayValue" : "readings";
}

/**
 * The day value of a type's readings, as `daily-stats.ts` computes it: a
 * day total for a cumulative type, the mean of the local hours' means for an
 * hourly-mean type (pulse, through `day-mean.ts`, the statistic every pulse
 * reader shares, so the dashboard's latest pulse and this day's pulse are the
 * same number), the plain mean otherwise.
 */
export function dayValueOf(
  type: MeasurementType,
  rows: readonly DayReadingRow[],
  tz: string,
): number {
  if (isCumulativeDaySumType(type)) {
    return rows.reduce((sum, r) => sum + r.value, 0);
  }
  return dayValue(type, rows, tz) ?? 0;
}

/** Round to a precision that keeps a reading readable and a mean honest. */
function tidy(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The entries for one day, with the band from `bands` where one exists.
 * Pure; `buildDayValues` below does the reads.
 */
export function shapeDayValues(
  readings: DayReadings,
  bands: ReadonlyMap<MeasurementType, DayValue["band"]>,
  includeSleep: boolean,
  /** The record's zone: a pulse day is the mean of its local hours. */
  tz: string,
): DayValue[] {
  const out: DayValue[] = [];
  for (const [type, rows] of readings.rowsByType) {
    if (rows.length === 0) continue;
    const band = bands.get(type) ?? null;
    const shape = dayValueShape(type, rows.length);
    const last = rows[rows.length - 1];
    if (shape === "readings") {
      for (const row of rows) {
        out.push({
          type,
          value: row.value,
          unit: row.unit,
          at: row.measuredAt.toISOString(),
          source: row.source,
          band,
        });
      }
    } else {
      out.push({
        type,
        value: tidy(dayValueOf(type, rows, tz)),
        unit: last.unit,
        at: last.measuredAt.toISOString(),
        source: last.source,
        band,
      });
    }
  }
  if (includeSleep && readings.night) {
    out.push({
      type: "SLEEP_DURATION",
      value: readings.night.asleepMinutes,
      unit: "min",
      at: readings.night.measuredAt.toISOString(),
      source: readings.nightSource ?? "MANUAL",
      band: null,
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The usual range of each type over the {@link BAND_WINDOW_DAYS} local days
 * before `day`. `floor` cuts the window for a reader that may not look back
 * further (the Coach's lookback limit).
 */
export async function readDayBands(args: {
  userId: string;
  day: string;
  tz: string;
  types: readonly MeasurementType[];
  priorityJson: unknown;
  floor: Date | null;
}): Promise<Map<MeasurementType, DayValue["band"]>> {
  const out = new Map<MeasurementType, DayValue["band"]>();
  if (args.types.length === 0) return out;
  const to = startOfLocalDayKey(args.day, args.tz);
  let from = startOfLocalDayKey(
    shiftDateKey(args.day, -BAND_WINDOW_DAYS),
    args.tz,
  );
  if (args.floor && args.floor > from) from = args.floor;
  const stats = await readLocalDailyStats({
    userId: args.userId,
    types: args.types,
    from,
    to,
    tz: args.tz,
    priorityJson: args.priorityJson,
  });
  for (const type of args.types) {
    const days = stats.get(type);
    if (!days || days.size < MIN_BAND_DAYS) continue;
    const band = buildBaselineBand([...days.values()], type);
    if (!band) continue;
    out.set(type, {
      lo: tidy(band.low),
      hi: tidy(band.high),
      n: band.sampleDays,
    });
  }
  return out;
}

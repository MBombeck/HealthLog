/**
 * Which statistic a type's DAY value is, and how days combine into a window.
 *
 * A watch samples heart rate about every 5 to 10 minutes at rest and about
 * every 5 seconds in a workout. A plain mean over a day's rows therefore counts
 * the workout hour hundreds of times and the other twenty-three hours a few
 * dozen times each, so a workout day reads far above the rest of the day.
 *
 * For such a type the DAY value is the mean of its per-hour means, each hour
 * weighing one. That is deterministic, needs no extra column, and matches what
 * an hourly bucket already is. A window of days then weighs each day once too
 * (the mean of the daily means), because weighting days by their sample count
 * would bring the same bias back one level up.
 *
 * Pulse only. A CGM samples glucose at a fixed rate, so glucose has no
 * activity bias; HRV and SpO2 can follow when the effect is shown on real data.
 */
import type { MeasurementType } from "@/generated/prisma/client";

export const HOURLY_MEAN_DAY_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>(["PULSE"]);

export function usesHourlyMeanDay(type: string): boolean {
  return HOURLY_MEAN_DAY_TYPES.has(type as MeasurementType);
}

/** How the days of a window combine: by sample count, or one weight per day. */
export type WindowWeighting = "count" | "day";

export function windowWeighting(type: string): WindowWeighting {
  return usesHourlyMeanDay(type) ? "day" : "count";
}

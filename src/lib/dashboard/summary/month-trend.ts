/**
 * #176 — the dashboard tile's trend, from the metric page's own comparison.
 *
 * The tile used to read its arrow first-to-last off the last seven daily
 * buckets, while the metric page compares this month's mean with last
 * month's (`GET /api/analytics/range`, range `30d`). On the same visit the
 * two could point opposite ways. Each measured card now takes its trend from
 * that same comparison through the same function (`computeRangeDelta` and
 * `rangeTrend`), and says so in `trendWindowDays`. A card with no previous
 * month to compare keeps the sparkline's direction, with `trendWindowDays`
 * null, and so do mood and BMI, which the range read does not serve.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { computeRangeDelta } from "@/lib/analytics/range-delta";

import type { MetricCard, MetricKind } from "./cards";

/** The comparison the metric page offers as "vs last month". */
const MONTH_RANGE = "30d" as const;
const MONTH_DAYS = 30;

/** The measurement type behind each card the range read serves. */
const MEASURED_TYPE: Partial<Record<MetricKind, MeasurementType>> = {
  weight: "WEIGHT",
  bloodPressure: "BLOOD_PRESSURE_SYS",
  pulse: "PULSE",
  bodyFat: "BODY_FAT",
  glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  totalBodyWater: "TOTAL_BODY_WATER",
  boneMass: "BONE_MASS",
  oxygenSaturation: "OXYGEN_SATURATION",
};

export async function withMonthTrends(
  userId: string,
  cards: MetricCard[],
  known: { timezone: string; priorityJson: unknown },
  now: Date,
): Promise<MetricCard[]> {
  return Promise.all(
    cards.map(async (card) => {
      const type = MEASURED_TYPE[card.kind];
      if (!type) return card;
      const result = await computeRangeDelta(
        userId,
        type,
        MONTH_RANGE,
        now.getTime(),
        known,
      );
      return result.trend === "unknown"
        ? card
        : { ...card, trend: result.trend, trendWindowDays: MONTH_DAYS };
    }),
  );
}

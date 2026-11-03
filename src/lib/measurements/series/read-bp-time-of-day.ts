/**
 * The readings behind the blood-pressure time-of-day summary (#1331).
 *
 * The pairs are the blood-pressure series' own (`readBloodPressureSeries`):
 * the ladder's one source per day, each systolic with the diastolic of the
 * same source within five minutes. A systolic without its diastolic is half a
 * reading and stays out. The pulse is the reading's own: the closest PULSE row
 * of the same source within the same five minutes, so a cuff's pulse is taken
 * and a watch's stream of heart-rate rows from another source is not.
 */
import { prisma } from "@/lib/db";
import {
  openEndedFetchWindow,
  localDayKeyFor,
} from "@/lib/charts/fetch-window";
import {
  computeBpTimeOfDay,
  type BpTimeOfDaySummary,
  type BpTimedReading,
} from "@/lib/analytics/bp-time-of-day";
import { VALUE_RANGES } from "@/lib/measurements/value-ranges";

import { readBloodPressureSeries } from "./read-blood-pressure";

export interface BpTimeOfDayRead extends BpTimeOfDaySummary {
  days: number;
  from: string;
  to: string;
}

/**
 * The summary over the last `days` local days, ending with today in
 * `timeZone`: the same window the chart draws for that range tab.
 */
export async function readBpTimeOfDay(opts: {
  userId: string;
  days: number;
  timeZone: string;
  now?: Date;
}): Promise<BpTimeOfDayRead> {
  const { userId, days, timeZone } = opts;
  const now = opts.now ?? new Date();
  const window = openEndedFetchWindow(
    days,
    localDayKeyFor(now, timeZone),
    timeZone,
  );
  const from = new Date(window.from);
  const to = new Date(window.to);

  const { points } = await readBloodPressureSeries(userId, from);
  const paired = points.filter(
    (p) => p.secondary !== null && new Date(p.at).getTime() <= to.getTime(),
  );
  const pulseById = await readPulseForReadings(
    userId,
    paired.map((p) => p.id),
  );
  const readings: BpTimedReading[] = paired.map((p) => ({
    at: new Date(p.at),
    systolic: p.value,
    diastolic: p.secondary as number,
    pulse: pulseById.get(p.id) ?? null,
  }));

  return {
    days,
    from: window.from,
    to: window.to,
    ...computeBpTimeOfDay(readings, timeZone),
  };
}

const PULSE_WINDOW_MINUTES = 5;

/** The pulse taken with each systolic row, keyed by the systolic row's id. */
async function readPulseForReadings(
  userId: string,
  systolicIds: string[],
): Promise<Map<string, number>> {
  if (systolicIds.length === 0) return new Map();
  // `measured_at` is a naive UTC timestamp on both sides, so the interval
  // arithmetic is zone-free. One indexed lookup per reading; BP is a few
  // readings a day even on a long history.
  const rows = await prisma.$queryRaw<Array<{ id: string; pulse: number }>>`
    SELECT s."id", p."value"::double precision AS pulse
    FROM measurements s
    CROSS JOIN LATERAL (
      SELECT q."value"
      FROM measurements q
      WHERE q."user_id" = s."user_id"
        AND q."type" = 'PULSE'::measurement_type
        AND q."source" = s."source"
        AND q."deleted_at" IS NULL
        AND q."value" >= ${VALUE_RANGES.PULSE.min}
        AND q."value" <= ${VALUE_RANGES.PULSE.max}
        AND q."measured_at" BETWEEN s."measured_at" - make_interval(mins => ${PULSE_WINDOW_MINUTES}::int)
                                AND s."measured_at" + make_interval(mins => ${PULSE_WINDOW_MINUTES}::int)
      ORDER BY abs(extract(epoch FROM (q."measured_at" - s."measured_at"))), q."id"
      LIMIT 1
    ) p
    WHERE s."user_id" = ${userId}
      AND s."id" = ANY(${systolicIds}::text[])
  `;
  return new Map(rows.map((r) => [r.id, Number(r.pulse)]));
}

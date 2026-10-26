/**
 * The bucketed series of a sample-dense kind: day buckets past the raw
 * window, hour buckets for a stream too dense to send raw inside it, with
 * the stat strip aggregated over every raw reading in SQL.
 */
import { prisma } from "@/lib/db";
import { readDenseSeries } from "@/lib/measurements/dense-series-read";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { seriesRowsFrom } from "@/lib/measurements/series-canonical";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";

import {
  DENSE_SERIES_KINDS,
  DENSE_SERIES_RAW_ROW_CAP,
  DENSE_SERIES_RAW_WINDOW_DAYS,
  KIND_TO_TYPE,
  type SeriesKind,
  type SeriesPoint,
  type SeriesRead,
  type SeriesStats,
} from "./kinds";

/** Whether this request takes the bucketed read. */
export async function takesBucketedRead(
  userId: string,
  kind: SeriesKind,
  days: number,
  since: Date,
): Promise<boolean> {
  return (
    (DENSE_SERIES_KINDS.has(kind) && days > DENSE_SERIES_RAW_WINDOW_DAYS) ||
    (DENSE_SERIES_KINDS.has(kind) &&
      (await prisma.measurement.count({
        where: {
          userId,
          type: KIND_TO_TYPE[kind],
          measuredAt: { gte: since },
          deletedAt: null,
        },
      })) > DENSE_SERIES_RAW_ROW_CAP)
  );
}

export async function readBucketedSeries(
  userId: string,
  kind: SeriesKind,
  days: number,
  since: Date,
): Promise<SeriesRead> {
  let points: SeriesPoint[] = [];
  let unit: string | undefined;
  let statsOverride: SeriesStats | null = null;
  // Day buckets past the raw window; hour buckets for a dense-kind
  // stream too dense to send raw inside it.
  const grain = days > DENSE_SERIES_RAW_WINDOW_DAYS ? "day" : "hour";
  // Long-window read of a sample-dense kind (CGM glucose,
  // per-sample / hourly pulse). Day-bucket in SQL instead of walking
  // every raw row into JS: one aggregate pass in Postgres returns at
  // most `days` rows regardless of sample density. Bound parameters
  // mirror the rollup tier's `date_trunc(... ) GROUP BY` aggregate
  // (measurement-rollups.ts), and the rows are the ladder-winning source per
  // day, the same rule the rollup tier and sleep apply.
  const [userTz, priorityJson] = await Promise.all([
    resolveUserTimezone(userId),
    loadUserSourcePriority(userId),
  ]);
  const type = KIND_TO_TYPE[kind];
  const seriesRows = seriesRowsFrom(priorityJson, type, since);
  // A day of a type with an activity-dependent sampling rate (pulse) is the
  // weighted mean of its local hours' means, so a workout hour with hundreds
  // of times the readings does not outweigh the rest of the day (see
  // `day-statistic.ts`). The hour grain is already one mean per hour.
  const { bucketRows, rawAgg } = await readDenseSeries({
    userId: userId,
    type,
    grain,
    userTz,
    since,
    seriesRows,
  });
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const dayId = (d: Date) =>
    grain === "day"
      ? `day:${userDayKey(d, userTz)}`
      : `hour:${d.toISOString()}`;
  if (kind === "glucose") {
    // Same unit engine as the raw glucose branch: canonical mg/dL in
    // the DB, converted ONCE at serialization to the user's preference.
    const profile = await prisma.user.findUnique({
      where: { id: userId },
      select: { glucoseUnit: true },
    });
    const glucoseUnit = resolveGlucoseUnit(profile?.glucoseUnit ?? null);
    unit = glucoseUnit;
    points = bucketRows.map((r) => ({
      id: dayId(r.bucket_start),
      at: r.bucket_start.toISOString(),
      value: convertGlucose(r.mean, glucoseUnit),
      secondary: null,
    }));
    if (
      rawAgg !== undefined &&
      rawAgg.n > 0 &&
      rawAgg.mean !== null &&
      rawAgg.min !== null &&
      rawAgg.max !== null
    ) {
      // Mirrors the raw branch's v1.16.16 parity: round the mg/dL
      // aggregate to 2 decimals (summarize()'s convention), then
      // convert each figure once.
      statsOverride = {
        mean: convertGlucose(round2(rawAgg.mean), glucoseUnit),
        min: convertGlucose(rawAgg.min, glucoseUnit),
        max: convertGlucose(rawAgg.max, glucoseUnit),
        stdDev: convertGlucose(round2(rawAgg.sd ?? 0), glucoseUnit),
        count: rawAgg.n,
      };
    }
  } else {
    // `value` is the bucket's average. For pulse, valueMin/valueMax carry
    // the bucket's low/high band (folding each hourly import bucket's own
    // spread via the COALESCE above), same band semantics as the per-hour
    // shape. The other dense kinds keep the bare point shape their raw rows
    // have, so a client reads a bucket the way it reads a reading.
    points = bucketRows.map((r) => ({
      id: dayId(r.bucket_start),
      at: r.bucket_start.toISOString(),
      value: round2(r.mean),
      secondary: null,
      ...(kind === "pulse"
        ? { valueMin: r.min_value, valueMax: r.max_value }
        : {}),
    }));
    if (
      rawAgg !== undefined &&
      rawAgg.n > 0 &&
      rawAgg.mean !== null &&
      rawAgg.min !== null &&
      rawAgg.max !== null
    ) {
      statsOverride = {
        mean: round2(rawAgg.mean),
        min: rawAgg.min,
        max: rawAgg.max,
        stdDev: round2(rawAgg.sd ?? 0),
        count: rawAgg.n,
      };
    }
  }
  return { points, unit, statsOverride };
}

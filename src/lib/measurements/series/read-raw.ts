/**
 * The raw series: the ladder-winning source per day, row by row, with the
 * glucose unit and the hourly-mean stat strip applied where they belong.
 */
import { prisma } from "@/lib/db";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import { readingsMean } from "@/lib/measurements/day-mean";
import { seriesRowsFrom } from "@/lib/measurements/series-canonical";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";

import {
  KIND_TO_TYPE,
  stdDev,
  type SeriesKind,
  type SeriesPoint,
  type SeriesRead,
  type SeriesStats,
} from "./kinds";

export async function readRawSeries(
  userId: string,
  kind: SeriesKind,
  days: number,
  since: Date,
): Promise<SeriesRead> {
  let points: SeriesPoint[] = [];
  let unit: string | undefined;
  let statsOverride: SeriesStats | null = null;
  const type = KIND_TO_TYPE[kind];
  // (iOS #34 extension) — pull the per-bucket spread for the
  // heart-rate kind so the chart can render a low/high band around the
  // hourly average. Only PULSE rows ever carry a non-null spread (the
  // hourly HR bucket); every other kind selects the bare value shape.
  const includeSpread = kind === "pulse";
  // The ladder-winning source per day (see `seriesRowsFrom`), so a second
  // provider neither blends into nor duplicates the series. Bounded as before:
  // every dense kind reaches this read only inside 90 days and under 10 000
  // rows (counted first), and the sparse kinds are a few readings a day.
  const sourcePriority = await loadUserSourcePriority(userId);
  const rawRows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      value: number;
      measured_at: Date;
      value_min: number | null;
      value_max: number | null;
    }>
  >(
    `
    SELECT m."id", m."value", m."measured_at", m."value_min", m."value_max"
    FROM ${seriesRowsFrom(sourcePriority, type, since)}
    WHERE m."measured_at" >= $2
    ORDER BY m."measured_at" ASC, m."id" ASC
  `,
    userId,
    since,
  );
  const rows = rawRows.map((r) => ({
    id: r.id,
    value: r.value,
    measuredAt: r.measured_at,
    ...(includeSpread ? { valueMin: r.value_min, valueMax: r.value_max } : {}),
  }));
  if (kind === "glucose") {
    // Glucose is stored canonical mg/dL; convert each point to
    // the user's display unit AT SERIALIZATION so the wire DTO is unit-
    // coherent with the CSV + FHIR exports (one number, one engine). The
    // top-level `unit` token follows. mg/dL-preference users are unchanged
    // (convertGlucose rounds the integer); mmol/L users see 1-decimal
    // values (100 → 5.5) and `unit: "mmol/L"`.
    const profile = await prisma.user.findUnique({
      where: { id: userId },
      select: { glucoseUnit: true },
    });
    const glucoseUnit = resolveGlucoseUnit(profile?.glucoseUnit ?? null);
    unit = glucoseUnit;
    points = rows.map((r) => ({
      id: r.id,
      at: r.measuredAt.toISOString(),
      value: convertGlucose(r.value, glucoseUnit),
      secondary: null,
    }));
    // Stat parity. The stat strip's mean/min/max/stdDev must
    // match the detail-page + FHIR convention: aggregate over RAW mg/dL,
    // then convert each resulting figure ONCE. Deriving the stats from the
    // already-converted+rounded points double-rounds the mean and stdDev
    // for mmol/L users, drifting the last decimal off the detail page.
    // Single-reading sets stay identical (100 → 5.5). Hand back stats here
    // so the shared block below leaves a populated `statsOverride` alone.
    const rawDataPoints: DataPoint[] = rows.map((r) => ({
      date: r.measuredAt,
      value: r.value,
    }));
    if (rawDataPoints.length > 0) {
      const rawSummary = summarize(rawDataPoints);
      const rawValues = rawDataPoints.map((p) => p.value);
      statsOverride = {
        mean:
          rawSummary.mean === null
            ? 0
            : convertGlucose(rawSummary.mean, glucoseUnit),
        min:
          rawSummary.min === null
            ? 0
            : convertGlucose(rawSummary.min, glucoseUnit),
        max:
          rawSummary.max === null
            ? 0
            : convertGlucose(rawSummary.max, glucoseUnit),
        // Glucose mg/dL↔mmol/L is purely multiplicative (no offset), so a
        // spread converts with the same factor as a level.
        stdDev: convertGlucose(stdDev(rawValues), glucoseUnit),
        count: rawSummary.count,
      };
    }
  } else if (includeSpread) {
    // (iOS #34 extension) — pulse points carry the per-bucket
    // spread. A per-sample PULSE row has null min/max; an hourly HR bucket
    // carries the hour's range around the average.
    points = rows.map((r) => {
      const row = r as typeof r & {
        valueMin: number | null;
        valueMax: number | null;
      };
      return {
        id: row.id,
        at: row.measuredAt.toISOString(),
        value: row.value,
        secondary: null,
        valueMin: row.valueMin ?? null,
        valueMax: row.valueMax ?? null,
      };
    });
    // An hourly-mean type's strip mean is the mean of its local days'
    // values, each day the mean of its local hours' means, so a dense
    // workout hour does not outweigh the rest of the window. Count, min,
    // max and the spread stay over every reading.
    if (usesHourlyMeanDay(type) && rows.length > 0) {
      const userTz = await resolveUserTimezone(userId);
      const values = rows.map((r) => r.value);
      const rawSummary = summarize(
        rows.map((r) => ({ date: r.measuredAt, value: r.value })),
      );
      const mean = readingsMean(type, rows, userTz);
      statsOverride = {
        mean: mean === null ? 0 : Math.round(mean * 100) / 100,
        min: rawSummary.min ?? 0,
        max: rawSummary.max ?? 0,
        stdDev: stdDev(values),
        count: rawSummary.count,
      };
    }
  } else {
    points = rows.map((r) => ({
      id: r.id,
      at: r.measuredAt.toISOString(),
      value: r.value,
      secondary: null,
    }));
  }
  return { points, unit, statsOverride };
}

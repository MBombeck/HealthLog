/**
 * `GET /api/measurements/series` after its query has been validated: pick the
 * reader the kind and window call for, then add the judgements a client would
 * otherwise make itself — the change direction, the change over the window,
 * the reference lines — and the stat strip.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { resolveGlucoseUnit } from "@/lib/glucose";
import { resolveTrendVerdict } from "@/lib/targets/trend-verdict";
import {
  computeSeriesChange,
  seriesDayValues,
  seriesReferenceValue,
} from "@/lib/measurements/series-change";
import { resolveSeriesReferenceLines } from "@/lib/measurements/series-reference-lines";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveJobLocale } from "@/lib/i18n/job-locale";

import {
  KIND_TO_TYPE,
  SERIES_UNIT,
  stdDev,
  type SeriesKind,
  type SeriesRead,
} from "./kinds";
import { readBloodPressureSeries } from "./read-blood-pressure";
import { readBucketedSeries, takesBucketedRead } from "./read-bucketed";
import { readRawSeries } from "./read-raw";
import { readSleepSeries } from "./read-sleep";

/** The reader this kind and window call for, in the route's old order. */
async function readPoints(
  userId: string,
  kind: SeriesKind,
  days: number,
  since: Date,
): Promise<SeriesRead> {
  if (kind === "sleep") return readSleepSeries(userId, since, days);
  if (kind === "bloodPressure") return readBloodPressureSeries(userId, since);
  if (await takesBucketedRead(userId, kind, days, since)) {
    return readBucketedSeries(userId, kind, days, since);
  }
  return readRawSeries(userId, kind, days, since);
}

export async function readSeries(args: {
  /** The record read (the owner under a delegation). */
  userId: string;
  /** Who is reading: the labels are in their language. */
  actorId: string;
  kind: SeriesKind;
  days: number;
}) {
  const { userId, actorId, kind, days } = args;
  const since = new Date(Date.now() - days * 86_400_000);

  const read = await readPoints(userId, kind, days, since);
  // An explicit unit token so the client never infers the unit from the
  // kind. Sleep is served in hours and glucose in the user's unit; every
  // other kind carries its canonical stored unit.
  const unit = read.unit ?? SERIES_UNIT[kind];
  const points = read.points;
  const statsOverride = read.statsOverride ?? null;

  const dataPoints: DataPoint[] = points.map((p) => ({
    date: new Date(p.at),
    value: p.value,
  }));
  const summary = dataPoints.length > 0 ? summarize(dataPoints) : null;
  const values = dataPoints.map((p) => p.value);

  // The resolved judgements. The profile and targets are the
  // RECORD's (the chart is theirs); the labels are in the language of the
  // account reading it.
  const [record, reader, seriesTz] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        dateOfBirth: true,
        gender: true,
        heightCm: true,
        thresholdsJson: true,
        glucoseUnit: true,
        locale: true,
      },
    }),
    actorId === userId
      ? null
      : prisma.user.findUnique({
          where: { id: actorId },
          select: { locale: true },
        }),
    resolveUserTimezone(userId),
  ]);
  const rangeProfile = {
    dateOfBirth: record?.dateOfBirth ?? null,
    gender: record?.gender ?? null,
    heightCm: record?.heightCm ?? null,
  };
  const verdictType = KIND_TO_TYPE[kind];
  const dayValues = seriesDayValues(verdictType, points, seriesTz);
  const reference = seriesReferenceValue(dayValues);
  const direction = resolveTrendVerdict(verdictType, {
    profile: rangeProfile,
    thresholdsJson: record?.thresholdsJson ?? null,
    // The verdict reads stored units: sleep is served in hours here and
    // stored in minutes. Glucose has no band of its own on this chart.
    referenceValue:
      reference !== null && kind === "sleep" ? reference * 60 : reference,
  });
  const translator = getServerTranslator(
    await resolveJobLocale((reader ?? record)?.locale ?? null),
  );
  const referenceLines = resolveSeriesReferenceLines(kind, {
    profile: rangeProfile,
    thresholdsJson: record?.thresholdsJson ?? null,
    glucoseUnit: resolveGlucoseUnit(record?.glucoseUnit ?? null),
    t: (key) => translator.t(key),
  });

  annotate({
    action: { name: "measurements.series" },
    meta: { kind, days, count: points.length },
  });

  return {
    kind,
    unit,
    points,
    direction,
    change: computeSeriesChange(dayValues, direction),
    referenceLines,
    stats:
      statsOverride ??
      (summary
        ? {
            mean: summary.mean,
            min: summary.min,
            max: summary.max,
            stdDev: stdDev(values),
            count: summary.count,
          }
        : { mean: 0, min: 0, max: 0, stdDev: 0, count: 0 }),
  };
}

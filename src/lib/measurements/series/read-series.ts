/**
 * `GET /api/measurements/series` after its query has been validated: pick the
 * reader the kind and window call for, then add the judgements a client would
 * otherwise make itself — the change direction, the change over the window,
 * the reference lines — and the stat strip.
 */
import { pregnancyContextActive } from "@/lib/cycle/pregnancy-context";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { resolveGlucoseUnit } from "@/lib/glucose";
import {
  resolveTrendVerdict,
  verdictReadsPregnancy,
} from "@/lib/targets/trend-verdict";
import {
  computeSeriesChange,
  seriesDayValues,
  seriesReferenceValue,
} from "@/lib/measurements/series-change";
import { resolveSeriesReferenceLines } from "@/lib/measurements/series-reference-lines";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";

import { countLiveReadingsPerType } from "@/lib/measurements/newest-per-type";

import {
  DENSE_SERIES_KINDS,
  DENSE_SERIES_RAW_ROW_CAP,
  DENSE_SERIES_RAW_WINDOW_DAYS,
  KIND_TO_TYPE,
  SERIES_UNIT,
  stdDev,
  type SeriesKind,
  type SeriesRead,
  type SeriesShared,
} from "./kinds";
import { readBloodPressureSeries } from "./read-blood-pressure";
import { readBucketedSeries, takesBucketedRead } from "./read-bucketed";
import { readGlucoseKetoneIndexSeries } from "./read-glucose-ketone-index";
import { readRawSeries } from "./read-raw";
import { readSleepSeries } from "./read-sleep";

/** The reader this kind and window call for, in the route's old order. */
async function readPoints(
  userId: string,
  kind: SeriesKind,
  days: number,
  since: Date,
  shared: SeriesShared,
  counted: ReadonlyMap<string, number>,
): Promise<SeriesRead> {
  if (kind === "sleep") return readSleepSeries(userId, since, days, shared);
  if (kind === "bloodPressure") {
    return readBloodPressureSeries(userId, since, shared);
  }
  if (kind === "glucoseKetoneIndex") {
    return readGlucoseKetoneIndexSeries(userId, since);
  }
  if (takesBucketedRead(kind, days, counted)) {
    return readBucketedSeries(userId, kind, days, since, shared);
  }
  return readRawSeries(userId, kind, days, since, shared);
}

/** At most this many kinds in one request (`?kinds=`). */
export const SERIES_KINDS_MAX = 8;

export type SeriesAnswer = Awaited<ReturnType<typeof readSeriesBatch>>[number];

/**
 * Several series over one window, in the order asked. The account lookups
 * (profile, ladder, zone, glucose unit, language) are read once, the
 * dense-window probe counts every dense kind in one statement, and the
 * per-kind reads run side by side, so a chart screen costs one request and
 * not one per kind.
 */
export async function readSeriesBatch(args: {
  /** The record read (the owner under a delegation). */
  userId: string;
  /**
   * The reader's language, resolved from the request by the route
   * (`resolveServerLocale`): the labels are in it.
   */
  locale: Locale;
  kinds: readonly SeriesKind[];
  days: number;
}) {
  const { userId, locale, kinds, days } = args;
  const since = new Date(Date.now() - days * 86_400_000);

  // Inside the raw window a dense kind is bucketed only past the row cap;
  // beyond it, always, so only the first case needs the count.
  const probeTypes =
    days > DENSE_SERIES_RAW_WINDOW_DAYS
      ? []
      : kinds
          .filter((k) => DENSE_SERIES_KINDS.has(k))
          .map((k) => KIND_TO_TYPE[k]);

  // The profile and targets are the RECORD's (the chart is theirs); the
  // labels are in the language of the request reading it.
  const [record, seriesTz, counted] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        dateOfBirth: true,
        gender: true,
        heightCm: true,
        thresholdsJson: true,
        timezone: true,
        glucoseUnit: true,
        sourcePriorityJson: true,
      },
    }),
    resolveUserTimezone(userId),
    probeTypes.length > 0
      ? countLiveReadingsPerType(
          userId,
          probeTypes,
          // Counted one past the cap and no further: the question is
          // whether the window holds more than the cap.
          DENSE_SERIES_RAW_ROW_CAP + 1,
          since,
        )
      : new Map<string, number>(),
  ]);
  const shared: SeriesShared = {
    priorityJson: record?.sourcePriorityJson ?? null,
    tz: seriesTz,
    glucoseUnit: record?.glucoseUnit ?? null,
  };

  const [reads, pregnancy] = await Promise.all([
    Promise.all(
      kinds.map((kind) =>
        readPoints(userId, kind, days, since, shared, counted),
      ),
    ),
    // Only a weight verdict reads the state (`verdictReadsPregnancy`).
    kinds.some((kind) => verdictReadsPregnancy(KIND_TO_TYPE[kind]))
      ? pregnancyContextActive(prisma, userId, seriesTz)
      : false,
  ]);
  const translator = getServerTranslator(locale);
  const rangeProfile = {
    dateOfBirth: record?.dateOfBirth ?? null,
    gender: record?.gender ?? null,
    heightCm: record?.heightCm ?? null,
    timezone: seriesTz,
  };

  return kinds.map((kind, i) => {
    const read = reads[i];
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

    const verdictType = KIND_TO_TYPE[kind];
    const dayValues = seriesDayValues(verdictType, points, seriesTz);
    const reference = seriesReferenceValue(dayValues);
    const direction = resolveTrendVerdict(verdictType, {
      pregnancy: verdictReadsPregnancy(verdictType) && pregnancy,
      profile: rangeProfile,
      thresholdsJson: record?.thresholdsJson ?? null,
      // The verdict reads stored units: sleep is served in hours here and
      // stored in minutes. Glucose has no band of its own on this chart.
      referenceValue:
        reference !== null && kind === "sleep" ? reference * 60 : reference,
    });
    const referenceLines = resolveSeriesReferenceLines(kind, {
      profile: rangeProfile,
      thresholdsJson: record?.thresholdsJson ?? null,
      glucoseUnit: resolveGlucoseUnit(record?.glucoseUnit ?? null),
      t: (key) => translator.t(key),
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
  });
}

/** One series: the batch of one, annotated as the single read always was. */
export async function readSeries(args: {
  userId: string;
  locale: Locale;
  kind: SeriesKind;
  days: number;
}): Promise<SeriesAnswer> {
  const { kind, days } = args;
  const [answer] = await readSeriesBatch({ ...args, kinds: [kind] });
  annotate({
    action: { name: "measurements.series" },
    meta: { kind, days, count: answer.points.length },
  });
  return answer;
}

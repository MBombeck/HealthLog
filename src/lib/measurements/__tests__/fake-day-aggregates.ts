/**
 * In-memory stand-in for `readDayAggregates`, for unit tests that mock
 * `@/lib/db`.
 *
 * It reads the rows through the mocked `prisma.measurement.findMany` (so a
 * test's existing row fixture keeps feeding the reader) and folds them with
 * the same day / segment / range rules the SQL applies. The integration test
 * `tests/integration/dense-read-bounded.test.ts` pins that this fold and the
 * SQL agree on real Postgres.
 */
import { prisma } from "@/lib/db";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import type {
  DayAggregateRow,
  ReadDayAggregatesOptions,
  SourceDayAggregateRow,
} from "@/lib/measurements/day-aggregates";
import { userDayKey } from "@/lib/tz/format";
import { dayValue } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";

export function foldDayAggregates(
  rows: ReadonlyArray<{ measuredAt: Date; value: number }>,
  opts: Omit<ReadDayAggregatesOptions, "userId" | "type">,
): DayAggregateRow[] {
  const starts = opts.segmentStarts ?? [];
  const byKey = new Map<string, DayAggregateRow>();
  for (const r of rows) {
    const t = r.measuredAt.getTime();
    if (t < opts.since.getTime()) continue;
    if (opts.until && t > opts.until.getTime()) continue;
    if (
      opts.valueRange &&
      (r.value < opts.valueRange.min || r.value > opts.valueRange.max)
    ) {
      continue;
    }
    const day = userDayKey(r.measuredAt, opts.timeZone);
    const segment = starts.filter((s) => t < s.getTime()).length;
    const key = `${day}|${segment}`;
    const acc = byKey.get(key);
    if (acc) {
      acc.n += 1;
      acc.sum += r.value;
      if (r.value < acc.min) acc.min = r.value;
      if (r.value > acc.max) acc.max = r.value;
    } else {
      byKey.set(key, {
        day,
        segment,
        n: 1,
        sum: r.value,
        min: r.value,
        max: r.value,
      });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : b.segment - a.segment,
  );
}

export async function fakeReadDayAggregates(
  opts: ReadDayAggregatesOptions,
): Promise<DayAggregateRow[]> {
  const rows = ((await prisma.measurement.findMany({
    where: {
      userId: opts.userId,
      type: opts.type,
      deletedAt: null,
      measuredAt: { gte: opts.since, ...(opts.until && { lte: opts.until }) },
    },
    orderBy: { measuredAt: "asc" },
    select: { measuredAt: true, value: true },
  })) ?? []) as Array<{ measuredAt: Date; value: number }>;
  const days = foldDayAggregates(rows, opts);
  if (!usesHourlyMeanDay(opts.type)) return days;
  // Mirror the SQL's hourly-mean day: the mean of the (day, segment)'s local
  // hours' means.
  const starts = opts.segmentStarts ?? [];
  // Group once by (day, segment) with the fold's own filters, so a long
  // series stays linear instead of re-filtering every row per day.
  const membersByKey = new Map<
    string,
    Array<{ measuredAt: Date; value: number }>
  >();
  for (const r of rows) {
    const t = r.measuredAt.getTime();
    if (t < opts.since.getTime()) continue;
    if (opts.until && t > opts.until.getTime()) continue;
    if (
      opts.valueRange &&
      (r.value < opts.valueRange.min || r.value > opts.valueRange.max)
    ) {
      continue;
    }
    const key = `${userDayKey(r.measuredAt, opts.timeZone)}|${
      starts.filter((st) => t < st.getTime()).length
    }`;
    const list = membersByKey.get(key);
    if (list) list.push(r);
    else membersByKey.set(key, [r]);
  }
  return days.map((d) => {
    const members = membersByKey.get(`${d.day}|${d.segment}`) ?? [];
    const dayMean = dayValue(opts.type, members, opts.timeZone);
    return dayMean === null ? d : { ...d, dayMean };
  });
}

/**
 * In-memory stand-in for `readSourceDayAggregates`: reads the mocked
 * `measurement.findMany` rows and groups them per type, day, source and
 * device with the SQL's rules.
 */
export async function fakeReadSourceDayAggregates(opts: {
  userId: string;
  types: readonly MeasurementType[];
  since: Date;
  timeZone: string;
}): Promise<SourceDayAggregateRow[]> {
  const rows = ((await prisma.measurement.findMany({
    where: {
      userId: opts.userId,
      deletedAt: null,
      type: { in: [...opts.types] },
      measuredAt: { gte: opts.since },
    },
    orderBy: { measuredAt: "asc" },
  })) ?? []) as Array<{
    type: MeasurementType;
    value: number;
    measuredAt: Date;
    source?: MeasurementSource | null;
    deviceType?: string | null;
  }>;
  const groups = new Map<string, SourceDayAggregateRow>();
  for (const r of rows) {
    if (r.measuredAt.getTime() < opts.since.getTime()) continue;
    if (!opts.types.includes(r.type)) continue;
    const day = userDayKey(r.measuredAt, opts.timeZone);
    const source = (r.source ?? "MANUAL") as MeasurementSource;
    const deviceType = r.deviceType ?? null;
    const key = `${r.type}|${day}|${source}|${deviceType}`;
    const g = groups.get(key);
    if (g) {
      g.n += 1;
      g.sum += r.value;
      if (r.measuredAt < g.firstAt) g.firstAt = r.measuredAt;
    } else {
      groups.set(key, {
        type: r.type,
        day,
        source,
        deviceType,
        n: 1,
        sum: r.value,
        firstAt: r.measuredAt,
      });
    }
  }
  return [...groups.values()];
}

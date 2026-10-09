/**
 * `loadTimeline`: the record over the years (v1.42, #613).
 *
 * The lanes read the whole history of their tables (they are small: a few
 * hundred spans and points even on a long record), then the window decides
 * what is sent. The series and the notable days are the expensive part and
 * read only the window.
 *
 * Windows by zoom, when the request names none: `quarter` the last 91 days,
 * `year` the last 365, `all` from the earliest date the record carries. A
 * `range` always names its own (the query schema requires both ends). The
 * notable days of an `all` window are computed over its last three years at
 * most: an extreme is "the highest for at least three months", and older
 * history is what the comparison reads, not what it marks.
 */
import { MeasurementType as MeasurementTypes } from "@/generated/prisma/enums";
import type { MeasurementType } from "@/generated/prisma/enums";

import {
  DAY_NOTABLE_MAX_SPAN_DAYS,
  TIMELINE_LANE_KEYS,
  type TimelineBucket,
  type TimelineItem,
  type TimelineQuery,
  type TimelineResponse,
  type TimelineZoom,
} from "@/lib/day/contract";
import { loadNotableRange } from "@/lib/day/notable";
import { measurementTypeVisible } from "@/lib/day/sections";
import { prisma } from "@/lib/db";
import { listLiveMeasurementTypes } from "@/lib/measurements/live-types";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  LANE_READERS,
  laneVisible,
  type StandingItem,
  type TimelineAccess,
} from "@/lib/timeline/lanes";
import { loadTimelineSeries, MOOD_SERIES_KEY } from "@/lib/timeline/series";
import { daysBetweenDateKeys, shiftDateKey, userDayKey } from "@/lib/tz/format";
import { EVENT_MEASUREMENT_TYPES } from "@/lib/validations/measurement";

/** The series sent when the request names none. */
export const DEFAULT_TIMELINE_SERIES: readonly MeasurementType[] = [
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "WEIGHT",
];

/** An `all` window longer than this many days averages quarters. */
const QUARTER_BUCKET_MIN_DAYS = 2 * 365;

/**
 * The bucket for a chosen range, by its length: about the point count the
 * fixed zooms draw (a dozen to a few dozen), never one point per reading.
 * Two years and more average quarters (eight and up), four months and more
 * months (four to twenty-four), six weeks and more weeks (six to
 * seventeen), and anything shorter single days (at most six weeks of them).
 */
export const RANGE_BUCKET_MIN_DAYS: Readonly<
  Record<Exclude<TimelineBucket, "day">, number>
> = {
  quarter: 2 * 365,
  month: 120,
  week: 42,
};

export function rangeBucket(from: string, to: string): TimelineBucket {
  const days = daysBetweenDateKeys(from, to) + 1;
  if (days >= RANGE_BUCKET_MIN_DAYS.quarter) return "quarter";
  if (days >= RANGE_BUCKET_MIN_DAYS.month) return "month";
  if (days >= RANGE_BUCKET_MIN_DAYS.week) return "week";
  return "day";
}

/**
 * The span one series point averages. A point per day or per week over
 * years drew a line of fragments wherever readings came in bursts, so the
 * bucket grows with the window: weeks in three months (thirteen points),
 * months in a year (twelve), quarters once `all` reaches back more than two
 * years. An `all` window shorter than that keeps months, so a young record
 * does not shrink to a handful of quarters.
 */
export function timelineBucket(
  zoom: TimelineZoom,
  from: string,
  to: string,
): TimelineBucket {
  if (zoom === "range") return rangeBucket(from, to);
  if (zoom === "quarter") return "week";
  if (zoom === "year") return "month";
  const days = daysBetweenDateKeys(from, to);
  return days > QUARTER_BUCKET_MIN_DAYS ? "quarter" : "month";
}

const ZOOM_DAYS: Readonly<
  Record<Exclude<TimelineZoom, "all" | "range">, number>
> = {
  year: 365,
  quarter: 91,
};

const MEASUREMENT_TYPE_SET: ReadonlySet<string> = new Set(
  Object.values(MeasurementTypes),
);

/**
 * The series keys a `values` parameter names, or null when one is not a
 * series this API knows (the route answers 422). There is no cap on the
 * count: a name given twice counts once, so the list never grows past the
 * names that exist, and each series is its own row under the lanes.
 */
export function parseSeriesKeys(raw: string | undefined): string[] | null {
  if (raw === undefined) return [...DEFAULT_TIMELINE_SERIES];
  const keys = [
    ...new Set(
      raw
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    ),
  ];
  for (const key of keys) {
    if (key !== MOOD_SERIES_KEY && !MEASUREMENT_TYPE_SET.has(key)) return null;
  }
  return keys;
}

/**
 * Every series the record can show, whatever the window: the measurement
 * types with live readings the caller may see, events left out (they are
 * occurrences, not values a mean can be taken of), and the mood score when
 * it is visible and has an entry. Measurement types come in the enum's
 * order, mood last.
 */
export async function loadAvailableSeries(args: {
  recordId: string;
  access: TimelineAccess;
}): Promise<string[]> {
  const { recordId, access } = args;
  const moodVisible =
    access.modules.mood !== false && access.domainVisible("mind");
  const [types, mood] = await Promise.all([
    access.domainVisible("measurements")
      ? listLiveMeasurementTypes(recordId)
      : Promise.resolve([] as MeasurementType[]),
    moodVisible
      ? prisma.moodEntry.findFirst({
          where: { userId: recordId, deletedAt: null },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  return [
    ...types.filter(
      (type) =>
        !EVENT_MEASUREMENT_TYPES.has(type) &&
        measurementTypeVisible(type, access.modules),
    ),
    ...(mood ? [MOOD_SERIES_KEY] : []),
  ];
}

/** Whether an item touches `[from, to]`. An open span runs up to today. */
export function overlaps(
  item: Pick<TimelineItem, "start" | "end" | "open">,
  from: string,
  to: string,
  today: string,
): boolean {
  const end = item.end ?? (item.open ? today : item.start);
  return item.start <= to && end >= from;
}

/**
 * The items of a lane that touch `[from, to]`, kept whole per `group`: when
 * one item of a medication touches the window, every item of it is sent.
 * The client reads a medication from all of them together
 * (`medication-rows.ts`): its courses decide the stretches it was taken, and
 * the dose of a piece that runs into the window was set by a dose change
 * that may lie before it. Cut at the window edge, a course outside it was
 * lost (the medication's own span stood in for it and bridged the gap), and
 * the first piece in the window lost its dose.
 */
export function keepTouchingGroups(
  items: readonly TimelineItem[],
  from: string,
  to: string,
  today: string,
): TimelineItem[] {
  const touching = new Set<string>();
  for (const it of items) {
    if (overlaps(it, from, to, today)) touching.add(it.group ?? it.id);
  }
  return items.filter((it) => touching.has(it.group ?? it.id));
}

export async function loadTimeline(args: {
  recordId: string;
  query: TimelineQuery;
  seriesKeys: readonly string[];
  access: TimelineAccess;
  tz: string;
  now?: Date;
}): Promise<TimelineResponse> {
  const { recordId, query, access, tz } = args;
  const now = args.now ?? new Date();
  const today = userDayKey(now, tz);
  const frame = { userId: recordId, tz, access };

  const visibleLanes = TIMELINE_LANE_KEYS.filter((key) =>
    laneVisible(key, access),
  );
  const measurementsVisible = access.domainVisible("measurements");
  const [reads, firstReading] = await Promise.all([
    Promise.all(visibleLanes.map((key) => LANE_READERS[key](frame))),
    measurementsVisible
      ? prisma.measurement.findFirst({
          where: { userId: recordId, deletedAt: null },
          orderBy: { measuredAt: "asc" },
          select: { measuredAt: true },
        })
      : Promise.resolve(null),
  ]);

  const starts = reads.flatMap((r) => r.items.map((i) => i.start));
  if (firstReading) starts.push(userDayKey(firstReading.measuredAt, tz));
  const dataFrom = starts.length > 0 ? starts.sort()[0] : null;

  const to = query.to ?? today;
  const from =
    query.from ??
    (query.zoom === "all" || query.zoom === "range"
      ? dataFrom !== null && dataFrom < to
        ? dataFrom
        : shiftDateKey(to, -364)
      : shiftDateKey(to, -(ZOOM_DAYS[query.zoom] - 1)));

  const lanes: TimelineResponse["lanes"] = [];
  const standing: StandingItem[] = [];
  visibleLanes.forEach((key, i) => {
    const items = keepTouchingGroups(reads[i].items, from, to, today).sort(
      (a, b) => a.start.localeCompare(b.start),
    );
    if (items.length > 0) lanes.push({ key, items });
    standing.push(...reads[i].standing);
  });

  const seriesKeys = args.seriesKeys.filter((key) =>
    key === MOOD_SERIES_KEY
      ? access.modules.mood !== false && access.domainVisible("mind")
      : measurementsVisible &&
        measurementTypeVisible(key as MeasurementType, access.modules),
  );
  const priorityJson = measurementsVisible
    ? await loadUserSourcePriority(recordId)
    : null;
  const notableFrom =
    shiftDateKey(to, -(DAY_NOTABLE_MAX_SPAN_DAYS - 1)) > from
      ? shiftDateKey(to, -(DAY_NOTABLE_MAX_SPAN_DAYS - 1))
      : from;
  const bucket = timelineBucket(query.zoom, from, to);
  const [series, notable, availableSeries] = await Promise.all([
    loadTimelineSeries({
      userId: recordId,
      keys: seriesKeys,
      from,
      to,
      tz,
      bucket,
      priorityJson,
      now,
    }),
    measurementsVisible
      ? loadNotableRange({
          userId: recordId,
          from: notableFrom,
          to,
          tz,
          priorityJson,
          typeVisible: (t) => measurementTypeVisible(t, access.modules),
          gaps: false,
        })
      : Promise.resolve([]),
    loadAvailableSeries({ recordId, access }),
  ]);

  return {
    zoom: query.zoom,
    range: { from, to, dataFrom },
    lanes,
    standing,
    bucket,
    series,
    availableSeries,
    notable: notable.map(({ date, kind }) => ({ date, kind })),
  };
}

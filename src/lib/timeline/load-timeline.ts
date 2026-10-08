/**
 * `loadTimeline`: the record over the years (v1.42, #613).
 *
 * The lanes read the whole history of their tables (they are small: a few
 * hundred spans and points even on a long record), then the window decides
 * what is sent. The series and the notable days are the expensive part and
 * read only the window.
 *
 * Windows by zoom, when the request names none: `quarter` the last 91 days,
 * `year` the last 365, `all` from the earliest date the record carries. The
 * notable days of an `all` window are computed over its last three years at
 * most: an extreme is "the highest for at least three months", and older
 * history is what the comparison reads, not what it marks.
 */
import { MeasurementType as MeasurementTypes } from "@/generated/prisma/enums";
import type { MeasurementType } from "@/generated/prisma/enums";

import {
  DAY_NOTABLE_MAX_SPAN_DAYS,
  TIMELINE_LANE_KEYS,
  type TimelineItem,
  type TimelineQuery,
  type TimelineResponse,
  type TimelineZoom,
} from "@/lib/day/contract";
import { loadNotableRange } from "@/lib/day/notable";
import { measurementTypeVisible } from "@/lib/day/sections";
import { prisma } from "@/lib/db";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  LANE_READERS,
  laneVisible,
  type StandingItem,
  type TimelineAccess,
} from "@/lib/timeline/lanes";
import {
  loadTimelineSeries,
  MOOD_SERIES_KEY,
  type SeriesGranularity,
} from "@/lib/timeline/series";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

/** The series sent when the request names none. */
export const DEFAULT_TIMELINE_SERIES: readonly MeasurementType[] = [
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "WEIGHT",
];

const ZOOM_GRANULARITY: Readonly<Record<TimelineZoom, SeriesGranularity>> = {
  all: "month",
  year: "week",
  quarter: "day",
};

const ZOOM_DAYS: Readonly<Record<Exclude<TimelineZoom, "all">, number>> = {
  year: 365,
  quarter: 91,
};

const MEASUREMENT_TYPE_SET: ReadonlySet<string> = new Set(
  Object.values(MeasurementTypes),
);

/**
 * The series keys a `values` parameter names, or null when one is not a
 * series this API knows (the route answers 422).
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
  if (keys.length > 8) return null;
  for (const key of keys) {
    if (key !== MOOD_SERIES_KEY && !MEASUREMENT_TYPE_SET.has(key)) return null;
  }
  return keys;
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
    (query.zoom === "all"
      ? dataFrom !== null && dataFrom < to
        ? dataFrom
        : shiftDateKey(to, -364)
      : shiftDateKey(to, -(ZOOM_DAYS[query.zoom] - 1)));

  const lanes: TimelineResponse["lanes"] = [];
  const standing: StandingItem[] = [];
  visibleLanes.forEach((key, i) => {
    const items = reads[i].items
      .filter((it) => overlaps(it, from, to, today))
      .sort((a, b) => a.start.localeCompare(b.start));
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
  const [series, notable] = await Promise.all([
    loadTimelineSeries({
      userId: recordId,
      keys: seriesKeys,
      from,
      to,
      tz,
      granularity: ZOOM_GRANULARITY[query.zoom],
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
  ]);

  return {
    zoom: query.zoom,
    range: { from, to, dataFrom },
    lanes,
    standing,
    series,
    notable: notable.map(({ date, kind }) => ({ date, kind })),
  };
}

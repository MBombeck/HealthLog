/**
 * The timeline's zoom and chosen range in the URL (v1.42):
 * `?zoom=year`, `?zoom=range&from=2026-03-01&to=2026-04-15`. Back and a
 * bookmark both land where the person was. Anything that does not read as
 * a zoom, or a range without two valid ends, falls back to `all` without a
 * word: a stale bookmark should open the timeline, not an error.
 */
import {
  TIMELINE_RANGE_MAX_DAYS,
  TIMELINE_ZOOMS,
  type TimelineZoom,
} from "@/lib/day/contract";
import { isCalendarDateKey } from "@/lib/tz/date-only";

import { dayKey, dayNumber } from "./timeline-dates";

export const ZOOM_PARAM = "zoom";
export const FROM_PARAM = "from";
export const TO_PARAM = "to";

export interface TimelineRange {
  from: string;
  to: string;
}

export interface TimelineUrlState {
  /** The zoom the URL names, or null when it names none (or a bad one). */
  zoom: TimelineZoom | null;
  /** The chosen range, with `zoom` `range` only. */
  range: TimelineRange | null;
}

/**
 * A chosen range made honest, softly: never past today, never before the
 * record's first entry (when known), never inverted, and never longer than
 * the server answers. Each end moves only as far as it must.
 */
export function clampRange(
  range: TimelineRange,
  today: string,
  dataFrom: string | null,
): TimelineRange {
  let { from, to } = range;
  if (to > today) to = today;
  if (dataFrom && dataFrom <= to && from < dataFrom) from = dataFrom;
  if (from > to) from = to;
  const earliest = dayKey(dayNumber(to) - (TIMELINE_RANGE_MAX_DAYS - 1));
  if (from < earliest) from = earliest;
  return { from, to };
}

export function parseTimelineUrl(
  params: Pick<URLSearchParams, "get">,
  today: string,
): TimelineUrlState {
  const raw = params.get(ZOOM_PARAM);
  const zoom = (TIMELINE_ZOOMS as readonly string[]).includes(raw ?? "")
    ? (raw as TimelineZoom)
    : null;
  if (raw !== null && zoom === null) return { zoom: "all", range: null };
  if (zoom !== "range") return { zoom, range: null };
  const from = params.get(FROM_PARAM);
  const to = params.get(TO_PARAM);
  if (
    !from ||
    !to ||
    !isCalendarDateKey(from) ||
    !isCalendarDateKey(to) ||
    from > to ||
    from > today
  ) {
    return { zoom: "all", range: null };
  }
  return { zoom, range: clampRange({ from, to }, today, null) };
}

/**
 * The search string for a zoom (and, for `range`, its ends), keeping every
 * other parameter (`day`, `add`) as it is.
 */
export function timelineSearch(
  current: string,
  zoom: TimelineZoom,
  range: TimelineRange | null,
): string {
  const params = new URLSearchParams(current);
  params.set(ZOOM_PARAM, zoom);
  if (zoom === "range" && range) {
    params.set(FROM_PARAM, range.from);
    params.set(TO_PARAM, range.to);
  } else {
    params.delete(FROM_PARAM);
    params.delete(TO_PARAM);
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}

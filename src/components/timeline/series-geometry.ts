/**
 * The value lines and lab lines under the timeline's lanes, as pure
 * geometry (v1.42, #613; lab lines #1299). `timeline-geometry.ts` stacks
 * them under the lanes; each row is laid out here on its own scale.
 */
import type {
  TimelineBucket,
  TimelineLabPoint,
  TimelineLabSeries,
  TimelineSeries,
} from "@/lib/day/contract";

import { bucketAfter, bucketIndex, dayNumber } from "./timeline-dates";
import type { Scale, TimeWindow } from "./timeline-geometry";

/** Height of one value line, label included. */
export const SERIES_HEIGHT = 60;

/* ─── Value lines ─────────────────────────────────────────────────────────── */

export interface SeriesPointLayout {
  /** The bucket's first day. */
  t: string;
  mean: number;
  /** Readings behind the mean. */
  count: number;
  x: number;
  y: number;
  /** Fewer than {@link THIN_BUCKET_COUNT} readings: drawn hollow. */
  thin: boolean;
}

export interface SeriesLayout {
  key: string;
  unit: string | null;
  top: number;
  height: number;
  /** SVG path data of the solid runs; empty when no two points touch. */
  path: string;
  /** SVG path data of the dashed bridges over short gaps; may be empty. */
  bridges: string;
  /** The most recent mean inside the window, or null. */
  latest: number | null;
  points: SeriesPointLayout[];
}

/** A bucket mean from fewer readings than this is drawn hollow. */
export const THIN_BUCKET_COUNT = 3;

/**
 * The most missing buckets a dashed bridge spans. Beyond it the line stops
 * and starts again, so a long silence reads as one and not as a trend.
 *
 * The rule is one length, about six months between the two points a bridge
 * joins, never more, and never more than a third of what the zoom shows:
 * one missing quarter (the points are six months apart), two missing months
 * in a year (three months apart, a sixth of the window) and four missing
 * weeks in three months (five weeks apart, the window's third). A longer
 * bridge would draw a slope through a stretch where nothing was measured.
 */
export const MAX_BRIDGED_GAP: Readonly<Record<TimelineBucket, number>> = {
  quarter: 1,
  month: 2,
  week: 4,
  // Days come only with a chosen range under six weeks. Three missing days
  // (points four days apart) bridge a weekend away or a forgotten cuff;
  // a longer silence in a window that short is a break worth seeing, and
  // the bridge stays well under a third of even a two-week range.
  day: 3,
};

/**
 * One neutral line per series, scaled to its own range inside the window.
 * A point sits in the middle of its bucket, and every bucket with a reading
 * gets its point, so one month with no neighbours stays visible. Missing
 * buckets stay missing: a short gap is bridged by a dashed stroke
 * ({@link MAX_BRIDGED_GAP}) that joins the two real points and invents none
 * between them, a longer one breaks the line.
 */
export function layoutSeries(
  series: readonly TimelineSeries[],
  top: number,
  window: TimeWindow,
  scale: Scale,
  bucket: TimelineBucket,
): SeriesLayout[] {
  return series.map((s, index) => {
    const rowTop = top + index * SERIES_HEIGHT + 6;
    const height = SERIES_HEIGHT - 16;
    // A bucket that starts before the window still belongs to it while any
    // of its days lie inside.
    const inside = s.points
      .filter((p) => p.t <= window.to && bucketAfter(p.t, bucket) > window.from)
      .sort((a, b) => (a.t < b.t ? -1 : 1));
    if (inside.length === 0) {
      return {
        key: s.key,
        unit: s.unit,
        top: rowTop,
        height,
        path: "",
        bridges: "",
        latest: null,
        points: [],
      };
    }
    let lo = Math.min(...inside.map((p) => p.mean));
    let hi = Math.max(...inside.map((p) => p.mean));
    const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.01, 0.5);
    lo -= pad;
    hi += pad;
    const y = (v: number) => rowTop + height * (1 - (v - lo) / (hi - lo));
    const points = inside.map((p) => {
      const mid = (dayNumber(p.t) + dayNumber(bucketAfter(p.t, bucket))) / 2;
      const x = Math.min(scale.x1, Math.max(scale.x0, scale.x(mid)));
      return {
        t: p.t,
        mean: p.mean,
        count: p.count,
        x,
        y: y(p.mean),
        thin: p.count < THIN_BUCKET_COUNT,
      };
    });
    // eslint-disable-next-line healthlog/no-unlocalised-decimal -- SVG coordinates, read by the renderer, not a person
    const xy = (p: SeriesPointLayout) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    let path = "";
    let bridges = "";
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const missing =
        bucketIndex(cur.t, bucket) - bucketIndex(prev.t, bucket) - 1;
      if (missing === 0) {
        // Continue the run, or open a new one at the previous point.
        path += path.endsWith(xy(prev))
          ? `L${xy(cur)}`
          : `M${xy(prev)}L${xy(cur)}`;
      } else if (missing <= MAX_BRIDGED_GAP[bucket]) {
        bridges += `M${xy(prev)}L${xy(cur)}`;
      }
    }
    return {
      key: s.key,
      unit: s.unit,
      top: rowTop,
      height,
      path,
      bridges,
      latest: inside[inside.length - 1].mean,
      points,
    };
  });
}

/* ─── Lab lines ───────────────────────────────────────────────────────────── */

export interface LabPointLayout extends TimelineLabPoint {
  x: number;
  y: number;
}

export interface LabSeriesLayout {
  key: string;
  biomarkerId: string;
  unit: string;
  top: number;
  height: number;
  /** SVG path data joining the points in time order; empty under two. */
  path: string;
  /**
   * The reference range as y positions inside the row: `top` / `bottom` of
   * the band, null on a side the range leaves open.
   */
  band: { top: number | null; bottom: number | null } | null;
  /** The newest point inside the window, or null. */
  latest: LabPointLayout | null;
  points: LabPointLayout[];
  excluded: number;
}

/**
 * One row per lab marker, below the value lines and in their rhythm, each on
 * its own scale. A lab line is its readings: a point per reading on the day
 * of the draw, joined in time order by a thin stroke, never a mean and never
 * a value between readings (#1299). The scale holds the points and the
 * reference range together, as the labs page's chart does, so the band
 * behind the points is always in view and a point outside it reads as
 * outside at a glance.
 */
export function layoutLabSeries(
  series: readonly TimelineLabSeries[],
  top: number,
  window: TimeWindow,
  scale: Scale,
): LabSeriesLayout[] {
  return series.map((s, index) => {
    const rowTop = top + index * SERIES_HEIGHT + 6;
    const height = SERIES_HEIGHT - 16;
    const inside = s.points.filter(
      (p) => p.date >= window.from && p.date <= window.to,
    );
    const bounds = [s.band?.low, s.band?.high].filter(
      (b): b is number => typeof b === "number",
    );
    const span = [...inside.map((p) => p.value), ...bounds];
    let lo = span.length > 0 ? Math.min(...span) : 0;
    let hi = span.length > 0 ? Math.max(...span) : 1;
    // A lone value, or a range of one number, still needs a span to sit in.
    const pad = hi > lo ? (hi - lo) * 0.12 : Math.abs(hi) * 0.1 || 1;
    lo -= pad;
    hi += pad;
    const y = (v: number) => rowTop + height * (1 - (v - lo) / (hi - lo));
    const points = inside.map((p) => ({
      ...p,
      x: Math.min(scale.x1, Math.max(scale.x0, scale.xMid(p.date))),
      y: y(p.value),
    }));
    // eslint-disable-next-line healthlog/no-unlocalised-decimal -- SVG coordinates, read by the renderer, not a person
    const xy = (p: LabPointLayout) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    const path =
      points.length > 1
        ? points.map((p, i) => `${i === 0 ? "M" : "L"}${xy(p)}`).join("")
        : "";
    const band =
      s.band && (s.band.low !== null || s.band.high !== null)
        ? {
            top: s.band.high === null ? null : y(s.band.high),
            bottom: s.band.low === null ? null : y(s.band.low),
          }
        : null;
    return {
      key: s.key,
      biomarkerId: s.biomarkerId,
      unit: s.unit,
      top: rowTop,
      height,
      path,
      band,
      latest: points.at(-1) ?? null,
      points,
      excluded: s.excluded,
    };
  });
}

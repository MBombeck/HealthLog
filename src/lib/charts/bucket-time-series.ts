/**
 * Time-series bucketing for the health-chart visualisation.
 *
 * The dashboard charts default to daily points, but on a multi-year
 * range that produces hundreds or thousands of dots that the eye
 * cannot read. v1.4.6 introduces automatic aggregation so the user
 * still sees the trend without paying the rendering cost:
 *
 *   - range ≤ 90 days  → "day"   (no change, daily points)
 *   - range 91-730     → "week"  (ISO weekly mean per metric)
 *   - range > 730 days → "month" (Berlin calendar monthly mean)
 *
 * That span ladder is what the "All" tab uses. The fixed tabs name their
 * grain instead (`pickRangeBucket` in `range-grain.ts`): the 90-day tab is
 * weekly although its span never passes 90 days.
 *
 * The function is pure and string-stable: the bucket key for a given
 * timestamp depends only on the calendar week / month, never on the
 * input order, so the chart-data adapter can call it as part of its
 * memoised render path without surprise.
 */

export type ChartBucketType = "day" | "week" | "month";

export interface ChartBucketPoint {
  /** Berlin TZ start-of-bucket as a Unix ms timestamp. */
  timestamp: number;
  /**
   * The mean value per metric. Days/weeks/months without an
   * observation are skipped entirely — never reported as 0.
   */
  values: Record<string, number>;
  /** How many daily input points fed into this bucket per metric. */
  counts: Record<string, number>;
  /**
   * The plain sum, the smallest and the largest input per metric, for the
   * callers that fold a count (summed) or a spread (min of the minima, max of
   * the maxima) alongside the mean.
   */
  sums: Record<string, number>;
  mins: Record<string, number>;
  maxs: Record<string, number>;
}

export interface BucketedChartSeries {
  bucket: ChartBucketType;
  points: ChartBucketPoint[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One formatter per timezone. Building an `Intl.DateTimeFormat` is expensive
 * enough that doing it per point matters on a two-year monthly chart.
 */
const ymdFormatters = new Map<string, Intl.DateTimeFormat>();

function ymdFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = ymdFormatters.get(timeZone);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  ymdFormatters.set(timeZone, fmt);
  return fmt;
}

interface ZonedYmd {
  year: number;
  month: number;
  day: number;
}

function toZonedYmd(date: Date, timeZone: string): ZonedYmd {
  const parts = ymdFormatter(timeZone).formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  if (!year || !month || !day) {
    throw new Error(`Could not derive Y-M-D in ${timeZone}`);
  }
  return { year, month, day };
}

function utcMidnight({ year, month, day }: ZonedYmd): number {
  return Date.UTC(year, month - 1, day);
}

/**
 * ISO 8601 week starts on Monday. Week 1 of a year is the week
 * containing the first Thursday of that year. Returns the UTC
 * midnight of the Monday of the week containing `date`.
 */
function isoWeekStartUtc(date: Date, timeZone: string): number {
  const ymd = toZonedYmd(date, timeZone);
  const utc = utcMidnight(ymd);
  // Day of week, 1=Mon..7=Sun (ISO).
  const dow = ((new Date(utc).getUTCDay() + 6) % 7) + 1;
  return utc - (dow - 1) * MS_PER_DAY;
}

function monthStartUtc(date: Date, timeZone: string): number {
  const { year, month } = toZonedYmd(date, timeZone);
  return Date.UTC(year, month - 1, 1);
}

function dayStartUtc(date: Date, timeZone: string): number {
  return utcMidnight(toZonedYmd(date, timeZone));
}

export interface BucketInputPoint {
  /**
   * Either a Date or a unix-ms number. Daily aggregations from the
   * health-chart adapter come in as numbers; raw API rows come in as
   * Date.
   */
  timestamp: number | Date;
  /** Per-metric value map (same keys as the chart series). */
  values: Record<string, number | undefined>;
}

export interface BucketTimeSeriesOptions {
  /** The grain; a chart with range tabs takes it from `pickRangeBucket`. */
  bucket: ChartBucketType;
  /**
   * The calendar the day / week / month boundaries are drawn in.
   *
   * Deliberately required rather than defaulted. This module used to hard-code
   * Europe/Berlin, which meant a reading late on the last evening of a month
   * fell into the wrong month's bar for anyone who does not live there — and a
   * default would have left every caller that forgets to pass one still wrong,
   * silently. Required turns that into a compile error instead.
   */
  timeZone: string;
}

/**
 * Bucket a daily-aggregated chart series into day/week/month groups.
 * Weeks use ISO 8601 (Monday start); every boundary is drawn in the caller's
 * `timeZone`. Empty buckets are skipped so a sparse user does not get a flat
 * zero baseline.
 */
export function bucketTimeSeries(
  points: BucketInputPoint[],
  options: BucketTimeSeriesOptions,
): BucketedChartSeries {
  const { bucket, timeZone } = options;
  const sorted = [...points].sort(
    (a, b) => toMs(a.timestamp) - toMs(b.timestamp),
  );

  if (bucket === "day") {
    // Day-granularity is the upstream's native shape, but we still go
    // through aggregation so the output shape is consistent and so
    // duplicate-day callers (raw API mode) collapse cleanly.
    return aggregate(sorted, bucket, (ts) =>
      dayStartUtc(new Date(toMs(ts)), timeZone),
    );
  }
  if (bucket === "week") {
    return aggregate(sorted, bucket, (ts) =>
      isoWeekStartUtc(new Date(toMs(ts)), timeZone),
    );
  }
  return aggregate(sorted, bucket, (ts) =>
    monthStartUtc(new Date(toMs(ts)), timeZone),
  );
}

function toMs(ts: number | Date): number {
  return typeof ts === "number" ? ts : ts.getTime();
}

function aggregate(
  points: BucketInputPoint[],
  bucket: ChartBucketType,
  bucketKey: (timestamp: number | Date) => number,
): BucketedChartSeries {
  const aggregates = new Map<
    number,
    {
      sums: Record<string, number>;
      counts: Record<string, number>;
      mins: Record<string, number>;
      maxs: Record<string, number>;
    }
  >();

  for (const point of points) {
    const key = bucketKey(point.timestamp);
    const slot = aggregates.get(key) ?? {
      sums: {},
      counts: {},
      mins: {},
      maxs: {},
    };
    for (const [metric, raw] of Object.entries(point.values)) {
      if (raw === undefined || !Number.isFinite(raw)) continue;
      slot.sums[metric] = (slot.sums[metric] ?? 0) + raw;
      slot.counts[metric] = (slot.counts[metric] ?? 0) + 1;
      slot.mins[metric] = Math.min(slot.mins[metric] ?? raw, raw);
      slot.maxs[metric] = Math.max(slot.maxs[metric] ?? raw, raw);
    }
    aggregates.set(key, slot);
  }

  const out: ChartBucketPoint[] = Array.from(aggregates.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestamp, slot]) => {
      const values: Record<string, number> = {};
      const counts: Record<string, number> = {};
      const sums: Record<string, number> = {};
      const mins: Record<string, number> = {};
      const maxs: Record<string, number> = {};
      for (const [metric, sum] of Object.entries(slot.sums)) {
        const n = slot.counts[metric] ?? 0;
        if (n === 0) continue;
        values[metric] = sum / n;
        counts[metric] = n;
        sums[metric] = sum;
        mins[metric] = slot.mins[metric];
        maxs[metric] = slot.maxs[metric];
      }
      return { timestamp, values, counts, sums, mins, maxs };
    })
    .filter((p) => Object.keys(p.values).length > 0);

  return { bucket, points: out };
}

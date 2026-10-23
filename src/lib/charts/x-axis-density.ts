/**
 * Universal X-axis tick-density helper.
 *
 * Charts on /dashboard and /insights all pre-v1.4.19 used Recharts'
 * default tick rendering with `interval="preserveStartEnd"`. That left
 * the medication compliance chart painting one tick PER DAY on a Pixel
 * 5 (393 CSS px wide) — 30 overlapping labels that became an unreadable
 * smear. The weight / BMI charts didn't show the same density because
 * they auto-bucketed daily → weekly above 90 days, but at the 30-day
 * range they still drew one tick every couple of days.
 *
 * The user-visible problem: chart cards looked inconsistent. Some had
 * dense clutter, others had clean breathing-room. This helper unifies
 * the rule across every chart so the X-axis reads the same way no
 * matter the metric.
 *
 * v1.4.19 A2 shipped a viewport-bucket policy ("≤360px → 4 ticks max",
 * "≤480px → 6", etc.) that worked for daily-bucketed BP charts but
 * still left the medication-compliance chart unreadable: at 30 daily
 * points on a Pixel 5 the cap-at-6 algorithm produced every-5th-day
 * labels ("01.05", "06.05", "11.05", …), which looked clean on the
 * tick axis but read as random sample dates with no calendar rhythm.
 *
 * v1.4.25 W3b tunes the policy to day-aware buckets keyed on the data
 * span + viewport width:
 *
 *   Mobile  (< 640px viewport):
 *     1-7   points → render every tick (no skip)
 *     8-31  points → every 7th day      (interval 6)
 *     32-90 points → every 14th day     (interval 13)
 *     90+   points → ~monthly           (interval 29)
 *   Desktop (≥ 640px viewport):
 *     1-14   points → render every tick
 *     15-60  points → every 7th day
 *     60-180 points → every 14th day
 *     180+   points → ~monthly
 *
 * The 640px breakpoint matches Tailwind's `sm` so a single touch-vs-
 * desktop rule covers every device. The day-aware steps (7 / 14 / 30)
 * align tick labels with calendar week / fortnight / month rhythms so
 * the user's eye lands on "every Monday" instead of "every 5th day
 * from the leftmost data point".
 *
 * The Recharts `interval` prop expects a 0-based skip count: 0 = render
 * every tick, 1 = render every other, 2 = every third, etc. So
 * "every 7th day" → interval 6, "every 14th" → 13, "monthly" → 29.
 *
 * `interval="preserveStartEnd"` forces the first and last tick to be
 * rendered regardless of the modulo skip. Every caller in the codebase
 * pairs this helper with `preserveStartEnd` (or accepts that Recharts
 * keeps both endpoints by default in non-numeric XAxis configurations)
 * so the leftmost / rightmost dates are never sacrificed to the skip
 * pattern.
 */

/** Viewport-width breakpoint between the mobile + desktop policies. */
const MOBILE_DESKTOP_BREAKPOINT_PX = 640;

interface TickBucket {
  /** Inclusive lower bound on the data-point count. */
  minPoints: number;
  /** Recharts `interval` value: 0 = every tick, 6 = every 7th, etc. */
  interval: number;
}

/** v1.4.25 W3b policy: mobile (`< 640px`) — calendar-week buckets. */
const MOBILE_BUCKETS: ReadonlyArray<TickBucket> = [
  { minPoints: 0, interval: 0 }, // 1-7 days   → every tick
  { minPoints: 8, interval: 6 }, // 8-31 days  → every 7th day
  { minPoints: 32, interval: 13 }, // 32-90 days → every 14th day
  { minPoints: 91, interval: 29 }, // 90+ days   → monthly
];

/** v1.4.25 W3b policy: desktop (`≥ 640px`) — calendar-fortnight buckets. */
const DESKTOP_BUCKETS: ReadonlyArray<TickBucket> = [
  { minPoints: 0, interval: 0 }, // 1-14 days   → every tick
  { minPoints: 15, interval: 6 }, // 15-60 days  → every 7th day
  { minPoints: 61, interval: 13 }, // 60-180 days → every 14th day
  { minPoints: 181, interval: 29 }, // 180+ days   → monthly
];

function resolveBucket(pointCount: number, viewportWidth: number): TickBucket {
  const buckets =
    viewportWidth < MOBILE_DESKTOP_BREAKPOINT_PX
      ? MOBILE_BUCKETS
      : DESKTOP_BUCKETS;
  let resolved = buckets[0];
  for (const bucket of buckets) {
    if (pointCount >= bucket.minPoints) resolved = bucket;
  }
  return resolved;
}

/**
 * Compute the Recharts `interval` skip count for a chart with
 * `pointCount` data points rendered at `viewportWidth`.
 *
 * Returns 0 when the chart has fewer points than the bucket's "render
 * every tick" threshold, and a positive integer otherwise.
 *
 * Examples (mobile <640px viewport):
 *   - 7  daily points  → 0   (every tick)
 *   - 30 daily points  → 6   (every 7th day)
 *   - 90 daily points  → 13  (every 14th day)
 *   - 365 daily points → 29  (monthly)
 *
 * Examples (desktop ≥640px viewport):
 *   - 30 daily points  → 6   (every 7th day)
 *   - 180 daily points → 13  (every 14th day)
 */
export function chooseTickInterval(
  pointCount: number,
  viewportWidth: number,
): number {
  if (!Number.isFinite(pointCount) || pointCount <= 0) return 0;
  const safeViewport =
    Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const bucket = resolveBucket(pointCount, safeViewport);
  return Math.max(0, bucket.interval);
}

/**
 * v1.4.19 A2 legacy helper — kept for the existing test suite + any
 * external consumer. Maps the viewport to a sensible "max ticks" cap.
 *
 * Note that `chooseTickInterval` no longer routes through this; the
 * day-aware policy above replaced the cap-based algorithm. The shape
 * stays for backwards compatibility (a few tests assert specific cap
 * values per viewport).
 */
const VIEWPORT_BUCKETS: ReadonlyArray<{
  maxWidth: number;
  maxTicks: number;
}> = [
  { maxWidth: 360, maxTicks: 4 },
  { maxWidth: 480, maxTicks: 6 },
  { maxWidth: 768, maxTicks: 8 },
  { maxWidth: Number.POSITIVE_INFINITY, maxTicks: 10 },
];

export function resolveTargetTickCount(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return VIEWPORT_BUCKETS[VIEWPORT_BUCKETS.length - 1].maxTicks;
  }
  for (const bucket of VIEWPORT_BUCKETS) {
    if (viewportWidth <= bucket.maxWidth) return bucket.maxTicks;
  }
  return VIEWPORT_BUCKETS[VIEWPORT_BUCKETS.length - 1].maxTicks;
}

/**
 * SSR-safe accessor for the active viewport width. Used by chart wrappers
 * so they can react to the current device. Returns the desktop default
 * (1280) on the server so SSR-rendered charts keep their pre-v1.4.19
 * tick density and progressively enhance once mounted in the browser.
 */
export function getViewportWidth(): number {
  if (typeof window === "undefined") return 1280;
  // visualViewport reflects pinch-zoom on iOS; we want the layout
  // viewport, not the visual one. Fall back to innerWidth.
  return window.innerWidth ?? 1280;
}

/**
 * Tick positions for a chart whose x axis is the point index, on a calendar
 * grid rather than every n-th point.
 *
 * Every n-th point read as random dates wherever the series had gaps: on a
 * 90-day blood-pressure chart with a few missed days the labels fell 18, 14,
 * 13, 17 and 23 days apart, and the forced last label crowded its neighbour.
 * So the step is a calendar one (a day, two days, a week, two weeks, a month,
 * a quarter, half a year, a year), the smallest that keeps the labels under
 * the width's cap, and each tick is the point on that grid's date: Mondays
 * for the week steps (an even-week grid for two), the first of the month for
 * the month steps. A grid date with no point of its own takes the nearest
 * point within half a step, and none if there is none, so a tick never
 * claims a date it is not near. The last point is not forced in.
 *
 * `timestamp` is the point's day anchor (noon UTC of the day it stands for,
 * or the start of its week or month bucket); its UTC date is the day.
 */
export function computeTickPositions(
  chartData: ReadonlyArray<{ timestamp: number } | unknown>,
  viewportWidth: number,
  layout?: TickLayout,
): number[] {
  const length = chartData?.length ?? 0;
  if (length <= 0) return [];
  if (length === 1) return [0];

  const days = chartData.map((point) =>
    Math.floor(
      ((point as { timestamp?: number })?.timestamp ?? Number.NaN) / DAY_MS,
    ),
  );
  if (days.some((day) => !Number.isFinite(day))) {
    return Array.from({ length }, (_, index) => index);
  }
  const first = days[0]!;
  const last = days[length - 1]!;
  const maxTicks =
    Number.isFinite(viewportWidth) &&
    viewportWidth < MOBILE_DESKTOP_BREAKPOINT_PX
      ? MAX_TICKS_MOBILE
      : MAX_TICKS_DESKTOP;

  const ticksFor = (step: CalendarStep): number[] => {
    const ticks: number[] = [];
    const reach = Math.floor(step.approxDays / 2);
    for (const anchor of calendarAnchors(first, last, step)) {
      const index = nearestPoint(days, anchor, reach);
      if (
        index !== -1 &&
        (ticks.length === 0 || index > ticks[ticks.length - 1]!)
      ) {
        ticks.push(index);
      }
    }
    return ticks;
  };

  // With the plot's width known, the step is the smallest whose labels all
  // fit side by side where they are drawn: on an index axis the points, not
  // the days, are spaced evenly, so two grid dates can sit closer than their
  // step where the series is dense. Recharts dropped such a colliding label
  // itself, which left the grid with holes. Without a width, the count cap.
  const fits = (ticks: number[]) => {
    if (!layout) return ticks.length <= maxTicks;
    const perIndex = layout.plotWidth / Math.max(1, length - 1);
    return ticks.every(
      (tick, i) =>
        i === 0 || (tick - ticks[i - 1]!) * perIndex >= layout.labelWidth,
    );
  };
  for (const step of CALENDAR_STEPS) {
    const count = Math.floor((last - first) / step.approxDays) + 1;
    if (!layout && count > maxTicks) continue;
    const ticks = ticksFor(step);
    if (ticks.length > 0 && fits(ticks)) return ticks;
  }
  const widest = ticksFor(CALENDAR_STEPS[CALENDAR_STEPS.length - 1]!);
  return widest.length > 0 ? widest : [0];
}

/** Where the ticks are drawn: the plot's width and a label's width, in px. */
export interface TickLayout {
  plotWidth: number;
  labelWidth: number;
}

const DAY_MS = 86_400_000;
/** 1970-01-05 was a Monday: day numbers counted from it fall on weeks. */
const FIRST_MONDAY = 4;
const MAX_TICKS_MOBILE = 5;
const MAX_TICKS_DESKTOP = 8;

interface CalendarStep {
  kind: "days" | "months";
  /** Days per step, or months per step. */
  size: number;
  /** The step's length in days, for counting and the nearest-point window. */
  approxDays: number;
}

const CALENDAR_STEPS: ReadonlyArray<CalendarStep> = [
  { kind: "days", size: 1, approxDays: 1 },
  { kind: "days", size: 2, approxDays: 2 },
  { kind: "days", size: 7, approxDays: 7 },
  { kind: "days", size: 14, approxDays: 14 },
  { kind: "months", size: 1, approxDays: 30 },
  { kind: "months", size: 3, approxDays: 91 },
  { kind: "months", size: 6, approxDays: 182 },
  { kind: "months", size: 12, approxDays: 365 },
];

/** The grid's dates (as day numbers) from `first` to `last`, both included. */
function calendarAnchors(
  first: number,
  last: number,
  step: CalendarStep,
): number[] {
  const anchors: number[] = [];
  if (step.kind === "days") {
    const offset = step.size >= 7 ? FIRST_MONDAY : 0;
    const start =
      first + ((((offset - first) % step.size) + step.size) % step.size);
    for (let day = start; day <= last; day += step.size) anchors.push(day);
    return anchors;
  }
  const from = new Date(first * DAY_MS);
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  // Start on a month the step's grid holds (Jan / Apr / Jul / Oct for a
  // quarter), at or after the first point.
  month = Math.ceil(month / step.size) * step.size;
  if (Date.UTC(year, month, 1) / DAY_MS < first) month += step.size;
  for (;;) {
    year += Math.floor(month / 12);
    month %= 12;
    const day = Date.UTC(year, month, 1) / DAY_MS;
    if (day > last) break;
    anchors.push(day);
    month += step.size;
  }
  return anchors;
}

/** The index of the point nearest `anchor` within `reach` days, or -1. */
function nearestPoint(days: number[], anchor: number, reach: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < days.length; index += 1) {
    const distance = Math.abs(days[index]! - anchor);
    if (distance <= reach && distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

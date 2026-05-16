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
 * v1.4.29 — Recharts ignores the `interval` prop on a numeric
 * `<XAxis type="number" />`. The pulse + mood charts switched to
 * numeric axes in v1.4.25 to support multi-band rendering; the
 * legacy `interval` value silently degraded to "every tick" on
 * those charts.
 *
 * `computeTickPositions` returns explicit tick indices the numeric
 * axis can consume via the `ticks` prop. The skip count comes from
 * `chooseTickInterval` so the day-aware policy stays in one place.
 * The result is clamped to at least 3 ticks (when the chart has
 * enough data) and at most ~12, so the user always sees calendar
 * landmarks without overcrowding.
 *
 * Returns an empty array for zero-length data and `[0]` for a
 * single-point chart.
 */
export function computeTickPositions(
  chartData: ReadonlyArray<{ timestamp: number } | unknown>,
  viewportWidth: number,
): number[] {
  const length = chartData?.length ?? 0;
  if (length <= 0) return [];
  if (length === 1) return [0];

  const lastIndex = length - 1;
  const interval = chooseTickInterval(length, viewportWidth);
  // `interval === 0` means "render every tick". Cap the visible tick
  // count so dense series (e.g. 365-row pulse) never blow past ~12
  // labels — pick a step that hits ~6 ticks if the policy would
  // otherwise produce too many.
  const TARGET_MAX_TICKS = 12;
  let step = interval > 0 ? interval + 1 : 1;
  if (length / step > TARGET_MAX_TICKS) {
    step = Math.ceil(length / TARGET_MAX_TICKS);
  }
  // Floor on visible tick count — never fewer than 3 ticks unless
  // the data simply doesn't have that many points.
  const minTicks = Math.min(3, length);
  if (length / step < minTicks) {
    step = Math.max(1, Math.floor(length / minTicks));
  }

  const ticks: number[] = [];
  for (let i = 0; i <= lastIndex; i += step) {
    ticks.push(i);
  }
  // Always include the last index so the chart's right edge keeps a
  // tick label.
  if (ticks[ticks.length - 1] !== lastIndex) {
    ticks.push(lastIndex);
  }
  return ticks;
}

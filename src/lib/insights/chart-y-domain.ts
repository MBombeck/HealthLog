/**
 * Shared Y-axis domain computation for every chart surface (dashboard
 * charts, insights sub-page charts, mini charts). One source of truth so
 * the padding rules cannot drift per chart.
 *
 * Padding rules:
 * - Flat series (min === max): pad symmetrically by 5% of the magnitude
 *   (at least 1 unit), with a little extra headroom on top.
 * - Otherwise: pad the bottom by 8% of the span (min 0.5) and the top by
 *   16% of the span (min 1).
 * - Zero clamp: the lower bound never dips below 0 when the charted metrics
 *   cannot be negative — padding only extends upward or down to 0. Counts,
 *   steps, weights etc. must not render a negative axis. Series with genuine
 *   negative values (deltas, differences) keep the full downward padding.
 *
 *   "Cannot be negative" is answered by `areAllNonNegativeMetrics` off the
 *   metric's own declared plausibility domain — the SAME fact the personal
 *   baseline band floors against, so the axis and the sentence printed under
 *   it can no longer disagree. It also covers the derived overlays: a trend
 *   line extrapolating a step count below zero now clips at the axis floor
 *   instead of dragging the whole chart into negative territory. The observed
 *   minimum stays a second, weaker trigger, so a caller that names no type
 *   (a mini chart over an anonymous series) keeps the data-derived behaviour.
 */
import { areAllNonNegativeMetrics } from "@/lib/measurements/value-domain";

export function computePaddedYDomain(
  values: readonly number[],
  types: readonly (string | null | undefined)[] = [],
): [number, number] | undefined {
  const finite = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (!finite.length) return undefined;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  // Non-negative series never get a negative lower bound.
  const nonNegative = min >= 0 || areAllNonNegativeMetrics(types);
  const clampLower = (lower: number) =>
    nonNegative ? Math.max(0, lower) : lower;

  if (min === max) {
    const delta = Math.max(Math.abs(min) * 0.05, 1);
    return [clampLower(min - delta), max + delta * 1.35];
  }

  const span = max - min;
  const paddingBottom = Math.max(span * 0.08, 0.5);
  const paddingTop = Math.max(span * 0.16, 1);
  return [clampLower(min - paddingBottom), max + paddingTop];
}

/**
 * Evenly spaced round ticks for a value axis, and the domain padded out to
 * them.
 *
 * Handed only a domain, Recharts started its ticks at the domain's lower
 * bound and forced the upper bound in as the last tick, so a padded
 * blood-pressure domain read 74, 94, 114, 134, 149: round-ish numbers that
 * were not round, and a last step shorter than the others. The step here is
 * 1, 2 or 5 times a power of ten, the smallest that keeps the axis at
 * `maxTicks` labels or fewer, and the domain becomes the multiples of it
 * around the padded data, so every gap is the same and every label is
 * round. A non-negative domain stays non-negative.
 */
export function niceYAxis(
  domain: readonly [number, number],
  maxTicks = 6,
): { domain: [number, number]; ticks: number[] } {
  const [low, high] = domain;
  const span = high - low;
  if (!Number.isFinite(span) || span <= 0) {
    return { domain: [low, high], ticks: [low, high] };
  }
  const intervals = Math.max(1, maxTicks - 1);
  const raw = span / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  let step = magnitude * 10;
  for (const factor of [1, 2, 5, 10]) {
    const candidate = factor * magnitude;
    if (
      Math.ceil(high / candidate) - Math.floor(low / candidate) <=
      intervals
    ) {
      step = candidate;
      break;
    }
  }
  const first = Math.floor(low / step) * step;
  const last = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  // Rounded to the step's own precision, so 0.1 + 0.2 never reads 0.30000…
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  for (let k = 0; first + k * step <= last + step / 2; k += 1) {
    ticks.push(Number((first + k * step).toFixed(digits)));
  }
  return { domain: [ticks[0]!, ticks[ticks.length - 1]!], ticks };
}

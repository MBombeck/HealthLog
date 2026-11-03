/**
 * The least-squares line, in one place.
 *
 * Six readers fitted a line by hand: two charts, the trend summary, the
 * graded series, the trajectory fit and the rollup regression composed from
 * stored accumulators. Two of them used the centred sums, four the
 * determinant form `n·Σxy − Σx·Σy`, which loses digits on a large x axis
 * (epoch days) that the centred form keeps. Every fit now goes through
 * {@link fitFromSums}, the centred form over the accumulators, so a fit read
 * from points and one composed from stored sums are the same arithmetic.
 *
 * `src/__tests__/linear-fit-single-implementation-guard.test.ts` keeps the
 * hand-rolled forms out of the rest of the tree.
 */

/** The sums a fit is composed from. */
export interface FitSums {
  n: number;
  sumX: number;
  sumY: number;
  sumXx: number;
  sumXy: number;
  sumYy: number;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Null when y has no variance (Postgres REGR_R2 answers null too). */
  r2: number | null;
  n: number;
  meanX: number;
  meanY: number;
  /** Centred sums of squares and products. */
  sxx: number;
  sxy: number;
  syy: number;
}

/**
 * Fit from accumulated sums. Null below two points or when every x is the
 * same (no slope). The centred identities `Sxx = Σxx − (Σx)²/n` subtract at
 * matched scale, so the cancellation is bounded by the x variance, not the
 * x magnitude.
 */
export function fitFromSums(sums: FitSums): LinearFit | null {
  const { n, sumX, sumY, sumXx, sumXy, sumYy } = sums;
  if (n < 2) return null;
  const sxx = sumXx - (sumX * sumX) / n;
  const sxy = sumXy - (sumX * sumY) / n;
  // A sum of squares is never negative; the subtraction can still land a
  // hair below zero when every y sits close to one large value.
  const syy = Math.max(0, sumYy - (sumY * sumY) / n);
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const meanX = sumX / n;
  const meanY = sumY / n;
  return {
    slope,
    intercept: meanY - slope * meanX,
    // r² is at most 1 by Cauchy–Schwarz. With y far from zero and little
    // spread (two weighings of about 1000, a tenth apart) the centred sums
    // lose their last digits and the ratio came out at 1.00000004. The clamp
    // keeps it in range; inside the range the same lost digits remain, which
    // the points and the stored-sums paths share by design.
    r2: syy === 0 ? null : Math.min(1, (sxy * sxy) / (sxx * syy)),
    n,
    meanX,
    meanY,
    sxx,
    sxy,
    syy,
  };
}

/** The sums of paired values. */
export function sumsOf(xs: readonly number[], ys: readonly number[]): FitSums {
  if (xs.length !== ys.length) {
    throw new RangeError("linear fit: xs and ys differ in length");
  }
  let sumX = 0;
  let sumY = 0;
  let sumXx = 0;
  let sumXy = 0;
  let sumYy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    const y = ys[i];
    sumX += x;
    sumY += y;
    sumXx += x * x;
    sumXy += x * y;
    sumYy += y * y;
  }
  return { n: xs.length, sumX, sumY, sumXx, sumXy, sumYy };
}

/** Fit `ys` against `xs`. */
export function linearFit(
  xs: readonly number[],
  ys: readonly number[],
): LinearFit | null {
  return fitFromSums(sumsOf(xs, ys));
}

/** One day in milliseconds, the x unit of a trend over dated points. */
const DAY_MS = 86_400_000;

/**
 * The fitted line over dated points, x in days from the first point: the
 * chart trend lines draw it, with each fitted value at two decimals. Null
 * below two points or when every point shares one instant.
 */
export function trendLineByTime(
  data: ReadonlyArray<{ date: Date; value: number }>,
): {
  points: Array<{ date: Date; value: number }>;
  slopePerDay: number;
} | null {
  if (data.length < 2) return null;
  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const startTime = sorted[0].date.getTime();
  const xOf = (d: Date) => (d.getTime() - startTime) / DAY_MS;
  const fit = linearFit(
    sorted.map((p) => xOf(p.date)),
    sorted.map((p) => p.value),
  );
  if (!fit) return null;
  return {
    points: sorted.map((p) => ({
      date: p.date,
      value: Math.round((fit.intercept + fit.slope * xOf(p.date)) * 100) / 100,
    })),
    slopePerDay: fit.slope,
  };
}

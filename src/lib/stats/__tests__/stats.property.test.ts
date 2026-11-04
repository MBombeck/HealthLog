/**
 * The statistics helpers against their invariants, on random samples.
 *
 * Not a second implementation: each property is a law any correct version
 * obeys (order does not matter, shifting the data shifts the answer, a
 * spread is never negative), plus agreement between the several medians the
 * tree carries, which are separate code that has to say the same number.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fitFromSums, linearFit, sumsOf } from "@/lib/stats/linear-fit";
import { standardDeviation, variance } from "@/lib/stats/spread";
import {
  defaultHacLag,
  fitSegmentedRegression,
  MIN_HAC_LAG,
  neweyWestLag,
} from "@/lib/stats/segmented-regression";
import { median as baselineMedian } from "@/lib/insights/derived/baseline";
import { median as calendarMedian } from "@/lib/activity/calendar-math";
import { median as cycleMedian } from "@/lib/cycle/prediction";
import { median as scoreMedian, mean } from "@/lib/analytics/score/shared";
import { percentile } from "@/lib/insights/strain-score";
import { quantile } from "@/lib/analytics/mood-prognosis/validate";

import { assertProperty } from "../../../../tests/property/fast-check";

/**
 * Values on the scale and at the precision of health readings: hundredths
 * between -1 000 and 10 000. Subnormal doubles are not readings, and near
 * them the identities hold only to the last bit.
 */
const valueArb = fc
  .integer({ min: -100_000, max: 1_000_000 })
  .map((hundredths) => hundredths / 100);
const sampleArb = fc.array(valueArb, { minLength: 1, maxLength: 60 });

function close(a: number, b: number, scale = 1): void {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-7 * Math.max(1, scale));
}

function magnitude(values: readonly number[]): number {
  return values.reduce((m, v) => Math.max(m, Math.abs(v)), 1);
}

describe("medians and quantiles", () => {
  it("every median in the tree says the same number", () => {
    assertProperty(
      fc.property(sampleArb, (values) => {
        const expected = baselineMedian([...values]);
        expect(cycleMedian(values)).toBe(expected);
        expect(scoreMedian(values)).toBe(expected);
        // The interpolating forms compute the middle pair as a + (b − a)/2
        // rather than (a + b)/2, which can differ in the last bit.
        const scale = magnitude(values);
        close(calendarMedian(values)!, expected, scale);
        close(percentile(values, 50), expected, scale);
        close(quantile(values, 0.5), expected, scale);
      }),
    );
  });

  it("a median ignores order, sits between the extremes, and moves with a shift", () => {
    assertProperty(
      fc.property(
        sampleArb,
        fc.double({ min: -500, max: 500, noNaN: true }),
        (values, shift) => {
          const m = scoreMedian(values);
          const reversed = [...values].reverse();
          expect(scoreMedian(reversed)).toBe(m);
          expect(m).toBeGreaterThanOrEqual(Math.min(...values));
          expect(m).toBeLessThanOrEqual(Math.max(...values));
          close(
            scoreMedian(values.map((v) => v + shift)),
            m + shift,
            magnitude(values) + Math.abs(shift),
          );
        },
      ),
    );
  });

  it("a quantile never decreases as the level rises", () => {
    assertProperty(
      fc.property(
        sampleArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (values, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(quantile(values, lo)).toBeLessThanOrEqual(
            quantile(values, hi),
          );
          expect(quantile(values, 0)).toBe(Math.min(...values));
          expect(quantile(values, 1)).toBe(Math.max(...values));
        },
      ),
    );
  });

  it("a mean sits between the extremes", () => {
    assertProperty(
      fc.property(sampleArb, (values) => {
        const m = mean(values);
        const eps = 1e-9 * magnitude(values);
        expect(m).toBeGreaterThanOrEqual(Math.min(...values) - eps);
        expect(m).toBeLessThanOrEqual(Math.max(...values) + eps);
      }),
    );
  });
});

describe("spread", () => {
  it("is never negative, ignores a shift, and scales with the data", () => {
    assertProperty(
      fc.property(
        fc.array(valueArb, { minLength: 2, maxLength: 60 }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        (values, shift, scale) => {
          const sd = standardDeviation(values, "population")!;
          expect(sd).toBeGreaterThanOrEqual(0);
          const tolerance = 1e-6 * (magnitude(values) + Math.abs(shift));
          expect(
            Math.abs(
              standardDeviation(
                values.map((v) => v + shift),
                "population",
              )! - sd,
            ),
          ).toBeLessThanOrEqual(tolerance);
          expect(
            Math.abs(
              standardDeviation(
                values.map((v) => v * scale),
                "population",
              )! -
                sd * scale,
            ),
          ).toBeLessThanOrEqual(tolerance * scale);
        },
      ),
    );
  });

  it("puts the sample variance above the population variance by n/(n-1)", () => {
    assertProperty(
      fc.property(
        fc.array(valueArb, { minLength: 2, maxLength: 60 }),
        (values) => {
          const n = values.length;
          const population = variance(values, "population")!;
          const sample = variance(values, "sample")!;
          close(sample, (population * n) / (n - 1), magnitude(values) ** 2);
        },
      ),
    );
  });

  it("is undefined where the divisor would be zero", () => {
    expect(variance([], "population")).toBeNull();
    expect(variance([3], "sample")).toBeNull();
    expect(variance([3], "population")).toBe(0);
  });
});

/** Points with at least two distinct x values, so a slope exists. */
const pointsArb = fc
  .array(
    fc.record({
      x: fc.integer({ min: -400, max: 400 }),
      y: valueArb,
    }),
    { minLength: 2, maxLength: 50 },
  )
  .filter((ps) => new Set(ps.map((p) => p.x)).size >= 2);

describe("least-squares line", () => {
  it("does not depend on the order of the points", () => {
    assertProperty(
      fc.property(pointsArb, (points) => {
        const fit = linearFit(
          points.map((p) => p.x),
          points.map((p) => p.y),
        )!;
        const reversed = [...points].reverse();
        const again = linearFit(
          reversed.map((p) => p.x),
          reversed.map((p) => p.y),
        )!;
        close(again.slope, fit.slope, magnitude(points.map((p) => p.y)));
        close(
          again.intercept,
          fit.intercept,
          magnitude(points.map((p) => p.y)),
        );
      }),
    );
  });

  it("recovers an exact line, and an affine change of y changes the fit the same way", () => {
    assertProperty(
      fc.property(
        fc.uniqueArray(fc.integer({ min: -400, max: 400 }), {
          minLength: 2,
          maxLength: 40,
        }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (xs, slope, intercept) => {
          const ys = xs.map((x) => slope * x + intercept);
          const fit = linearFit(xs, ys)!;
          const scale = Math.abs(intercept) + Math.abs(slope) * 400;
          close(fit.slope, slope, scale);
          close(fit.intercept, intercept, scale);
          // The mean point lies on the fitted line.
          close(fit.intercept + fit.slope * fit.meanX, fit.meanY, scale);
        },
      ),
    );
  });

  it("composes from stored sums exactly as from the points", () => {
    assertProperty(
      fc.property(pointsArb, (points) => {
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        expect(fitFromSums(sumsOf(xs, ys))).toEqual(linearFit(xs, ys));
      }),
    );
  });

  it("keeps r² within [0, 1] when y varies", () => {
    assertProperty(
      fc.property(pointsArb, (points) => {
        const fit = linearFit(
          points.map((p) => p.x),
          points.map((p) => p.y),
        )!;
        if (fit.r2 === null) {
          expect(fit.syy).toBe(0);
          return;
        }
        expect(fit.r2).toBeGreaterThanOrEqual(0);
        expect(fit.r2).toBeLessThanOrEqual(1);
      }),
    );
  });

  // Shrunk counterexamples of the property above from two nightly seeds
  // (802398975 and 1070990592): two points on a line far from zero, where
  // the centred sums rounded r² above 1.
  it.each([
    [
      [0, 1],
      [-999.87, -999.97],
    ],
    [
      [0, -1],
      [9996.28, 9993.55],
    ],
  ])("keeps r² at most 1 for x %j, y %j", (xs, ys) => {
    const fit = linearFit(xs, ys)!;
    expect(fit.r2).not.toBeNull();
    expect(fit.r2!).toBeLessThanOrEqual(1);
    expect(fit.r2!).toBeGreaterThan(0.999);
  });

  it("refuses a vertical line instead of inventing a slope", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: -400, max: 400 }),
        fc.array(valueArb, { minLength: 2, maxLength: 20 }),
        (x, ys) => {
          expect(
            linearFit(
              ys.map(() => x),
              ys,
            ),
          ).toBeNull();
        },
      ),
    );
  });
});

describe("segmented regression and its Newey-West lag", () => {
  it("never lets the lag rule go down as the series grows, and applies at least a week", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 5, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (n, extra) => {
          expect(neweyWestLag(n + extra)).toBeGreaterThanOrEqual(
            neweyWestLag(n),
          );
          expect(defaultHacLag(n)).toBeGreaterThanOrEqual(MIN_HAC_LAG);
          expect(defaultHacLag(n)).toBeGreaterThanOrEqual(neweyWestLag(n));
        },
      ),
    );
  });

  it("recovers a noiseless interrupted line with intervals that contain the estimates", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 12, max: 60 }),
        fc.integer({ min: 12, max: 60 }),
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -2, max: 2, noNaN: true }),
        (before, after, intercept, preSlope, levelChange, slopeChange) => {
          const points = [];
          for (let t = -before; t < after; t++) {
            const d = t >= 0 ? 1 : 0;
            points.push({
              t,
              y:
                intercept +
                preSlope * t +
                levelChange * d +
                slopeChange * t * d,
            });
          }
          const fit = fitSegmentedRegression(points)!;
          expect(fit).not.toBeNull();
          const scale = 100;
          close(fit.intercept.estimate, intercept, scale);
          close(fit.preSlope.estimate, preSlope, scale);
          close(fit.levelChange.estimate, levelChange, scale);
          close(fit.slopeChange.estimate, slopeChange, scale);
          for (const c of [
            fit.intercept,
            fit.preSlope,
            fit.levelChange,
            fit.slopeChange,
          ]) {
            expect(c.ciLow).toBeLessThanOrEqual(c.estimate);
            expect(c.estimate).toBeLessThanOrEqual(c.ciHigh);
            expect(c.standardError).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      60,
    );
  });

  it("refuses a design with no points after the change", () => {
    assertProperty(
      fc.property(fc.array(valueArb, { minLength: 6, maxLength: 30 }), (ys) => {
        const points = ys.map((y, i) => ({ t: -(i + 1), y }));
        expect(fitSegmentedRegression(points)).toBeNull();
      }),
    );
  });
});

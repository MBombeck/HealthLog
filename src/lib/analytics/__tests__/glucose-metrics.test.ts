/**
 * Known-value pins for the glucose clinical-metrics core.
 *
 * Worked examples are computed straight from the cited primary literature:
 *   Battelino 2019 (TIR bands), Bergenstal 2018 (GMI), Nathan 2008 (eA1C),
 *   Monnier 2017 (CV% 36% cutoff). The numbers below are the formulas applied
 *   by hand, not back-derived from the implementation.
 */
import { describe, expect, it } from "vitest";
import {
  CV_INSTABILITY_THRESHOLD,
  DEFAULT_WINDOW_DAYS,
  bloodGlucoseRiskIndices,
  computeGlucoseClinicalMetrics,
  estimatedA1c,
  glucoseSD,
  glucoseVariability,
  gmi,
  jIndex,
  timeInRange,
  type GlucoseReading,
} from "../glucose-metrics";

const DAY = 24 * 60 * 60 * 1000;

/** Build readings spaced one per day ending at `anchor`. */
function dailyReadings(values: number[], anchor: Date): GlucoseReading[] {
  return values.map((mgdl, i) => ({
    mgdl,
    // oldest first, newest = anchor
    measuredAt: new Date(anchor.getTime() - (values.length - 1 - i) * DAY),
  }));
}

describe("gmi (Bergenstal 2018)", () => {
  it("maps a mean of 154 mg/dL to ~6.99%", () => {
    // 3.31 + 0.02392 * 154 = 6.99368
    expect(gmi(154)).toBeCloseTo(6.99368, 5);
  });

  it("maps a mean of 100 mg/dL to 5.702%", () => {
    expect(gmi(100)).toBeCloseTo(5.702, 5);
  });
});

describe("estimatedA1c (Nathan 2008 ADAG inverse)", () => {
  it("maps a mean of 154 mg/dL to ~6.99%", () => {
    // (154 + 46.7) / 28.7 = 6.99303...
    expect(estimatedA1c(154)).toBeCloseTo(6.99303, 4);
  });

  it("maps a mean of 100 mg/dL to ~5.11%", () => {
    // (100 + 46.7) / 28.7 = 5.11149...
    expect(estimatedA1c(100)).toBeCloseTo(5.11149, 4);
  });
});

describe("glucoseSD", () => {
  it("returns null for fewer than two values", () => {
    expect(glucoseSD([])).toBeNull();
    expect(glucoseSD([120])).toBeNull();
  });

  it("computes the sample (n-1) standard deviation", () => {
    // values 2,4,4,4,5,5,7,9 → mean 5, sample SD = sqrt(32/7) = 2.13809
    expect(glucoseSD([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
  });
});

describe("glucoseVariability (Monnier 2017 CV cutoff)", () => {
  it("flags instability at CV ≥ 36%", () => {
    // mean 100, SD 36 → CV exactly 36 → unstable (>=)
    const v = glucoseVariability([136, 64, 100]);
    // mean = 100; SD of {136,64,100} = sqrt(((36^2)+(36^2)+0)/2) = 36
    expect(v).not.toBeNull();
    expect(v!.cv).toBeCloseTo(36, 6);
    expect(v!.unstable).toBe(true);
    expect(CV_INSTABILITY_THRESHOLD).toBe(36);
  });

  it("does not flag a stable low-variability set", () => {
    const v = glucoseVariability([100, 102, 98, 101, 99]);
    expect(v!.unstable).toBe(false);
    expect(v!.cv).toBeLessThan(36);
  });
});

describe("timeInRange (Battelino 2019 bands)", () => {
  it("returns null for an empty set", () => {
    expect(timeInRange([])).toBeNull();
  });

  it("computes exact per-band fractions with nested level-2 sub-bands", () => {
    // 10 readings:
    //  40   → <54 and <70  (TBR2 + TBR1)
    //  60   → <70 only     (TBR1)
    //  70,120,150,180 → in range (4)
    //  200,210 → >180 only (TAR1)
    //  300   → >250 and >180 (TAR2 + TAR1)
    const d = timeInRange([40, 60, 70, 120, 150, 180, 200, 210, 300, 90]);
    expect(d).not.toBeNull();
    // in range: 70,120,150,180,90 = 5
    expect(d!.tir).toBeCloseTo(0.5, 10);
    // <70: 40,60 = 2
    expect(d!.tbrLevel1).toBeCloseTo(0.2, 10);
    // <54: 40 = 1
    expect(d!.tbrLevel2).toBeCloseTo(0.1, 10);
    // >180: 200,210,300 = 3
    expect(d!.tarLevel1).toBeCloseTo(0.3, 10);
    // >250: 300 = 1
    expect(d!.tarLevel2).toBeCloseTo(0.1, 10);
  });

  it("treats the band edges 70 and 180 as in range, 54 as below", () => {
    const d = timeInRange([54, 70, 180, 181, 69]);
    // in range: 70,180 = 2/5
    expect(d!.tir).toBeCloseTo(0.4, 10);
    // <70: 54,69 = 2/5
    expect(d!.tbrLevel1).toBeCloseTo(0.4, 10);
    // <54: none (54 is not < 54)
    expect(d!.tbrLevel2).toBe(0);
    // >180: 181 = 1/5
    expect(d!.tarLevel1).toBeCloseTo(0.2, 10);
  });

  it("emits minutes-of-a-day equivalents (fraction × 1440)", () => {
    const d = timeInRange([100, 100, 100, 300]); // 3 in range, 1 above
    expect(d!.minutesEquivalent.tir).toBeCloseTo(0.75 * 1440, 6);
    expect(d!.minutesEquivalent.tarLevel1).toBeCloseTo(0.25 * 1440, 6);
  });
});

describe("jIndex (Wojcicki 1995)", () => {
  it("returns null for fewer than two values", () => {
    expect(jIndex([])).toBeNull();
    expect(jIndex([120])).toBeNull();
  });

  it("folds mean + SD: J = 0.001 × (mean + SD)²", () => {
    // 14 identical 154 readings → SD 0 → J = 0.001 × 154² = 23.716
    expect(jIndex(Array.from({ length: 14 }, () => 154))).toBeCloseTo(
      23.716,
      3,
    );
    // {100,110,120,130,140}: mean 120, sample SD √250 = 15.81139 →
    // J = 0.001 × 135.81139² = 18.444733
    expect(jIndex([100, 110, 120, 130, 140])).toBeCloseTo(18.444733, 5);
  });
});

describe("bloodGlucoseRiskIndices (Kovatchev 1997/2006)", () => {
  it("returns null when no usable reading remains", () => {
    expect(bloodGlucoseRiskIndices([])).toBeNull();
    // non-positive / non-finite readings are skipped (ln undefined)
    expect(bloodGlucoseRiskIndices([0, -5, NaN])).toBeNull();
  });

  it("splits a low/high pair onto the correct branches", () => {
    // f(50) = -1.500015 → low branch r = 22.500445
    // f(300) = 1.842607 → high branch r = 33.951988
    // n = 2 → LBGI = 22.500445/2 = 11.250223, HBGI = 33.951988/2 = 16.975994
    const r = bloodGlucoseRiskIndices([50, 300]);
    expect(r).not.toBeNull();
    expect(r!.lbgi).toBeCloseTo(11.250223, 5);
    expect(r!.hbgi).toBeCloseTo(16.975994, 5);
  });

  it("reads near-zero hypo risk and zero hyper risk for a stable normoglycaemic set", () => {
    // every reading sits below the ~112.5 symmetrization centre, so HBGI = 0
    const r = bloodGlucoseRiskIndices([100, 110, 95, 105, 100]);
    expect(r!.hbgi).toBe(0);
    expect(r!.lbgi).toBeCloseTo(0.427869, 5);
    // minimal-risk band (< 1.1)
    expect(r!.lbgi).toBeLessThan(1.1);
  });
});

describe("computeGlucoseClinicalMetrics — window + adequacy", () => {
  const now = new Date("2026-06-14T12:00:00Z");

  it("defaults to a 14-day window", () => {
    const m = computeGlucoseClinicalMetrics([], { now });
    expect(m.windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(DEFAULT_WINDOW_DAYS).toBe(14);
  });

  it("excludes readings older than the window", () => {
    const readings: GlucoseReading[] = [
      { mgdl: 120, measuredAt: new Date(now.getTime() - 2 * DAY) },
      { mgdl: 130, measuredAt: new Date(now.getTime() - 20 * DAY) }, // out
    ];
    const m = computeGlucoseClinicalMetrics(readings, { now });
    expect(m.readingCount).toBe(1);
  });

  it("ignores non-finite values", () => {
    const readings: GlucoseReading[] = [
      { mgdl: 120, measuredAt: new Date(now.getTime() - 1 * DAY) },
      { mgdl: NaN, measuredAt: new Date(now.getTime() - 2 * DAY) },
    ];
    const m = computeGlucoseClinicalMetrics(readings, { now });
    expect(m.readingCount).toBe(1);
  });

  it("excludes non-positive readings so every index shares one denominator", () => {
    // a 0 / negative glucose is non-physiological and ln-undefined; it must be
    // dropped from readingCount AND from the risk-index denominator so the
    // advanced indices never use a different N than mean / TIR.
    const readings: GlucoseReading[] = [
      { mgdl: 120, measuredAt: new Date(now.getTime() - 1 * DAY) },
      { mgdl: 0, measuredAt: new Date(now.getTime() - 2 * DAY) },
      { mgdl: -5, measuredAt: new Date(now.getTime() - 3 * DAY) },
    ];
    const m = computeGlucoseClinicalMetrics(readings, {
      now,
      minReadings: 1,
      minSpanDays: 0,
    });
    expect(m.readingCount).toBe(1);
    expect(m.meanMgdl).toBe(120);
    // advanced indices resolve from the single usable reading
    expect(m.advanced).not.toBeNull();
  });

  describe("isSpotEstimate — density-derived", () => {
    it("marks sparse spot data as a spot estimate (one reading/day)", () => {
      // 14 readings across 14 days = 1/day, far below the hourly CGM bar.
      const m = computeGlucoseClinicalMetrics(
        dailyReadings(Array(14).fill(120), now),
        { now },
      );
      expect(m.readingCount).toBe(14);
      expect(m.isSpotEstimate).toBe(true);
    });

    it("marks a dense CGM-density stream as continuous (false)", () => {
      // ~288 readings/day over 2 days, every 5 minutes — a Nightscout CGM.
      const FIVE_MIN = 5 * 60 * 1000;
      const total = 2 * 288;
      const readings: GlucoseReading[] = Array.from(
        { length: total },
        (_, i) => ({
          mgdl: 110,
          measuredAt: new Date(now.getTime() - (total - 1 - i) * FIVE_MIN),
        }),
      );
      const m = computeGlucoseClinicalMetrics(readings, { now });
      expect(m.readingCount).toBe(total);
      expect(m.isSpotEstimate).toBe(false);
    });

    it("does not let a single-day burst masquerade as continuous", () => {
      // 30 readings all inside one day → span floors at 1 day, so density is
      // 30/day. That clears the bar legitimately, but a handful in a day must
      // not: 10 readings in one day = 10/day < 24 → still a spot estimate.
      const HOUR = 60 * 60 * 1000;
      const readings: GlucoseReading[] = Array.from({ length: 10 }, (_, i) => ({
        mgdl: 115,
        measuredAt: new Date(now.getTime() - i * HOUR),
      }));
      const m = computeGlucoseClinicalMetrics(readings, { now });
      expect(m.isSpotEstimate).toBe(true);
    });
  });

  describe("learning gate", () => {
    it("fires when there are no readings", () => {
      const m = computeGlucoseClinicalMetrics([], { now });
      expect(m.stillLearning).toBe(true);
      expect(m.stillLearningReason).toMatch(/no glucose readings/i);
      expect(m.meanMgdl).toBeNull();
      expect(m.distribution).toBeNull();
      expect(m.gmi).toBeNull();
      expect(m.estimatedA1c).toBeNull();
      expect(m.variability).toBeNull();
      expect(m.advanced).toBeNull();
    });

    it("fires below the minimum reading count, reporting N and D", () => {
      // 5 readings across 5 days — below the default 14-reading floor
      const m = computeGlucoseClinicalMetrics(
        dailyReadings([100, 110, 120, 130, 140], now),
        { now },
      );
      expect(m.stillLearning).toBe(true);
      expect(m.stillLearningReason).toMatch(/5 readings over 4 days/);
      expect(m.readingCount).toBe(5);
      // numbers are still populated for a calm preview
      expect(m.meanMgdl).toBeCloseTo(120, 6);
      expect(m.distribution).not.toBeNull();
    });

    it("fires when the span is too short even with enough readings", () => {
      // 16 readings all within a single day → span < 7 days
      const values = Array.from({ length: 16 }, (_, i) => 100 + i);
      const readings: GlucoseReading[] = values.map((mgdl, i) => ({
        mgdl,
        measuredAt: new Date(now.getTime() - i * 60 * 60 * 1000), // hourly
      }));
      const m = computeGlucoseClinicalMetrics(readings, { now });
      expect(m.readingCount).toBe(16);
      expect(m.stillLearning).toBe(true);
      expect(m.stillLearningReason).toMatch(/span only/i);
    });

    it("clears above both thresholds and asserts the panel", () => {
      // 14 readings, one per day → 13-day span, count 14
      const values = Array.from({ length: 14 }, () => 154);
      const m = computeGlucoseClinicalMetrics(dailyReadings(values, now), {
        now,
      });
      expect(m.readingCount).toBe(14);
      expect(m.actualSpanDays).toBeCloseTo(13, 6);
      expect(m.stillLearning).toBe(false);
      expect(m.stillLearningReason).toBeNull();
      // mean 154 → GMI ~6.99, eA1C ~6.99
      expect(m.meanMgdl).toBeCloseTo(154, 6);
      expect(m.gmi).toBeCloseTo(6.99368, 5);
      expect(m.estimatedA1c).toBeCloseTo(6.99303, 4);
      expect(m.distribution!.tir).toBeCloseTo(1, 10); // all in range
      expect(m.variability!.sd).toBe(0);
      expect(m.variability!.unstable).toBe(false);
      // advanced tier: J-index from mean+SD, LBGI/HBGI from the risk model.
      // mean 154, SD 0 → J = 0.001 × 154² = 23.716.
      expect(m.advanced).not.toBeNull();
      expect(m.advanced!.jIndex).toBeCloseTo(23.716, 3);
      // 154 mg/dL sits above the symmetrization centre → all hyper risk,
      // zero hypo risk.
      expect(m.advanced!.lbgi).toBe(0);
      expect(m.advanced!.hbgi).toBeGreaterThan(0);
    });

    it("resolves LBGI/HBGI but holds J-index null for a single reading", () => {
      const m = computeGlucoseClinicalMetrics(dailyReadings([100], now), {
        now,
      });
      expect(m.advanced).not.toBeNull();
      // one reading → sample SD undefined → J held null
      expect(m.advanced!.jIndex).toBeNull();
      // the risk indices still resolve from the lone reading
      expect(m.advanced!.hbgi).toBe(0);
      expect(m.advanced!.lbgi).toBeGreaterThan(0);
    });

    it("honours configurable thresholds", () => {
      const m = computeGlucoseClinicalMetrics(
        dailyReadings([100, 110, 120], now),
        { now, minReadings: 3, minSpanDays: 2 },
      );
      // 3 readings over a 2-day span clears the lowered bars
      expect(m.stillLearning).toBe(false);
    });
  });
});

describe("computeGlucoseClinicalMetrics — platform-stable variability indices", () => {
  const now = new Date("2026-06-14T12:00:00Z");
  // A mixed hypo / hyper fortnight, two readings a day. Spread across both
  // Kovatchev branches so LBGI and HBGI each sum many fractional risks.
  const VALUES = [
    48.6, 212.4, 63.9, 187.2, 101.3, 254.8, 71.1, 143.7, 55.5, 302.6, 88.8,
    176.4, 67.2, 229.9, 94.1, 161.6, 52.3, 278.5, 110.7, 198.0, 59.4, 241.3,
    83.6, 132.9, 46.8, 266.2, 99.9, 184.5,
  ];
  const readings: GlucoseReading[] = VALUES.map((mgdl, i) => ({
    mgdl,
    measuredAt: new Date(now.getTime() - (VALUES.length - i) * (DAY / 2)),
  }));

  function indices(m: ReturnType<typeof computeGlucoseClinicalMetrics>) {
    return { variability: m.variability, advanced: m.advanced };
  }

  it("serves the same figures whatever last bits the maths library returns", () => {
    // Math.pow with a fractional exponent returns different last bits on
    // Node 22 than on Node 24 and later (Math.exp and Math.log do not), and a
    // Postgres or libm on another platform may differ again. Nudging every
    // transcendental result by a few ulps stands in for that platform.
    const baseline = indices(computeGlucoseClinicalMetrics(readings, { now }));
    const nudge = 1 + 4 * Number.EPSILON;
    const pow = Math.pow;
    const exp = Math.exp;
    const log = Math.log;
    try {
      Math.pow = (x: number, y: number) => pow(x, y) * nudge;
      Math.exp = (x: number) => exp(x) * nudge;
      Math.log = (x: number) => log(x) * nudge;
      const nudged = indices(computeGlucoseClinicalMetrics(readings, { now }));
      expect(nudged).toEqual(baseline);
    } finally {
      Math.pow = pow;
      Math.exp = exp;
      Math.log = log;
    }
  });

  it("serves the same figures when tied readings arrive in another order", () => {
    // Readings that share a timestamp keep the order the database returned,
    // which is not fixed, so the sums must not depend on it.
    const tied = VALUES.map((mgdl) => ({
      mgdl,
      measuredAt: new Date(now.getTime() - DAY),
    }));
    const forward = indices(computeGlucoseClinicalMetrics(tied, { now }));
    const backward = indices(
      computeGlucoseClinicalMetrics([...tied].reverse(), { now }),
    );
    expect(backward).toEqual(forward);
  });

  it("pins the served figures to four decimals on every platform", () => {
    // Node 22 and Node 26 served different last digits for these before the
    // transform left Math.pow; both now serve exactly these.
    const m = computeGlucoseClinicalMetrics(readings, { now });
    expect(indices(m)).toEqual({
      variability: { sd: 80.164, cv: 55.9302, unstable: true },
      advanced: { jIndex: 49.9489, lbgi: 4.8558, hbgi: 7.4761 },
    });
  });
});

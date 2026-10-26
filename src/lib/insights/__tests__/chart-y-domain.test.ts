import { describe, expect, it } from "vitest";

import { computePaddedYDomain, niceYAxis } from "@/lib/insights/chart-y-domain";

describe("computePaddedYDomain", () => {
  it("returns undefined for an empty series", () => {
    expect(computePaddedYDomain([])).toBeUndefined();
  });

  it("ignores non-finite values", () => {
    expect(computePaddedYDomain([NaN, Infinity, -Infinity])).toBeUndefined();
  });

  it("clamps the lower bound to 0 for a non-negative series", () => {
    const domain = computePaddedYDomain([200, 450, 900]);
    expect(domain).toBeDefined();
    const [min, max] = domain!;
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeGreaterThan(900);
  });

  it("clamps to 0 when bottom padding would dip below 0 (steps-like series)", () => {
    // span 8800 → 8% bottom padding = 704 > min 200 → unclamped would be -504
    const domain = computePaddedYDomain([200, 9000]);
    expect(domain).toBeDefined();
    expect(domain![0]).toBe(0);
  });

  it("keeps downward padding for a series with genuine negative values", () => {
    const domain = computePaddedYDomain([-5, 3, 10]);
    expect(domain).toBeDefined();
    const [min, max] = domain!;
    expect(min).toBeLessThan(-5);
    expect(max).toBeGreaterThan(10);
  });

  it("pads a positive series without touching 0 when padding stays above it", () => {
    // span 2 → bottom padding max(0.16, 0.5) = 0.5 → 79.5, no clamp needed
    const domain = computePaddedYDomain([80, 82]);
    expect(domain).toBeDefined();
    expect(domain![0]).toBeCloseTo(79.5);
  });

  it("clamps a flat zero series to a [0, x] domain", () => {
    const domain = computePaddedYDomain([0, 0, 0]);
    expect(domain).toBeDefined();
    const [min, max] = domain!;
    expect(min).toBe(0);
    expect(max).toBeGreaterThan(0);
  });

  it("keeps the symmetric flat-series padding for negative flat series", () => {
    const domain = computePaddedYDomain([-10, -10]);
    expect(domain).toBeDefined();
    expect(domain![0]).toBeLessThan(-10);
  });
});

describe("niceYAxis", () => {
  /** Every gap the same, every tick a multiple of the step. */
  function expectEven(ticks: number[]) {
    const gaps = ticks
      .slice(1)
      .map((t, i) => Number((t - ticks[i]!).toFixed(9)));
    expect(new Set(gaps).size).toBe(1);
    const step = gaps[0]!;
    for (const tick of ticks) {
      expect(Math.abs(tick / step - Math.round(tick / step))).toBeLessThan(
        1e-9,
      );
    }
    return step;
  }

  it("turns the reported blood-pressure axis into round, even ticks", () => {
    // Recharts drew 74, 94, 114, 134, 149 from this padded domain: the last
    // step 15 against 20, the upper bound forced in as a tick.
    const { domain, ticks } = niceYAxis([73.4, 149.2]);
    expect(ticks).toEqual([60, 80, 100, 120, 140, 160]);
    expect(domain).toEqual([60, 160]);
    expect(expectEven(ticks)).toBe(20);
  });

  it("covers the padded domain and stays within six labels", () => {
    for (const [low, high] of [
      [0, 1],
      [61.2, 63.9],
      [0, 10234],
      [35.9, 37.4],
      [-3.2, 4.8],
      [92, 99],
      [4.1, 8.7],
    ] as const) {
      const { domain, ticks } = niceYAxis([low, high]);
      expect(domain[0]).toBeLessThanOrEqual(low);
      expect(domain[1]).toBeGreaterThanOrEqual(high);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks[0]).toBe(domain[0]);
      expect(ticks[ticks.length - 1]).toBe(domain[1]);
      const step = expectEven(ticks);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 5]).toContain(Number(mantissa.toFixed(6)));
    }
  });

  it("keeps a non-negative domain non-negative and decimals clean", () => {
    expect(niceYAxis([0.2, 9.6]).domain[0]).toBe(0);
    const { ticks } = niceYAxis([35.9, 37.4]);
    for (const tick of ticks) expect(String(tick)).not.toMatch(/\d{4,}$/);
  });

  it("leaves a degenerate domain alone", () => {
    expect(niceYAxis([5, 5])).toEqual({ domain: [5, 5], ticks: [5, 5] });
  });
});

import { describe, expect, it } from "vitest";

import { bucketTimeSeries, type BucketInputPoint } from "../bucket-time-series";
import { pickRangeBucket } from "../range-grain";

const dayMs = 24 * 60 * 60 * 1000;

/** The All tab's grain for `points`, as the charts pass it in. */
const allGrain = (points: BucketInputPoint[]) =>
  pickRangeBucket(
    0,
    points.map((p) => Number(p.timestamp)),
  );

function dailyAt(start: Date, day: number, value: number): BucketInputPoint {
  return {
    timestamp: start.getTime() + day * dayMs,
    values: { weight: value },
  };
}

// These expectations were always Berlin's — the module used to hard-code it,
// so the tests read as timezone-agnostic while quietly depending on one. Now
// that the boundary calendar is a parameter, the assumption is written down
// rather than implied.
const BERLIN = "Europe/Berlin";

describe("the boundary calendar is the caller's, not Berlin's", () => {
  // 2025-03-31T16:00Z is 18:00 on 31 March in Berlin (UTC+2, summer time is
  // already in force) and 01:00 on 1 April in Tokyo (UTC+9). Which month bar
  // this reading lands in is decided by the calendar the caller names, and
  // until now the caller could not name one: every chart bucketed everyone's
  // readings into Berlin's months.
  const lateEvening = new Date("2025-03-31T16:00:00Z");
  const points = [{ timestamp: lateEvening, values: { v: 1 } }];

  it("puts a late-evening reading in March for Berlin", () => {
    const out = bucketTimeSeries(points, {
      bucket: "month",
      timeZone: "Europe/Berlin",
    });
    expect(new Date(out.points[0].timestamp).toISOString()).toBe(
      "2025-03-01T00:00:00.000Z",
    );
  });

  it("puts the same instant in April for Tokyo", () => {
    const out = bucketTimeSeries(points, {
      bucket: "month",
      timeZone: "Asia/Tokyo",
    });
    expect(new Date(out.points[0].timestamp).toISOString()).toBe(
      "2025-04-01T00:00:00.000Z",
    );
  });

  it("moves the ISO week too, not only the month", () => {
    // A separate instant, because the month fixture above does not serve
    // here: 31 March 2025 is a Monday in Berlin and 1 April a Tuesday in
    // Tokyo, which is the SAME ISO week. The week boundary only moves when
    // one side is still Sunday while the other is already Monday.
    // 2025-03-30T16:00Z is Sunday 18:00 in Berlin and Monday 01:00 in Tokyo.
    const sundayEvening = [
      { timestamp: new Date("2025-03-30T16:00:00Z"), values: { v: 1 } },
    ];
    const berlin = bucketTimeSeries(sundayEvening, {
      bucket: "week",
      timeZone: "Europe/Berlin",
    });
    const tokyo = bucketTimeSeries(sundayEvening, {
      bucket: "week",
      timeZone: "Asia/Tokyo",
    });
    expect(new Date(berlin.points[0].timestamp).toISOString()).toBe(
      "2025-03-24T00:00:00.000Z",
    );
    expect(new Date(tokyo.points[0].timestamp).toISOString()).toBe(
      "2025-03-31T00:00:00.000Z",
    );
  });
});

describe("bucketTimeSeries()", () => {
  const start = new Date("2025-01-06T00:00:00Z"); // Monday

  it("preserves daily granularity for ranges <= 90 days", () => {
    const points = [0, 1, 2, 30, 89].map((d) => dailyAt(start, d, 80 + d));
    const result = bucketTimeSeries(points, {
      bucket: allGrain(points),
      timeZone: BERLIN,
    });
    expect(result.bucket).toBe("day");
    expect(result.points).toHaveLength(5);
  });

  it("rolls 91-730 days into ISO weekly buckets", () => {
    // 200-day window with one observation per day → ~28 weekly buckets.
    const points = Array.from({ length: 200 }, (_, i) =>
      dailyAt(start, i, 80 + (i % 5)),
    );
    const result = bucketTimeSeries(points, {
      bucket: allGrain(points),
      timeZone: BERLIN,
    });
    expect(result.bucket).toBe("week");
    // 200 / 7 ≈ 28.5 — first/last weeks may be partial → 29 distinct keys.
    expect(result.points.length).toBeGreaterThanOrEqual(28);
    expect(result.points.length).toBeLessThanOrEqual(30);
    // Means must use only days that had data (no zero-pad).
    expect(
      result.points.every((p) => Object.values(p.values).every((v) => v >= 80)),
    ).toBe(true);
  });

  it("rolls > 730 days into Berlin-calendar monthly buckets", () => {
    // 800 daily points, value = 100.
    const points = Array.from({ length: 800 }, (_, i) =>
      dailyAt(start, i, 100),
    );
    const result = bucketTimeSeries(points, {
      bucket: allGrain(points),
      timeZone: BERLIN,
    });
    expect(result.bucket).toBe("month");
    // ~26 calendar months
    expect(result.points.length).toBeGreaterThanOrEqual(25);
    expect(result.points.length).toBeLessThanOrEqual(28);
    // Mean of constant series stays constant.
    expect(result.points.every((p) => p.values.weight === 100)).toBe(true);
    // Counts add up to 800.
    const total = result.points.reduce((sum, p) => sum + p.counts.weight, 0);
    expect(total).toBe(800);
  });

  it("skips empty buckets entirely (no zero-baseline)", () => {
    // Two days far apart; the gap weeks must not appear.
    const points: BucketInputPoint[] = [
      { timestamp: start.getTime(), values: { weight: 80 } },
      { timestamp: start.getTime() + 200 * dayMs, values: { weight: 90 } },
    ];
    const result = bucketTimeSeries(points, {
      bucket: "week",
      timeZone: BERLIN,
    });
    expect(result.points).toHaveLength(2);
    expect(result.points.map((p) => p.values.weight)).toEqual([80, 90]);
  });

  it("handles multiple metrics independently", () => {
    const points: BucketInputPoint[] = [
      { timestamp: start.getTime(), values: { sys: 130, dia: 80 } },
      { timestamp: start.getTime() + dayMs, values: { sys: 140 } }, // dia missing
      { timestamp: start.getTime() + 2 * dayMs, values: { dia: 78 } }, // sys missing
    ];
    const result = bucketTimeSeries(points, {
      bucket: "week",
      timeZone: BERLIN,
    });
    expect(result.points).toHaveLength(1);
    const point = result.points[0];
    expect(point.counts.sys).toBe(2);
    expect(point.counts.dia).toBe(2);
    expect(point.values.sys).toBe(135); // (130+140)/2
    expect(point.values.dia).toBe(79); // (80+78)/2
  });

  it("respects the explicit bucket override", () => {
    const points = [0, 1, 2].map((d) => dailyAt(start, d, 80));
    const result = bucketTimeSeries(points, {
      bucket: "month",
      timeZone: BERLIN,
    });
    expect(result.bucket).toBe("month");
    expect(result.points).toHaveLength(1);
  });
});

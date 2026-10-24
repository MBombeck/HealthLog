import { describe, it, expect } from "vitest";

import {
  computeWindowConfidence,
  isTrendWindowSufficient,
  MIN_READINGS_FOR_CONFIDENCE,
  MIN_TREND_DAYS,
  minTrendSpanDays,
  trendEvidenceOf,
} from "../window-confidence";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("computeWindowConfidence", () => {
  it("flags a sample below the floor as insufficient", () => {
    for (const count of [0, 1, 4]) {
      const c = computeWindowConfidence({
        windowDays: 90,
        readingCount: count,
        earliestReadingAt: count === 0 ? null : daysAgo(10),
        now: NOW,
      });
      expect(c.sufficient).toBe(false);
    }
  });

  it("flags a sample at or above the floor as sufficient", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: MIN_READINGS_FOR_CONFIDENCE,
      earliestReadingAt: daysAgo(10),
      now: NOW,
    });
    expect(c.sufficient).toBe(true);
  });

  it("returns a null span when the window is empty", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: 0,
      earliestReadingAt: null,
      now: NOW,
    });
    expect(c.effectiveSpanDays).toBeNull();
  });

  it("reports the real span until history reaches the window", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: 8,
      earliestReadingAt: daysAgo(23),
      now: NOW,
    });
    expect(c.effectiveSpanDays).toBe(23);
  });

  it("caps the span at the window once history exceeds it", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: 120,
      earliestReadingAt: daysAgo(400),
      now: NOW,
    });
    expect(c.effectiveSpanDays).toBe(90);
  });

  it("rounds a same-day-only sample up to one day", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: 5,
      earliestReadingAt: new Date(NOW.getTime() - 60 * 1000),
      now: NOW,
    });
    expect(c.effectiveSpanDays).toBe(1);
  });
});

describe("trend evidence", () => {
  const MINUTE = 60 * 1000;

  it("counts UTC days and the span between the first and the last", () => {
    expect(trendEvidenceOf([])).toEqual({ days: 0, spanDays: 0 });
    // Three readings minutes apart: one day, no span.
    const t = Date.UTC(2026, 5, 14, 8, 0, 0);
    expect(trendEvidenceOf([t, t + 2 * MINUTE, t + 4 * MINUTE])).toEqual({
      days: 1,
      spanDays: 0,
    });
    // Either side of UTC midnight: two days, one apart.
    const midnight = Date.UTC(2026, 5, 14);
    expect(trendEvidenceOf([midnight - MINUTE, midnight + MINUTE])).toEqual({
      days: 2,
      spanDays: 1,
    });
    expect(
      trendEvidenceOf(
        [daysAgo(9), daysAgo(5), daysAgo(5), daysAgo(0)].map((d) =>
          d.getTime(),
        ),
      ),
    ).toEqual({ days: 3, spanDays: 9 });
  });

  it("asks for three days spanning half the window", () => {
    expect(MIN_TREND_DAYS).toBe(3);
    expect(minTrendSpanDays(7)).toBe(4);
    expect(minTrendSpanDays(30)).toBe(15);
    expect(isTrendWindowSufficient({ days: 3, spanDays: 4 }, 7)).toBe(true);
    expect(isTrendWindowSufficient({ days: 2, spanDays: 6 }, 7)).toBe(false);
    expect(isTrendWindowSufficient({ days: 3, spanDays: 3 }, 7)).toBe(false);
    expect(isTrendWindowSufficient({ days: 3, spanDays: 15 }, 30)).toBe(true);
    expect(isTrendWindowSufficient({ days: 20, spanDays: 14 }, 30)).toBe(false);
  });
});

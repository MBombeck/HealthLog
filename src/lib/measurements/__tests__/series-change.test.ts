import { describe, expect, it } from "vitest";

import { resolveTrendVerdict } from "@/lib/targets/trend-verdict";

import {
  computeSeriesChange,
  seriesDayValues,
  seriesReferenceValue,
} from "../series-change";

const TZ = "Europe/Berlin";
const upBad = resolveTrendVerdict("RESTING_HEART_RATE", {
  profile: { dateOfBirth: null, gender: null, heightCm: null },
  thresholdsJson: null,
  referenceValue: null,
  pregnancy: false,
});

describe("seriesDayValues", () => {
  it("sums a summed type per local day and averages the rest", () => {
    const points = [
      { at: "2026-09-01T06:00:00.000Z", value: 1000 },
      { at: "2026-09-01T20:00:00.000Z", value: 2000 },
      // 23:30 UTC is already the next day in Berlin.
      { at: "2026-09-01T23:30:00.000Z", value: 500 },
    ];
    expect(seriesDayValues("ACTIVITY_STEPS", points, TZ)).toEqual([
      { day: "2026-09-01", value: 3000 },
      { day: "2026-09-02", value: 500 },
    ]);
    expect(seriesDayValues("WEIGHT", points, TZ)[0]).toEqual({
      day: "2026-09-01",
      value: 1500,
    });
  });
});

describe("computeSeriesChange", () => {
  it("is null under two days", () => {
    expect(
      computeSeriesChange([{ day: "2026-09-01", value: 60 }], upBad),
    ).toBeNull();
  });

  it("compares the last day with the first and judges the change", () => {
    expect(
      computeSeriesChange(
        [
          { day: "2026-09-01", value: 60 },
          { day: "2026-09-02", value: 70 },
          { day: "2026-09-03", value: 64.123 },
        ],
        upBad,
      ),
    ).toEqual({ from: 60, to: 64.12, delta: 4.12, sentiment: "negative" });
  });
});

describe("seriesReferenceValue", () => {
  it("averages the last seven days", () => {
    const days = Array.from({ length: 10 }, (_, i) => ({
      day: `2026-09-${String(i + 1).padStart(2, "0")}`,
      value: i + 1,
    }));
    expect(seriesReferenceValue(days)).toBe(7);
    expect(seriesReferenceValue([])).toBeNull();
  });
});

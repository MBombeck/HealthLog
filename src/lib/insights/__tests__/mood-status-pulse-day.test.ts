import { describe, expect, it } from "vitest";

import { crossMetricDailySeries } from "../mood-status";

/**
 * The mood correlations pair each mood day with that day's pulse. A pulse
 * day is the mean of its hours' means, so a workout hour of many readings does
 * not decide the value the mood is paired with.
 */
describe("crossMetricDailySeries", () => {
  const now = new Date("2026-03-05T12:00:00Z");
  const workoutDay = [
    ...Array.from({ length: 12 }, (_, i) => ({
      type: "PULSE",
      value: 150,
      measuredAt: new Date(Date.UTC(2026, 2, 3, 10, i * 5)),
    })),
    ...[12, 14, 16].map((h) => ({
      type: "PULSE",
      value: 60,
      measuredAt: new Date(Date.UTC(2026, 2, 3, h)),
    })),
  ];

  it("gives a pulse day the mean of its hours' means", () => {
    const series = crossMetricDailySeries(workoutDay, "PULSE", now, "UTC");
    expect(series.daily.map((d) => d.value)).toEqual([82.5]);
    // The reading count stays.
    expect(series.daily[0].n).toBe(15);
  });

  it("keeps the plain daily mean for every other type", () => {
    const weight = workoutDay.map((m) => ({ ...m, type: "WEIGHT" }));
    const series = crossMetricDailySeries(weight, "WEIGHT", now, "UTC");
    expect(series.daily.map((d) => d.value)).toEqual([132]);
  });
});

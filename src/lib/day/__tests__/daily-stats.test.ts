/**
 * One value per local day (v1.42, #613): a total for a cumulative type, the
 * mean of hourly means for pulse, the plain mean otherwise, and one source
 * per day through the ladder.
 */
import { describe, expect, it } from "vitest";

import { foldDailyStats } from "../daily-stats";

describe("daily stats", () => {
  it("totals a cumulative type and keeps one source per day", () => {
    const stats = foldDailyStats(
      [
        {
          type: "ACTIVITY_STEPS",
          source: "APPLE_HEALTH",
          day: "2026-03-29",
          hour: 0,
          total: 8000,
          count: 1,
        },
        {
          type: "ACTIVITY_STEPS",
          source: "WITHINGS",
          day: "2026-03-29",
          hour: 0,
          total: 7000,
          count: 1,
        },
      ],
      null,
    );
    // One source, never the sum of two.
    expect([8000, 7000]).toContain(
      stats.get("ACTIVITY_STEPS")?.get("2026-03-29"),
    );
  });

  it("weighs every hour of pulse once", () => {
    const stats = foldDailyStats(
      [
        // A workout hour with many readings must not pull the day up.
        {
          type: "PULSE",
          source: "APPLE_HEALTH",
          day: "2026-03-29",
          hour: 7,
          total: 150 * 100,
          count: 100,
        },
        {
          type: "PULSE",
          source: "APPLE_HEALTH",
          day: "2026-03-29",
          hour: 12,
          total: 60 * 2,
          count: 2,
        },
      ],
      null,
    );
    expect(stats.get("PULSE")?.get("2026-03-29")).toBe(105);
  });

  it("means a level type over its readings", () => {
    const stats = foldDailyStats(
      [
        {
          type: "WEIGHT",
          source: "MANUAL",
          day: "2026-03-29",
          hour: 0,
          total: 160,
          count: 2,
        },
      ],
      null,
    );
    expect(stats.get("WEIGHT")?.get("2026-03-29")).toBe(80);
  });
});

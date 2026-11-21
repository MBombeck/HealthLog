import { describe, expect, it } from "vitest";
import {
  makeRangeClassifier,
  rollupConsistency,
  rollupFromDayMap,
} from "../consistency";

const NOW = new Date("2026-07-21T12:00:00.000Z");

describe("target consistency builders", () => {
  it("buckets the strip in the user's timezone and preserves cold-start detail", () => {
    const result = rollupConsistency({
      events: [
        { measuredAt: new Date("2026-07-20T10:00:00.000Z"), value: 5 },
        // Auckland local date is already 21 July at this UTC instant.
        { measuredAt: new Date("2026-07-20T13:00:00.000Z"), value: 12 },
      ],
      classify: makeRangeClassifier({ min: 0, max: 10 }),
      timezone: "Pacific/Auckland",
      now: new Date("2026-07-21T00:00:00.000Z"),
    });

    expect(result).toEqual({
      daysInRange7d: 1,
      daysLogged7d: 2,
      daysInRange30d: 0,
      daysLogged30d: 0,
      lastMetGoalAt: null,
      streakDays: 0,
      insufficientData: true,
      consistency7d: [null, null, null, null, null, "in", "near"],
    });
  });

  it("rolls day-level bands into counts, recency, and a current streak", () => {
    const result = rollupFromDayMap({
      dayBandByKey: new Map([
        ["2026-07-19", "near"],
        ["2026-07-20", "in"],
        ["2026-07-21", "in"],
      ]),
      timezone: "UTC",
      now: NOW,
    });

    expect(result).toEqual({
      daysInRange7d: 2,
      daysLogged7d: 3,
      daysInRange30d: 2,
      daysLogged30d: 3,
      lastMetGoalAt: "2026-07-21",
      streakDays: 2,
      insufficientData: false,
      consistency7d: [null, null, null, null, "near", "in", "in"],
    });
  });

  it("walks local calendar days across a 23-hour day", () => {
    // Monday 2026-03-30 00:30 CEST, right after the 23-hour Sunday. Stepping
    // back 24 hours from here lands on Saturday and skips Sunday.
    const result = rollupFromDayMap({
      dayBandByKey: new Map([
        ["2026-03-27", "in"],
        ["2026-03-28", "in"],
        ["2026-03-29", "in"],
        ["2026-03-30", "in"],
      ]),
      timezone: "Europe/Berlin",
      now: new Date("2026-03-29T22:30:00.000Z"),
    });

    expect(result.streakDays).toBe(4);
    expect(result.daysInRange7d).toBe(4);
    expect(result.consistency7d).toEqual([
      null,
      null,
      null,
      "in",
      "in",
      "in",
      "in",
    ]);
  });
});

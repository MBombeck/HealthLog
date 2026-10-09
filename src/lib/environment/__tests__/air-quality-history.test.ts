/**
 * v1.42 — the air-quality history backfill's pure parts: how pending days
 * are cut into request ranges, what a range weighs, the ceilings that keep
 * the history from taking the nightly fetch's room, where a day without a
 * row is placed, and when an account is offered a run again.
 */
import { describe, expect, it } from "vitest";

import {
  AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS,
  historyRangeWeight,
  historyRequestFits,
  planHistoryRanges,
  readAirQualityHistoryState,
  resolveHistoryLocation,
} from "../air-quality-history";
import { historyDue } from "@/lib/jobs/environment-air-quality-history";
import { shiftDateKey } from "@/lib/tz/format";

function daysFrom(start: string, count: number, step = 1): string[] {
  return Array.from({ length: count }, (_, i) => shiftDateKey(start, i * step));
}

describe("planHistoryRanges", () => {
  it("joins days up to 14 apart into one range and splits on a longer gap", () => {
    const ranges = planHistoryRanges([
      "2024-01-01",
      "2024-01-15", // 14 days later: joined
      "2024-01-30", // 15 days later: new range
      "2024-01-31",
    ]);
    expect(ranges.map((r) => [r.startDate, r.endDate, r.days.length])).toEqual([
      ["2024-01-01", "2024-01-15", 2],
      ["2024-01-30", "2024-01-31", 2],
    ]);
  });

  it("never lets a range grow past 90 days", () => {
    const ranges = planHistoryRanges(daysFrom("2023-01-01", 200));
    expect(ranges).toHaveLength(3);
    for (const r of ranges) {
      expect(shiftDateKey(r.startDate, 89) >= r.endDate).toBe(true);
    }
    expect(ranges.flatMap((r) => r.days)).toHaveLength(200);
  });

  it("sorts and de-duplicates its input", () => {
    const ranges = planHistoryRanges([
      "2024-03-02",
      "2024-03-01",
      "2024-03-02",
    ]);
    expect(ranges).toEqual([
      {
        startDate: "2024-03-01",
        endDate: "2024-03-02",
        days: ["2024-03-01", "2024-03-02"],
      },
    ]);
  });

  it("spends fewer calls on a sparse history than one request per day", () => {
    // A day every three days for a year: 122 days.
    const days = daysFrom("2023-01-01", 122, 3);
    const ranges = planHistoryRanges(days);
    const ranged = ranges.reduce(
      (sum, r) => sum + historyRangeWeight(r, []),
      0,
    );
    const perDay =
      days.length *
      historyRangeWeight(
        { startDate: days[0], endDate: days[0], days: [days[0]] },
        [],
      );
    expect(ranged).toBeLessThan(perDay / 4);
  });
});

describe("historyRangeWeight", () => {
  it("adds the weather only over the span of the days without a row", () => {
    const range = {
      startDate: "2023-01-01",
      endDate: "2023-03-31",
      days: ["2023-01-01", "2023-03-31"],
    };
    const airOnly = historyRangeWeight(range, []);
    expect(airOnly).toBeCloseTo((1.7 * 90) / 14);
    // One missing day: one weather request at its minimum weight (12 vars).
    expect(historyRangeWeight(range, ["2023-03-31"])).toBeCloseTo(
      airOnly + 1.2,
    );
  });
});

describe("historyRequestFits", () => {
  it("admits a request under every ceiling", () => {
    expect(historyRequestFits({}, 10)).toBe(true);
  });

  it("holds the account to three quarters of its daily share", () => {
    expect(AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS).toBe(300);
    expect(historyRequestFits({ "account-day": 295 }, 5)).toBe(true);
    expect(historyRequestFits({ "account-day": 295 }, 5.1)).toBe(false);
  });

  it("holds the history to half of each instance window", () => {
    expect(historyRequestFits({ minute: 245 }, 5)).toBe(true);
    expect(historyRequestFits({ minute: 246 }, 5)).toBe(false);
    expect(historyRequestFits({ hour: 1999 }, 2)).toBe(false);
    expect(historyRequestFits({ day: 3995 }, 10)).toBe(false);
  });
});

describe("resolveHistoryLocation", () => {
  const home = {
    lat: 51.5,
    lon: 7.2,
    label: "Home",
    timezone: "Europe/Berlin",
    since: "2026-09-01",
  };
  const trip = {
    startDate: "2024-07-01",
    endDate: "2024-07-14",
    lat: 38.7,
    lon: -9.1,
    label: "Lisbon",
  };

  it("places a day of a trip at the trip", () => {
    expect(resolveHistoryLocation("2024-07-05", home, [trip])).toMatchObject({
      lat: 38.7,
      source: "TRAVEL",
    });
  });

  it("places a day before the home was set at the home", () => {
    expect(resolveHistoryLocation("2020-03-01", home, [trip])).toMatchObject({
      lat: 51.5,
      source: "HOME",
    });
  });

  it("places nothing without a home or a period", () => {
    expect(resolveHistoryLocation("2020-03-01", null, [trip])).toBeNull();
  });
});

describe("stored progress", () => {
  const now = new Date("2026-10-09T03:00:00Z");

  it("reads a valid state and caps done at total", () => {
    expect(
      readAirQualityHistoryState({
        version: 1,
        total: 10,
        done: 12,
        checkedAt: now.toISOString(),
        complete: false,
      }),
    ).toMatchObject({ total: 10, done: 10 });
    expect(readAirQualityHistoryState({ total: "x" })).toBeNull();
    expect(readAirQualityHistoryState(null)).toBeNull();
  });

  it("offers an account with no, an unfinished or a stale history", () => {
    expect(historyDue(null, now)).toBe(true);
    expect(
      historyDue(
        { total: 5, done: 2, checkedAt: now.toISOString(), complete: false },
        now,
      ),
    ).toBe(true);
    expect(
      historyDue(
        {
          total: 5,
          done: 5,
          checkedAt: "2026-09-30T03:00:00Z",
          complete: true,
        },
        now,
      ),
    ).toBe(true);
  });

  it("leaves a history that is through and checked this week alone", () => {
    expect(
      historyDue(
        {
          total: 5,
          done: 5,
          checkedAt: "2026-10-07T03:00:00Z",
          complete: true,
        },
        now,
      ),
    ).toBe(false);
  });
});

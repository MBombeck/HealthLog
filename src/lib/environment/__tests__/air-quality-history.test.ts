/**
 * v1.42 — the air-quality history backfill's pure parts: how pending days
 * are cut into request ranges, what a range weighs, the ceilings that keep
 * the history from taking the nightly fetch's room, the entry-day snapshot a
 * chain hands on, and when an account is offered a run again.
 */
import { describe, expect, it } from "vitest";

import {
  AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS,
  AIR_QUALITY_HISTORY_CEILING,
  planHistoryRanges,
  readAirQualityHistoryState,
  readEntryDaysSnapshot,
} from "../air-quality-history";
import { airQualityChunkWeight } from "../open-meteo-air-quality";
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
      (sum, r) => sum + airQualityChunkWeight(r.startDate, r.endDate),
      0,
    );
    const perDay = days.length * airQualityChunkWeight(days[0], days[0]);
    expect(ranged).toBeLessThan(perDay / 4);
  });
});

describe("the history's ceiling", () => {
  it("holds the history to three quarters of the account's share and half of each instance window", () => {
    expect(AIR_QUALITY_HISTORY_ACCOUNT_DAY_CALLS).toBe(300);
    expect(AIR_QUALITY_HISTORY_CEILING).toEqual({
      instanceShare: 0.5,
      accountDayCalls: 300,
    });
  });
});

describe("entry-day snapshot", () => {
  it("reads a snapshot from a payload and refuses anything else", () => {
    const snapshot = {
      timezone: "Europe/Berlin",
      cutoff: "2026-10-01",
      days: ["2024-01-01"],
    };
    expect(readEntryDaysSnapshot(snapshot)).toEqual(snapshot);
    expect(readEntryDaysSnapshot(undefined)).toBeNull();
    expect(readEntryDaysSnapshot({ ...snapshot, days: [1] })).toBeNull();
    expect(readEntryDaysSnapshot({ ...snapshot, cutoff: 1 })).toBeNull();
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

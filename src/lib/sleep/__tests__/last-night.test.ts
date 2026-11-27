/**
 * "Last night" has one definition: the latest night on record with a main
 * sleep and time asleep, filed under its wake day, is the reader's today.
 * A daytime nap is no night; a night that woke yesterday is not last night
 * however few hours ago it ended.
 */
import { describe, expect, it } from "vitest";

import {
  isLastNight,
  lastNightOnRecord,
  resolveLastNight,
} from "@/lib/sleep/last-night";

const TODAY = "2026-11-26";

describe("lastNightOnRecord", () => {
  const night = (n: string, asleepMinutes: number, main = true) => ({
    night: n,
    asleepMinutes,
    main,
  });
  const main = (n: { main: boolean }) => n.main;

  it("is the latest night with a main sleep and time asleep", () => {
    expect(
      lastNightOnRecord(
        [night("2026-11-24", 400), night("2026-11-25", 420)],
        main,
      ),
    ).toMatchObject({ night: "2026-11-25" });
  });

  it("passes over a day whose only sleep is a nap", () => {
    expect(
      lastNightOnRecord(
        [night("2026-11-25", 420), night(TODAY, 40, false)],
        main,
      ),
    ).toMatchObject({ night: "2026-11-25" });
  });

  it("passes over a night with no time asleep", () => {
    expect(
      lastNightOnRecord([night("2026-11-25", 420), night(TODAY, 0)], main),
    ).toMatchObject({ night: "2026-11-25" });
    expect(lastNightOnRecord([], main)).toBeNull();
  });
});

describe("isLastNight", () => {
  it("holds only for a night with time asleep that woke today", () => {
    expect(isLastNight({ night: TODAY, asleepMinutes: 420 }, TODAY)).toBe(true);
    expect(isLastNight({ night: TODAY, asleepMinutes: 0 }, TODAY)).toBe(false);
    expect(
      isLastNight({ night: "2026-11-25", asleepMinutes: 420 }, TODAY),
    ).toBe(false);
    expect(isLastNight(null, TODAY)).toBe(false);
  });
});

describe("resolveLastNight", () => {
  const base = {
    todayKey: TODAY,
    sleepOn: true,
    sleepExpected: true,
    morningRefreshedToday: false,
    usualMinutes: 450,
  };

  it("takes the night that is in", () => {
    expect(
      resolveLastNight({
        ...base,
        night: { night: TODAY, asleepMinutes: 440 },
      }),
    ).toEqual({
      sleep: { minutes: 440, usualMinutes: 450 },
      sleepPending: false,
      latestNightDay: null,
    });
  });

  it("waits for tonight and names the latest night when last night is not in", () => {
    expect(
      resolveLastNight({
        ...base,
        night: { night: "2026-11-25", asleepMinutes: 310 },
      }),
    ).toEqual({
      sleep: null,
      sleepPending: true,
      latestNightDay: "2026-11-25",
    });
  });

  it("is not pending once the morning refresh ran, or with sleep off", () => {
    const stale = { night: { night: "2026-11-25", asleepMinutes: 310 } };
    expect(
      resolveLastNight({ ...base, ...stale, morningRefreshedToday: true })
        .sleepPending,
    ).toBe(false);
    expect(resolveLastNight({ ...base, ...stale, sleepOn: false })).toEqual({
      sleep: null,
      sleepPending: false,
      latestNightDay: null,
    });
  });
});

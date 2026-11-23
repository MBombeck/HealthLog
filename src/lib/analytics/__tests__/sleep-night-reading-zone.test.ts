import { describe, expect, it } from "vitest";
import type { SleepStage } from "@/generated/prisma/client";

import {
  reconstructSleepNights,
  reconstructSleepSessions,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

/**
 * A night slept abroad (iOS #181). The profile is in Berlin; the sleep
 * was taken in New York, 16:30 to 21:30 local on 1 June, which ends at 01:30
 * UTC and 03:30 in Berlin on 2 June. Read in its own zone it wakes on 1 June;
 * without a zone on the rows it wakes on 2 June, as it always did.
 */
function row(
  endIso: string,
  stage: SleepStage,
  minutes: number,
  timeZone?: string | null,
): SleepStageRow {
  return {
    measuredAt: new Date(endIso),
    sleepStage: stage,
    value: minutes,
    source: "APPLE_HEALTH",
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
}

const NIGHT_NY = (zone?: string | null) => [
  // 16:30 to 21:30 New York on 1 June (UTC-4): ends 01:30 UTC on 2 June.
  row("2026-06-01T22:30:00Z", "CORE", 120, zone),
  row("2026-06-02T00:00:00Z", "DEEP", 90, zone),
  row("2026-06-02T01:30:00Z", "REM", 90, zone),
];

describe("sleep nights in the reading's own zone", () => {
  it("files a night under its own zone's wake day", () => {
    const nights = reconstructSleepNights(
      NIGHT_NY("America/New_York"),
      "Europe/Berlin",
    );
    expect(nights.map((n) => n.night)).toEqual(["2026-06-01"]);
    const [session] = reconstructSleepSessions(
      NIGHT_NY("America/New_York"),
      "Europe/Berlin",
    );
    expect(session!.night).toBe("2026-06-01");
    expect(session!.timeZone).toBe("America/New_York");
  });

  it("files the same night by the profile zone when the rows carry none", () => {
    expect(
      reconstructSleepNights(NIGHT_NY(null), "Europe/Berlin").map(
        (n) => n.night,
      ),
    ).toEqual(["2026-06-02"]);
    const [session] = reconstructSleepSessions(NIGHT_NY(), "Europe/Berlin");
    expect(session!.timeZone).toBeNull();
  });

  it("reads the nap rule on the sleeper's own clock", () => {
    // A five-hour sleep centred on 19:00 is a main sleep anywhere (over three
    // hours); a two-hour one centred at 19:00 local is a nap there, but its
    // midpoint is 01:00 in Berlin, inside the night window.
    const short = [
      row("2026-06-01T23:00:00Z", "CORE", 60, "America/New_York"),
      row("2026-06-02T00:00:00Z", "REM", 60, "America/New_York"),
    ];
    const [abroad] = reconstructSleepSessions(short, "Europe/Berlin");
    expect(abroad!.daytimeNap).toBe(true);
    const [home] = reconstructSleepSessions(
      short.map((r) => ({ ...r, timeZone: null })),
      "Europe/Berlin",
    );
    expect(home!.daytimeNap).toBe(false);
  });
});

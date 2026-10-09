/**
 * How a day's readings become entries (v1.42, #613).
 */
import { describe, expect, it } from "vitest";

import type { DayReadingRow, DayReadings } from "@/lib/mood/linked-context";

import {
  MAX_READINGS_PER_TYPE,
  dayValueShape,
  shapeDayValues,
} from "../values";

function row(
  type: DayReadingRow["type"],
  value: number,
  iso: string,
  unit = "x",
): DayReadingRow {
  return {
    type,
    value,
    unit,
    measuredAt: new Date(iso),
    source: "MANUAL",
    deviceType: null,
  };
}

describe("day values", () => {
  it("keeps hand readings, totals cumulative types, folds dense ones", () => {
    expect(dayValueShape("BLOOD_PRESSURE_SYS", 2)).toBe("readings");
    expect(dayValueShape("ACTIVITY_STEPS", 1)).toBe("total");
    expect(dayValueShape("PULSE", 3)).toBe("dayValue");
    expect(dayValueShape("BLOOD_GLUCOSE", MAX_READINGS_PER_TYPE + 1)).toBe(
      "dayValue",
    );
  });

  it("shapes entries with the band and the night", () => {
    const readings: DayReadings = {
      rowsByType: new Map([
        [
          "BLOOD_PRESSURE_SYS",
          [
            row("BLOOD_PRESSURE_SYS", 121, "2026-03-29T06:00:00Z", "mmHg"),
            row("BLOOD_PRESSURE_SYS", 131, "2026-03-29T18:00:00Z", "mmHg"),
          ],
        ],
        [
          "ACTIVITY_STEPS",
          [
            row("ACTIVITY_STEPS", 4000, "2026-03-29T12:00:00Z", "steps"),
            row("ACTIVITY_STEPS", 1000, "2026-03-29T20:00:00Z", "steps"),
          ],
        ],
      ]),
      night: {
        night: "2026-03-29",
        measuredAt: new Date("2026-03-29T05:00:00Z"),
        asleepMinutes: 420,
        inBedMinutes: null,
        awakeMinutes: null,
        stages: {},
        sourceDiscrepancy: null,
      } as unknown as DayReadings["night"],
      nightSource: "APPLE_HEALTH",
    };
    const band = { lo: 110, hi: 135, n: 30 };
    const values = shapeDayValues(
      readings,
      new Map([["BLOOD_PRESSURE_SYS", band]]),
      true,
      "UTC",
    );
    expect(values.map((v) => [v.type, v.value])).toEqual([
      ["SLEEP_DURATION", 420],
      ["BLOOD_PRESSURE_SYS", 121],
      ["BLOOD_PRESSURE_SYS", 131],
      ["ACTIVITY_STEPS", 5000],
    ]);
    expect(values[1].band).toEqual(band);
    expect(values[3].at).toBe("2026-03-29T20:00:00.000Z");
    expect(shapeDayValues(readings, new Map(), false, "UTC")).toHaveLength(3);
  });
});

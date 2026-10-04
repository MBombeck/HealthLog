import { describe, expect, it } from "vitest";

import { computeSignalsOfDay } from "../signals-of-day";

const DAY = 86_400_000;

/**
 * A day of pulse is the mean of its hours' means and a window the mean of its
 * days (`day-mean.ts`). Two days: a workout hour of twelve readings at 150 and
 * three resting hours at 60 (day value 82.5), then a day with one reading at
 * 60. The 7- and 30-day means are 71.25, not the 127.5 of the readings.
 */
function rows(now: number) {
  const today = new Date(now);
  const midnight = (daysAgo: number) =>
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
    daysAgo * DAY;
  const out: Array<{ value: number; measuredAt: Date }> = [];
  const workout = midnight(3);
  for (let i = 0; i < 12; i += 1) {
    out.push({
      value: 150,
      measuredAt: new Date(workout + 10 * 3_600_000 + i * 300_000),
    });
  }
  for (const h of [12, 14, 16]) {
    out.push({ value: 60, measuredAt: new Date(workout + h * 3_600_000) });
  }
  out.push({ value: 60, measuredAt: new Date(midnight(2) + 8 * 3_600_000) });
  return out;
}

describe("the pulse signal of the day", () => {
  it("weighs each day once in its 7- and 30-day means", () => {
    const now = Date.now();
    const pulse = rows(now);
    const [signal] = computeSignalsOfDay(
      (type) => (type === "PULSE" ? pulse : []),
      now,
      "UTC",
    );
    expect(signal.metric).toBe("pulse");
    expect(signal.avg7).toBe(71.25);
    expect(signal.avg30).toBe(71.25);
    expect(signal.deltaVs7).toBe(-11.25);
  });

  it("leaves every other metric on the plain mean of its readings", () => {
    const now = Date.now();
    const weight = rows(now);
    const [signal] = computeSignalsOfDay(
      (type) => (type === "WEIGHT" ? weight : []),
      now,
      "UTC",
    );
    expect(signal.avg7).toBe(127.5);
  });
});

/**
 * A day of pulse is the mean of its hours' means and a longer bucket the mean
 * of its days (`day-mean.ts`), in every in-memory fold the status cards and the
 * Coach snapshot build. One workout day (twelve readings at 150 in one hour,
 * three resting hours at 60: day value 82.5) and one resting day (one reading
 * at 60): a bucket holding both reads 71.25; the plain mean of the sixteen
 * readings is 127.5. Every other type keeps the plain mean, and the counts,
 * minima and maxima stay over the readings.
 */
import { describe, expect, it } from "vitest";

import { bucketSeries } from "../bucket-series";
import {
  buildGradedSeriesFromDayAggregates,
  buildGradedSeriesFromPoints,
} from "../graded-series";
import {
  bucketWeekly,
  buildDailyValueRows,
} from "@/lib/ai/coach/snapshot-series";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = "UTC";

function twoDays(firstDay: number) {
  const rows: Array<{ measuredAt: Date; value: number }> = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push({
      measuredAt: new Date(firstDay + 10 * HOUR + i * 300_000),
      value: 150,
    });
  }
  for (const h of [12, 14, 16]) {
    rows.push({ measuredAt: new Date(firstDay + h * HOUR), value: 60 });
  }
  rows.push({ measuredAt: new Date(firstDay + DAY + 8 * HOUR), value: 60 });
  return rows;
}

describe("graded series from points", () => {
  // Wednesday 2026-03-04 and Thursday 2026-03-05, both in ISO week 10.
  const first = Date.UTC(2026, 2, 4);
  const rows = twoDays(first);

  it("gives a recent pulse day the mean of its hours", () => {
    const g = buildGradedSeriesFromPoints(
      rows,
      new Date(first + 2 * DAY),
      TZ,
      "PULSE",
    );
    const day = g.recent.find((d) => d.date === "2026-03-04")!;
    expect(day.mean).toBe(82.5);
    expect(day.n).toBe(15);
    expect(day.min).toBe(60);
    expect(day.max).toBe(150);
  });

  it("gives a pulse week the mean of its days", () => {
    // 30 days later both days fall in the weekly slice.
    const g = buildGradedSeriesFromPoints(
      rows,
      new Date(first + 30 * DAY),
      TZ,
      "PULSE",
    );
    expect(g.weekly).toHaveLength(1);
    expect(g.weekly[0].mean).toBe(71.25);
    expect(g.weekly[0].n).toBe(16);
  });

  it("keeps the plain mean for any other type", () => {
    const g = buildGradedSeriesFromPoints(
      rows,
      new Date(first + 30 * DAY),
      TZ,
      "BLOOD_PRESSURE_SYS",
    );
    expect(g.weekly[0].mean).toBe(127.5);
  });
});

describe("graded series from day aggregates", () => {
  it("takes a bucket's mean from the day weights when the rows carry them", () => {
    const g = buildGradedSeriesFromDayAggregates([
      {
        day: "2026-03-04",
        segment: 1,
        n: 15,
        sum: 12 * 150 + 3 * 60,
        min: 60,
        max: 150,
        weightedSum: 82.5,
        weightSum: 1,
      },
      {
        day: "2026-03-05",
        segment: 1,
        n: 1,
        sum: 60,
        min: 60,
        max: 60,
        weightedSum: 60,
        weightSum: 1,
      },
    ]);
    expect(g.weekly[0].mean).toBe(71.25);
    expect(g.weekly[0].n).toBe(16);
  });
});

describe("bucketSeries", () => {
  const now = new Date(Date.UTC(2026, 2, 6, 12));
  const rows = twoDays(Date.UTC(2026, 2, 4));

  it("gives a pulse day its hours' mean and keeps n the readings", () => {
    const s = bucketSeries(rows, { now, tz: TZ, type: "PULSE" });
    const workout = s.daily.find((d) => d.dayOffset === 2)!;
    expect(workout.value).toBe(82.5);
    expect(workout.n).toBe(15);
  });

  it("gives a pulse month the mean of its days", () => {
    const s = bucketSeries(rows, {
      now: new Date(Date.UTC(2026, 2, 4) + 20 * DAY),
      tz: TZ,
      type: "PULSE",
      dailyDays: 10,
    });
    expect(s.monthly).toHaveLength(1);
    expect(s.monthly[0].value).toBe(71.25);
    expect(s.monthly[0].n).toBe(16);
  });

  it("keeps the plain mean without a type or for any other type", () => {
    expect(
      bucketSeries(rows, { now, tz: TZ }).daily.find((d) => d.dayOffset === 2)!
        .value,
    ).toBe(132);
    expect(
      bucketSeries(rows, { now, tz: TZ, type: "WEIGHT" }).daily.find(
        (d) => d.dayOffset === 2,
      )!.value,
    ).toBe(132);
  });
});

describe("Coach snapshot timeline", () => {
  const first = Date.UTC(2026, 2, 4);
  const rows = twoDays(first);

  it("gives a recent pulse day the mean of its hours", () => {
    const daily = buildDailyValueRows(rows, new Date(first), TZ, "PULSE");
    expect(daily.map((d) => d.value)).toEqual([82.5, 60]);
    expect(
      buildDailyValueRows(rows, new Date(first), TZ).map((d) => d.value),
    ).toEqual([132, 60]);
  });

  it("gives a pulse week the mean of its days, count the readings", () => {
    const [week] = bucketWeekly(rows, TZ, "PULSE");
    expect(week.mean).toBe(71.3);
    expect(week.count).toBe(16);
    expect(bucketWeekly(rows, TZ)[0].mean).toBe(127.5);
  });
});

import { describe, expect, it } from "vitest";

import {
  dayValue,
  dayValueRows,
  dayWeightedRows,
  foldMeanSql,
  hourMeanRows,
  isHourlyMeanTypeSql,
  readingsMean,
  windowMeanSql,
  zoneDayFrame,
  SESSION_DAY_FRAME,
} from "../day-mean";

const at = (iso: string) => new Date(iso);

/** One hard hour of 12 readings at 150 bpm, then three resting hours of one reading at 60. */
function workoutDay(day: string) {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    value: 150,
    measuredAt: at(`${day}T10:${String(i * 5).padStart(2, "0")}:00Z`),
  }));
  for (const h of ["12", "14", "16"]) {
    rows.push({ value: 60, measuredAt: at(`${day}T${h}:00:00Z`) });
  }
  return rows;
}

describe("dayValue", () => {
  it("is the mean of the hours' means for pulse", () => {
    expect(dayValue("PULSE", workoutDay("2026-03-02"), "UTC")).toBeCloseTo(
      (150 + 60 * 3) / 4,
      10,
    );
  });

  it("is the plain mean for every other type", () => {
    const rows = workoutDay("2026-03-02");
    expect(dayValue("HEART_RATE_VARIABILITY", rows, "UTC")).toBe(
      rows.reduce((s, r) => s + r.value, 0) / rows.length,
    );
  });

  it("is null without readings", () => {
    expect(dayValue("PULSE", [], "UTC")).toBeNull();
  });

  it("buckets hours on the zone's own half-hour boundaries", () => {
    // Asia/Kolkata is UTC+05:30: 10:20Z and 10:40Z are 15:50 and 16:10 local,
    // two different local hours, though one UTC hour.
    const rows = [
      { value: 100, measuredAt: at("2026-03-02T10:20:00Z") },
      { value: 100, measuredAt: at("2026-03-02T10:25:00Z") },
      { value: 40, measuredAt: at("2026-03-02T10:40:00Z") },
    ];
    expect(dayValue("PULSE", rows, "Asia/Kolkata")).toBe(70);
    expect(dayValue("PULSE", rows, "UTC")).toBe(80);
  });
});

describe("readingsMean", () => {
  it("weighs each local day once for pulse", () => {
    const rows = [
      ...workoutDay("2026-03-02"),
      { value: 60, measuredAt: at("2026-03-03T08:00:00Z") },
    ];
    expect(readingsMean("PULSE", rows, "UTC")).toBeCloseTo((82.5 + 60) / 2, 10);
  });

  it("splits days at the zone's midnight", () => {
    // 22:30Z is already the next day in Berlin (UTC+1 in March).
    const rows = [
      { value: 100, measuredAt: at("2026-03-02T10:00:00Z") },
      { value: 100, measuredAt: at("2026-03-02T11:00:00Z") },
      { value: 40, measuredAt: at("2026-03-02T23:30:00Z") },
    ];
    expect(readingsMean("PULSE", rows, "UTC")).toBe(80);
    expect(readingsMean("PULSE", rows, "Europe/Berlin")).toBe(70);
  });

  it("keeps the plain left-to-right mean for every other type", () => {
    const rows = [0.1, 0.2, 0.3].map((value, i) => ({
      value,
      measuredAt: at(`2026-03-0${i + 1}T08:00:00Z`),
    }));
    expect(readingsMean("WEIGHT", rows, "UTC")).toBe((0 + 0.1 + 0.2 + 0.3) / 3);
  });

  it("is null without readings", () => {
    expect(readingsMean("PULSE", [], "UTC")).toBeNull();
    expect(readingsMean("WEIGHT", [], "UTC")).toBeNull();
  });
});

describe("hourMeanRows / dayValueRows", () => {
  it("collapse pulse to one row per hour / per day", () => {
    const rows = workoutDay("2026-03-02");
    const hours = hourMeanRows("PULSE", rows, "UTC");
    expect(hours.map((h) => h.value)).toEqual([150, 60, 60, 60]);
    expect(hours[0].measuredAt.toISOString()).toBe("2026-03-02T10:00:00.000Z");
    const days = dayValueRows("PULSE", rows, "UTC");
    expect(days).toHaveLength(1);
    expect(days[0].value).toBeCloseTo(82.5, 10);
  });

  it("hand every other type back untouched", () => {
    const rows = workoutDay("2026-03-02");
    expect(hourMeanRows("BLOOD_GLUCOSE", rows, "UTC")).toBe(rows);
    expect(dayValueRows("BLOOD_GLUCOSE", rows, "UTC")).toBe(rows);
  });
});

describe("SQL builders", () => {
  it("splice only the closed type list", () => {
    expect(isHourlyMeanTypeSql('m."type"')).toBe(
      `(m."type")::text IN ('PULSE')`,
    );
  });

  it("refuse a non-identifier source and an inline zone", () => {
    expect(() => dayWeightedRows("cm; DROP", SESSION_DAY_FRAME)).toThrow();
    expect(() => zoneDayFrame("'Europe/Berlin'")).toThrow();
    expect(zoneDayFrame("$3")).toEqual({ kind: "zone", tzSql: "$3" });
  });

  it("keep AVG for every other type and weigh pulse", () => {
    const sql = windowMeanSql({
      typeColumn: 'm."type"',
      value: 'm."value"',
      weight: "m.day_weight",
      filter: "m.x",
    });
    expect(sql).toContain('ELSE AVG(m."value") FILTER (WHERE m.x) END');
    expect(sql).toContain('SUM(m."value" * m.day_weight) FILTER (WHERE m.x)');
    const fold = foldMeanSql({
      typeColumn: 'c."type"',
      total: "c.total",
      count: "c.cnt",
      weightedSum: "c.wsum",
      weightSum: "c.wdays",
    });
    expect(fold).toContain("ELSE SUM(c.total) / SUM(c.cnt) END");
  });
});

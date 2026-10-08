/**
 * The notable-day rules (v1.42, #613): an extreme needs history and has to
 * stand unmatched for three months, `since` is always a true date, and a gap
 * needs a habit before it.
 */
import { describe, expect, it } from "vitest";

import { shiftDateKey } from "@/lib/tz/format";

import {
  EXTREME_MIN_HISTORY_DAYS,
  EXTREME_MIN_SPAN_DAYS,
  GAP_MIN_DAYS,
  extremesInSeries,
  gapsInSeries,
} from "../notable";

/** `n` consecutive days from `start`, each with `value(i)`. */
function series(
  start: string,
  n: number,
  value: (i: number) => number,
): Array<[string, number]> {
  return Array.from({ length: n }, (_, i) => [
    shiftDateKey(start, i),
    value(i),
  ]);
}

describe("extremes", () => {
  it("marks a new high after months of lower days, since the first day seen", () => {
    const days = series("2025-01-01", 200, () => 120);
    days.push(["2025-07-20", 150]);
    const found = extremesInSeries("BLOOD_PRESSURE_SYS", days, "2025-07-20");
    expect(found).toEqual([
      {
        date: "2025-07-20",
        kind: "extremeHigh",
        type: "BLOOD_PRESSURE_SYS",
        params: { since: "2025-01-01", value: 150 },
      },
    ]);
  });

  it("names the last day that was at least as high", () => {
    const days = series("2024-01-01", 400, (i) => (i === 100 ? 160 : 120));
    days.push([shiftDateKey("2024-01-01", 400), 155]);
    const [found] = extremesInSeries(
      "BLOOD_PRESSURE_SYS",
      days,
      shiftDateKey("2024-01-01", 400),
    );
    expect(found.kind).toBe("extremeHigh");
    expect(found.params.since).toBe(shiftDateKey("2024-01-01", 100));
  });

  it("stays quiet when an equal day is less than three months back", () => {
    const days = series("2025-01-01", 200, (i) => (i === 180 ? 150 : 120));
    days.push([shiftDateKey("2025-01-01", 200), 150]);
    expect(
      extremesInSeries(
        "BLOOD_PRESSURE_SYS",
        days,
        shiftDateKey("2025-01-01", 200),
      ),
    ).toEqual([]);
  });

  it("needs at least thirty days of history", () => {
    const days = series("2025-01-01", EXTREME_MIN_HISTORY_DAYS - 1, () => 70);
    // Spread out so the span rule alone would pass.
    const sparse = days.map(
      ([, v], i) => [shiftDateKey("2024-01-01", i * 5), v] as [string, number],
    );
    sparse.push(["2025-06-01", 90]);
    expect(extremesInSeries("WEIGHT", sparse, "2025-06-01")).toEqual([]);
  });

  it("marks a new low the same way", () => {
    const days = series("2025-01-01", EXTREME_MIN_SPAN_DAYS + 40, () => 80);
    const last = shiftDateKey("2025-01-01", EXTREME_MIN_SPAN_DAYS + 40);
    days.push([last, 75]);
    const [found] = extremesInSeries("WEIGHT", days, last);
    expect(found).toMatchObject({ kind: "extremeLow", params: { value: 75 } });
  });

  it("reports nothing for days before the window", () => {
    const days = series("2025-01-01", 200, (i) => i);
    expect(extremesInSeries("WEIGHT", days, "2026-01-01")).toEqual([]);
  });
});

describe("gaps", () => {
  it("dates a gap on its first missing day after a habit", () => {
    const days = new Set(series("2025-01-01", 40, () => 1).map(([d]) => d));
    const found = gapsInSeries("WEIGHT", days, "2025-01-01", "2025-03-31");
    expect(found).toEqual([
      {
        date: "2025-02-10",
        kind: "gap",
        type: "WEIGHT",
        params: { days: 50 },
      },
    ]);
  });

  it("needs a habit before the gap", () => {
    const days = new Set(["2025-01-01", "2025-01-08", "2025-01-15"]);
    expect(gapsInSeries("WEIGHT", days, "2025-01-01", "2025-03-31")).toEqual(
      [],
    );
  });

  it("ignores a pause shorter than two weeks", () => {
    const all = series("2025-01-01", 90, () => 1).map(([d]) => d);
    const days = new Set(
      all.filter((_, i) => i < 40 || i >= 40 + GAP_MIN_DAYS - 1),
    );
    expect(gapsInSeries("WEIGHT", days, "2025-01-01", "2025-03-31")).toEqual(
      [],
    );
  });
});

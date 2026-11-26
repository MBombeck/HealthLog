/**
 * A stored value the application declares impossible is not a measurement.
 *
 * The personal band ("your usual range") and the deviation line that reads
 * against it are both means over stored `Measurement.value`. Neither end
 * checked the value against the metric's own plausibility domain, so a single
 * impossible pulse reading — the shape a provider unit-decode slip or a writer
 * without the range gate produces — moved the day mean, the median carried it
 * into the band, and the card said "your pulse is above your usual range,
 * currently 111,287,531.01 instead of the usual 36,016.75".
 *
 * The numbers below are shaped like the real thing: a resting-pulse series in
 * the 60s and 70s, one impossible sample dropped into it. The deviation
 * line's latest-day mean folds in Postgres; its gate is pinned against a real
 * database in `tests/integration/dense-day-readers.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

// The day reads pick each day's ladder-winning source; the user's ladder
// blob is read once per call. No account here has one, so the default ladders apply.
vi.mock("@/lib/rollups/measurement-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rollups/measurement-read")>()),
  loadUserSourcePriority: async () => null,
}));

import type { ReadDayAggregatesOptions } from "@/lib/measurements/day-aggregates";

// The live day-mean read folds in SQL; the fake folds `rowsForRead` with the
// same day / range rules, so these tests see the filter the read asks for.
let rowsForRead: { value: number; measuredAt: Date }[] = [];
const seenOptions: ReadDayAggregatesOptions[] = [];
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/measurements/day-aggregates", async () => {
  const { foldDayAggregates } =
    await import("@/lib/measurements/__tests__/fake-day-aggregates");
  return {
    readDayAggregates: async (opts: ReadDayAggregatesOptions) => {
      seenOptions.push(opts);
      return foldDayAggregates(rowsForRead, opts);
    },
  };
});

import { buildBaselineBand, readDayMeanSeries } from "../baseline";
import { isPlausibleMetricValue } from "@/lib/measurements/value-domain";

/** A real-shaped resting-pulse day: four readings in the 60s/70s. */
function pulseDay(day: string, values: number[]) {
  return values.map((value, i) => ({
    value,
    measuredAt: new Date(`${day}T0${6 + i}:30:00.000Z`),
  }));
}

describe("metric plausibility domain", () => {
  it("admits a real pulse and refuses one no heart produces", () => {
    expect(isPlausibleMetricValue("PULSE", 68)).toBe(true);
    expect(isPlausibleMetricValue("PULSE", 20)).toBe(true);
    expect(isPlausibleMetricValue("PULSE", 300)).toBe(true);
    expect(isPlausibleMetricValue("PULSE", 111287531.01)).toBe(false);
    expect(isPlausibleMetricValue("PULSE", 36016.75)).toBe(false);
    expect(isPlausibleMetricValue("PULSE", 19)).toBe(false);
  });

  it("passes a metric with no declared range and refuses a non-finite value", () => {
    expect(isPlausibleMetricValue("SOMETHING_UNDECLARED", 12345)).toBe(true);
    expect(isPlausibleMetricValue("PULSE", Number.NaN)).toBe(false);
    expect(isPlausibleMetricValue("PULSE", Number.POSITIVE_INFINITY)).toBe(
      false,
    );
  });
});

/** The live (rollup-miss) day-mean read over `rows`. */
async function dayMeansFromRows(
  rows: { value: number; measuredAt: Date }[],
  type: "PULSE",
) {
  rowsForRead = rows;
  const { points } = await readDayMeanSeries(
    "u1",
    type,
    3650,
    new Date("2026-09-01T00:00:00Z"),
    new Map(),
  );
  return points;
}

describe("per-day means behind the personal band", () => {
  it("asks the read for the metric's own plausibility domain", async () => {
    await dayMeansFromRows(pulseDay("2026-08-01", [66]), "PULSE");
    expect(seenOptions.at(-1)?.valueRange).toEqual({ min: 20, max: 300 });
  });

  it("keeps the day mean on the real readings when one sample is impossible", async () => {
    const rows = pulseDay("2026-08-01", [66, 70, 111287531.01, 68]);

    const [point] = await dayMeansFromRows(rows, "PULSE");

    expect(point.day).toBe("2026-08-01");
    expect(point.mean).toBeCloseTo(68, 6);
  });

  it("drops a day whose every reading is impossible rather than inventing one", async () => {
    const rows = [
      ...pulseDay("2026-08-01", [66, 70, 68]),
      ...pulseDay("2026-08-02", [36016.75, 111287531.01]),
    ];

    const points = await dayMeansFromRows(rows, "PULSE");

    expect(points.map((p) => p.day)).toEqual(["2026-08-01"]);
  });

  it("holds the band inside the metric's own domain across a poisoned month", async () => {
    const rows: { value: number; measuredAt: Date }[] = [];
    for (let d = 1; d <= 28; d += 1) {
      const day = `2026-08-${String(d).padStart(2, "0")}`;
      // A steady resting pulse with a normal day-to-day wobble.
      rows.push(...pulseDay(day, [64 + (d % 5), 70 + (d % 3), 67]));
    }
    // Three days the provider decoded wrong.
    rows.push(...pulseDay("2026-08-05", [36016.75]));
    rows.push(...pulseDay("2026-08-17", [111287531.01]));
    rows.push(...pulseDay("2026-08-26", [98211.5]));

    const band = buildBaselineBand(
      (await dayMeansFromRows(rows, "PULSE")).map((p) => p.mean),
      "PULSE",
    );

    expect(band).not.toBeNull();
    expect(band!.center).toBeGreaterThan(40);
    expect(band!.center).toBeLessThan(120);
    expect(band!.low).toBeGreaterThan(20);
    expect(band!.high).toBeLessThan(300);
  });
});

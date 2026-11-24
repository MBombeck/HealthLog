import { describe, expect, it } from "vitest";

import {
  MAX_POINTS,
  nightOverlaysSql,
  overlayGrid,
  resolveNightOverlayMetrics,
  type OverlayBucketRow,
} from "@/lib/sleep/night-overlays";
import {
  coerceNightOverlayKinds,
  nextOverlaySelection,
} from "@/lib/sleep/night-overlay-kinds";

/**
 * The night metrics over the hypnogram (#1419): which source a metric is
 * read from, when a night holds a line and when only a value, and the grid
 * every line shares.
 */

const START = new Date("2026-06-03T21:00:00.000Z");
const END = new Date("2026-06-04T05:00:00.000Z");
const GRID = overlayGrid(START, END);

function row(
  type: OverlayBucketRow["type"],
  source: OverlayBucketRow["source"],
  idx: number | null,
  value: number,
  n = 1,
): OverlayBucketRow {
  return { type, source, idx, n, sum: value * n, min: value, max: value };
}

function resolve(rows: OverlayBucketRow[], sessionSource = "APPLE_HEALTH") {
  return resolveNightOverlayMetrics({
    rows,
    grid: GRID,
    sessionSource: sessionSource as OverlayBucketRow["source"],
    priorityJson: null,
  });
}

describe("overlayGrid", () => {
  it("pads the night by 15 minutes and buckets it in five", () => {
    expect(new Date(GRID.originMs).toISOString()).toBe(
      "2026-06-03T20:45:00.000Z",
    );
    expect(new Date(GRID.endMs).toISOString()).toBe("2026-06-04T05:15:00.000Z");
    expect(GRID.bucketMs).toBe(5 * 60_000);
    expect(GRID.firstSessionIdx).toBe(3);
    expect(GRID.lastSessionIdx).toBe(99);
  });

  it("widens the buckets of a session too long for the point budget", () => {
    const grid = overlayGrid(START, new Date(START.getTime() + 30 * 3_600_000));
    const points = (grid.endMs - grid.originMs) / grid.bucketMs;
    expect(points).toBeLessThanOrEqual(MAX_POINTS);
    expect(grid.bucketMs % (5 * 60_000)).toBe(0);
  });
});

describe("resolveNightOverlayMetrics", () => {
  it("reads a metric from the source that recorded the night", () => {
    const [pulse] = resolve([
      row("PULSE", "GARMIN", 5, 70),
      row("PULSE", "GARMIN", 6, 72),
      row("PULSE", "APPLE_HEALTH", 5, 60),
      row("PULSE", "APPLE_HEALTH", 6, 62),
    ]);
    expect(pulse!.source).toBe("APPLE_HEALTH");
    expect(pulse!.points.map((p) => p.value)).toEqual([60, 62]);
  });

  it("falls back to the ladder when the night's source holds no such metric", () => {
    const [pulse] = resolve(
      [
        row("PULSE", "WITHINGS", 5, 70),
        row("PULSE", "WITHINGS", 6, 72),
        row("PULSE", "APPLE_HEALTH", 5, 60),
        row("PULSE", "APPLE_HEALTH", 6, 62),
      ],
      "OURA",
    );
    // The default pulse ladder ranks the cuff (Withings) first.
    expect(pulse!.source).toBe("WITHINGS");
  });

  it("prefers a line from another source to a single value from the night's own", () => {
    const [hrv] = resolve(
      [
        row("HRV_RMSSD", "GARMIN", null, 44),
        row("HEART_RATE_VARIABILITY", "APPLE_HEALTH", 20, 38),
        row("HEART_RATE_VARIABILITY", "APPLE_HEALTH", 50, 41),
      ],
      "GARMIN",
    );
    expect(hrv).toMatchObject({
      kind: "hrv",
      type: "HEART_RATE_VARIABILITY",
      source: "APPLE_HEALTH",
      nightValue: null,
    });
  });

  it("serves a nightly average on the day's anchor as the night's value", () => {
    const [hrv] = resolve([row("HRV_RMSSD", "GARMIN", null, 44)], "GARMIN");
    expect(hrv).toMatchObject({
      kind: "hrv",
      type: "HRV_RMSSD",
      unit: "ms",
      points: [],
      nightValue: 44,
      summary: null,
    });
  });

  it("never turns a lone pulse or room reading into the night's value", () => {
    expect(
      resolve([
        row("PULSE", "WITHINGS", 50, 66),
        row("INDOOR_TEMPERATURE", "EXTERNAL", 40, 19.5),
      ]),
    ).toEqual([]);
  });

  it("draws no line from readings that lie only in the padding", () => {
    expect(
      resolve([
        row("PULSE", "APPLE_HEALTH", 0, 70),
        row("PULSE", "APPLE_HEALTH", 1, 71),
      ]),
    ).toEqual([]);
  });

  it("summarises the readings inside the session, weighted by their count", () => {
    const [pulse] = resolve([
      row("PULSE", "APPLE_HEALTH", 1, 90),
      row("PULSE", "APPLE_HEALTH", 10, 60, 3),
      row("PULSE", "APPLE_HEALTH", 11, 50, 1),
    ]);
    // The padding reading (90) is drawn but not summarised.
    expect(pulse!.points).toHaveLength(3);
    expect(pulse!.summary).toEqual({ min: 50, max: 60, avg: 57.5 });
  });

  it("puts every point on the shared grid", () => {
    const [pulse] = resolve([
      row("PULSE", "APPLE_HEALTH", 3, 60),
      row("PULSE", "APPLE_HEALTH", 4, 61),
    ]);
    expect(pulse!.points.map((p) => p.at)).toEqual([
      "2026-06-03T21:00:00.000Z",
      "2026-06-03T21:05:00.000Z",
    ]);
  });

  it("orders the metrics as the kinds are listed", () => {
    const kinds = resolve([
      row("INDOOR_TEMPERATURE", "EXTERNAL", 10, 19),
      row("INDOOR_TEMPERATURE", "EXTERNAL", 20, 18.5),
      row("OXYGEN_SATURATION", "APPLE_HEALTH", 30, 95),
      row("PULSE", "APPLE_HEALTH", 10, 60),
      row("PULSE", "APPLE_HEALTH", 11, 61),
    ]).map((m) => m.kind);
    expect(kinds).toEqual(["pulse", "spo2", "roomTemperature"]);
  });
});

describe("nightOverlaysSql", () => {
  it("binds every value and reads the anchor only for the nightly kinds", () => {
    const sql = nightOverlaysSql({
      userId: "user-1",
      types: ["PULSE", "HRV_RMSSD"],
      anchorTypes: ["HRV_RMSSD"],
      grid: GRID,
      anchor: new Date("2026-06-04T10:00:00.000Z"),
    });
    expect(sql.sql).not.toContain("user-1");
    expect(sql.sql).toContain("UNION ALL");
    expect(sql.values).toContain("user-1");
  });

  it("drops the anchor arm when no nightly kind is read", () => {
    const sql = nightOverlaysSql({
      userId: "user-1",
      types: ["PULSE"],
      anchorTypes: [],
      grid: GRID,
      anchor: new Date("2026-06-04T10:00:00.000Z"),
    });
    expect(sql.sql).not.toContain("UNION ALL");
  });
});

describe("overlay selection", () => {
  it("cleans a stored selection", () => {
    expect(coerceNightOverlayKinds(["pulse", "bogus", "pulse", "hrv"])).toEqual(
      ["pulse", "hrv"],
    );
    expect(coerceNightOverlayKinds(["pulse", "hrv", "spo2"])).toEqual([
      "hrv",
      "spo2",
    ]);
    expect(coerceNightOverlayKinds("pulse")).toEqual([]);
  });

  it("drops the line chosen first when a third is chosen", () => {
    expect(
      nextOverlaySelection(["pulse", "hrv"], ["pulse", "hrv"], "spo2"),
    ).toEqual(["hrv", "spo2"]);
  });

  it("turns a shown line off", () => {
    expect(
      nextOverlaySelection(["pulse", "hrv"], ["pulse", "hrv"], "pulse"),
    ).toEqual(["hrv"]);
  });

  it("keeps a choice the night does not hold until the limit pushes it out", () => {
    expect(nextOverlaySelection(["roomTemperature"], [], "pulse")).toEqual([
      "roomTemperature",
      "pulse",
    ]);
  });
});

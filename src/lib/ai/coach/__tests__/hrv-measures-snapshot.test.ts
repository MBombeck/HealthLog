/**
 * #1110 — since iOS 27 one Apple Watch writes both HRV measures: SDNN
 * (`HEART_RATE_VARIABILITY`) and RMSSD (`HRV_RMSSD`). They are different
 * statistics on different scales. The Coach's HRV block used to fold every
 * row of both into one daily series, so a day with both averaged an SDNN
 * value with an RMSSD value. With both present the block now carries one
 * timeline per measure under `byMeasure`, under the same section key, and
 * the budget pass condenses each as its own series.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";
import { buildValueSeriesBlocks } from "@/lib/ai/coach/snapshot-blocks/value-series-blocks";
import {
  condenseSeriesBlock,
  isCondensable,
  type DailySeries,
} from "@/lib/ai/coach/series-condense";
import type { CoachProvenance } from "@/lib/ai/coach/types";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function build(rows: Array<{ type: string; value: number; measuredAt: Date }>) {
  const snapshot: Record<string, unknown> = {};
  const registered = new Map<string, () => DailySeries>();
  const counts: NonNullable<CoachProvenance["counts"]> = {};
  buildValueSeriesBlocks({
    sources: new Set(["hrv"]),
    measurementRows: rows,
    additiveCutoff: () => day(400),
    recentCutoff: day(14),
    userTz: "UTC",
    snapshot,
    metrics: new Set(),
    counts,
    registerBlock: (key, _source, daily) => {
      if (daily) registered.set(key, daily);
    },
    groundingValues: new Map(),
    units: DEFAULT_UNIT_PREFERENCES,
  });
  return { snapshot, registered, counts };
}

const both = [
  { type: "HEART_RATE_VARIABILITY", value: 40, measuredAt: day(1) },
  { type: "HRV_RMSSD", value: 70, measuredAt: day(1) },
  { type: "HEART_RATE_VARIABILITY", value: 44, measuredAt: day(2) },
  { type: "HRV_RMSSD", value: 76, measuredAt: day(2) },
  { type: "HEART_RATE_VARIABILITY", value: 42, measuredAt: day(30) },
];

describe("Coach HRV block — SDNN and RMSSD kept apart (#1110)", () => {
  it("carries one timeline per measure when both are present", () => {
    const { snapshot, counts } = build(both);
    const block = snapshot.heartRateVariability as {
      unit?: string;
      timeline?: unknown;
      byMeasure: Record<string, { recent: Array<{ value: number }> }>;
    };
    expect(block.timeline).toBeUndefined();
    expect(block.unit).toBe("ms");
    expect(Object.keys(block.byMeasure)).toEqual(["SDNN", "RMSSD"]);
    const sdnn = block.byMeasure.SDNN!.recent.map((r) => r.value);
    const rmssd = block.byMeasure.RMSSD!.recent.map((r) => r.value);
    // No day mixes the two: SDNN days read 40s, RMSSD days 70s.
    expect(sdnn.every((v) => v < 50)).toBe(true);
    expect(rmssd.every((v) => v > 60)).toBe(true);
    expect(counts.hrv).toBe(5);
  });

  it("registers each measure as its own series, and condenses each", () => {
    const { snapshot, registered } = build(both);
    const daily = registered.get("heartRateVariability")!();
    expect(Object.keys(daily).sort()).toEqual(["RMSSD", "SDNN"]);
    const block = snapshot.heartRateVariability;
    expect(isCondensable("heartRateVariability", block)).toBe(true);
    condenseSeriesBlock(block, 1, "heartRateVariability", daily);
    const summary = (block as { summary?: Record<string, unknown> }).summary;
    expect(Object.keys(summary ?? {}).sort()).toEqual(["RMSSD", "SDNN"]);
  });

  it("keeps the single-timeline shape when only one measure is present", () => {
    const { snapshot } = build(both.filter((row) => row.type === "HRV_RMSSD"));
    const block = snapshot.heartRateVariability as Record<string, unknown>;
    expect(block.byMeasure).toBeUndefined();
    expect(block.timeline).toBeDefined();
  });
});

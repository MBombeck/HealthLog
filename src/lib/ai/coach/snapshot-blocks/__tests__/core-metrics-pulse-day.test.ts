import { describe, expect, it } from "vitest";

import { buildCoreMetricsBlocks } from "../core-metrics-block";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The Coach's pulse timeline: a day is the mean of its hours' means and a week
 * the mean of its days (`day-mean.ts`). A workout day of twelve readings at
 * 150 in one hour and three resting hours at 60 reads 82.5, not 132.
 */
describe("Coach pulse block", () => {
  it("states a pulse day as the mean of its hours, a week as its days", () => {
    const first = Date.UTC(2026, 2, 4);
    const rows: Array<{ type: string; value: number; measuredAt: Date }> = [];
    const day = (start: number) => {
      for (let i = 0; i < 12; i += 1) {
        rows.push({
          type: "PULSE",
          value: 150,
          measuredAt: new Date(start + 10 * HOUR + i * 300_000),
        });
      }
      for (const h of [12, 14, 16]) {
        rows.push({
          type: "PULSE",
          value: 60,
          measuredAt: new Date(start + h * HOUR),
        });
      }
      rows.push({
        type: "PULSE",
        value: 60,
        measuredAt: new Date(start + DAY + 8 * HOUR),
      });
    };
    day(first - 14 * DAY); // older: lands in the weekly fold
    day(first); // recent
    const snapshot: Record<string, unknown> = {};
    buildCoreMetricsBlocks({
      sources: new Set(["pulse"]),
      features: { pulse: { coverage: { count: rows.length } } } as never,
      measurementRows: rows,
      moodRows: null,
      recentCutoff: new Date(first),
      userTz: "UTC",
      coarseTails: {},
      snapshot,
      windows: new Set(),
      metrics: new Set(),
      counts: {},
      registerBlock: () => {},
      groundingValues: new Map(),
      units: {} as never,
    });
    const pulse = snapshot.pulse as {
      timeline: {
        recent: Array<{ value: number }>;
        weekly: Array<{ mean: number; count: number }>;
      };
    };
    expect(pulse.timeline.recent.map((d) => d.value)).toEqual([82.5, 60]);
    expect(pulse.timeline.weekly).toHaveLength(1);
    expect(pulse.timeline.weekly[0].mean).toBe(71.3);
    expect(pulse.timeline.weekly[0].count).toBe(16);
  });
});

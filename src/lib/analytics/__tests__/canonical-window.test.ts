import { describe, expect, it } from "vitest";

import {
  composeCanonicalWindow,
  windowCuts,
} from "@/lib/analytics/canonical-window";
import {
  closedWindowSql,
  edgeWindowSql,
  type EdgeCellRow,
} from "@/lib/analytics/canonical-window-sql";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-22T10:37:12.345Z");

describe("canonical window statements", () => {
  it("never rank raw readings and cut every window on the request's clock", () => {
    for (const sql of [closedWindowSql("90"), edgeWindowSql("90")]) {
      expect(sql).not.toMatch(/NOW\(\)|CURRENT_TIMESTAMP|CURRENT_DATE/i);
      // The pick runs over the folded cells, never over `measurements`.
      expect(sql).toMatch(/FIRST_VALUE\(c\."source"\)/);
      expect(sql).toMatch(/GROUP BY 1, 2, 3, 4/);
    }
    expect(edgeWindowSql("90")).toContain(
      `mm."measured_at" >= $2::timestamp - INTERVAL '90 days'`,
    );
    expect(closedWindowSql("90")).toContain(`mm."measured_at" < $3::timestamp`);
  });

  it("refuses a rank expression that could end the statement", () => {
    expect(() => closedWindowSql("1; DROP TABLE users")).toThrow();
    expect(() => edgeWindowSql("1 -- x")).toThrow();
  });
});

describe("windowCuts", () => {
  it("holds the whole UTC days between the window's first day and today", () => {
    const cuts = windowCuts(NOW);
    expect(cuts.blockTo.toISOString()).toBe("2026-11-22T00:00:00.000Z");
    expect(cuts.blockFrom.toISOString()).toBe("2026-08-25T00:00:00.000Z");
    expect(cuts.hour7.toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(cuts.hour60.toISOString()).toBe("2026-09-23T10:00:00.000Z");
  });
});

describe("composeCanonicalWindow", () => {
  const cuts = windowCuts(NOW);
  const cell = (
    over: Partial<EdgeCellRow> & { at: Date; value: number; n: number },
  ): EdgeCellRow => ({
    type: "WEIGHT",
    source: "WITHINGS",
    in7: true,
    in30: true,
    in60: true,
    pick: "WITHINGS",
    ...over,
  });

  it("splits a cut hour at the edge and keeps the block's pick for it", () => {
    const h7 = cuts.hour7.getTime();
    const day7 = Math.floor(h7 / DAY) * DAY;
    const block = new Map([
      [
        "WEIGHT",
        {
          hourAt: Float64Array.from([h7 - HOUR, h7]),
          hourN: Float64Array.from([1, 2]),
          hourTotal: Float64Array.from([70, 160]),
          values: Float64Array.from([70, 80]),
          counts: Float64Array.from([2, 1]),
          picks: new Map([[day7, "WITHINGS"]]),
        },
      ],
    ]);
    const edge = [
      // The cut hour: one reading before the edge, one after, and a reading
      // of a source the day did not pick.
      cell({ at: new Date(h7), value: 70, n: 1, in7: false, pick: null }),
      cell({ at: new Date(h7), value: 90, n: 1, pick: null }),
      cell({
        at: new Date(h7),
        value: 500,
        n: 1,
        source: "MANUAL",
        pick: null,
      }),
      // Today.
      cell({ at: cuts.blockTo, value: 100, n: 1 }),
    ];
    const [row] = composeCanonicalWindow(block, edge, cuts, "hour_mean_v1");
    // 7 days: the reading after the edge and today's.
    expect(row.avg7).toBe(95);
    // 30 days: every reading of the block's hours and today's.
    expect(row.avg30).toBe((70 + 160 + 100) / 4);
    // Median over 70, 70, 80, 100 (the cut hour's readings are in the
    // block's value counts already).
    expect(row.median).toBe(75);
    expect(row.avg30_last_month).toBeNull();
  });

  it("weighs an hourly-mean day once, each hour once", () => {
    const today = cuts.blockTo.getTime();
    const edge = [
      cell({ type: "PULSE", at: new Date(today), value: 60, n: 100 }),
      cell({ type: "PULSE", at: new Date(today + HOUR), value: 90, n: 1 }),
    ];
    const [row] = composeCanonicalWindow(new Map(), edge, cuts, "hour_mean_v1");
    expect(row.avg7).toBeCloseTo(75, 12);
    // The median stays over every reading.
    expect(row.median).toBe(60);
  });

  it("interpolates the median as PostgreSQL does and counts the outliers", () => {
    const today = cuts.blockTo.getTime();
    const edge = [
      ...Array.from({ length: 20 }, (_, i) =>
        cell({ at: new Date(today), value: 80 + (i % 2) * 0.1, n: 1 }),
      ),
      cell({ at: new Date(today), value: 120, n: 1 }),
    ].map((c, i) => ({ ...c, at: new Date(today + i * 1000) }));
    const [row] = composeCanonicalWindow(
      new Map(),
      edge.slice(0, 20),
      cuts,
      "hour_mean_v1",
    );
    expect(row.median).toBe(80 + (80.1 - 80) * 0.5);
    expect(row.anomalies).toBe(0);
    const [withOutlier] = composeCanonicalWindow(
      new Map(),
      edge,
      cuts,
      "hour_mean_v1",
    );
    expect(withOutlier.anomalies).toBe(1);
  });
});

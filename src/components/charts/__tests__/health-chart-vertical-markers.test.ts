import { describe, it, expect } from "vitest";
import { resolveVerticalMarkerPositions } from "../health-chart";

/**
 * v1.4.25 W6 — GLP-1 injection-day vertical-marker pinning.
 *
 * The helper maps incoming `{date, label?, color?}[]` markers onto the
 * bucketed chart series, returning the pointIndex of every match plus
 * the marker's color/label so the chart paints exactly one
 * `<ReferenceLine>` per matched bucket. Differs from the storyboard
 * `resolveAnnotationPositions` helper in two ways: it does an EXACT
 * day-key match (no ±7-day snap, no truncation), and it defaults the
 * color to the strip-tile green when omitted.
 *
 * Pure helper — the suite pins behaviour without mounting Recharts.
 */

describe("resolveVerticalMarkerPositions", () => {
  const dailyChartData = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-04-${String(15 + i).padStart(2, "0")}`,
  }));

  it("returns empty when markers is undefined", () => {
    expect(resolveVerticalMarkerPositions(undefined, dailyChartData)).toEqual(
      [],
    );
  });

  it("returns empty when markers is an empty array", () => {
    expect(resolveVerticalMarkerPositions([], dailyChartData)).toEqual([]);
  });

  it("returns empty when chartData is undefined or empty", () => {
    expect(
      resolveVerticalMarkerPositions([{ date: "2026-04-15" }], undefined),
    ).toEqual([]);
    expect(
      resolveVerticalMarkerPositions([{ date: "2026-04-15" }], []),
    ).toEqual([]);
  });

  it("pins a single in-window marker to its exact day-key", () => {
    const positions = resolveVerticalMarkerPositions(
      [{ date: "2026-04-15" }],
      dailyChartData,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0].pointIndex).toBe(0);
    expect(positions[0].color).toBe("#50fa7b");
    expect(positions[0].label).toBeUndefined();
  });

  it("pins multiple markers in input order with the correct pointIndex", () => {
    const positions = resolveVerticalMarkerPositions(
      [{ date: "2026-04-15" }, { date: "2026-04-22" }, { date: "2026-04-19" }],
      dailyChartData,
    );
    expect(positions.map((p) => p.pointIndex)).toEqual([0, 7, 4]);
  });

  it("respects caller-supplied color + label overrides", () => {
    const positions = resolveVerticalMarkerPositions(
      [
        { date: "2026-04-17", label: "Mounjaro 7.5", color: "#ff79c6" },
        { date: "2026-04-19" },
      ],
      dailyChartData,
    );
    expect(positions[0].color).toBe("#ff79c6");
    expect(positions[0].label).toBe("Mounjaro 7.5");
    // Default color preserved for the second marker.
    expect(positions[1].color).toBe("#50fa7b");
    expect(positions[1].label).toBeUndefined();
  });

  it("drops markers whose date does not match any visible day-key", () => {
    const positions = resolveVerticalMarkerPositions(
      [
        { date: "2026-04-15" }, // exact match — index 0
        { date: "2026-03-01" }, // off-window
        { date: "2026-05-15" }, // off-window
        { date: "2026-04-24" }, // off-window (visible ends at 2026-04-24? series is 15..24)
      ],
      dailyChartData,
    );
    // Series is 2026-04-15 .. 2026-04-24. 2026-04-24 is the last entry.
    expect(positions.map((p) => p.pointIndex)).toEqual([0, 9]);
  });

  it("handles a sparse weekly-bucket series with exact-day matching only", () => {
    // Weekly buckets — only the date keys that fall on a bucket day land.
    const weeklyChartData = ["2026-04-15", "2026-04-22", "2026-04-29"].map(
      (date) => ({ date }),
    );
    const positions = resolveVerticalMarkerPositions(
      [
        { date: "2026-04-22" }, // exact bucket day → matches
        { date: "2026-04-23" }, // between buckets → drops (no ±7 snap)
      ],
      weeklyChartData,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0].pointIndex).toBe(1);
  });
});

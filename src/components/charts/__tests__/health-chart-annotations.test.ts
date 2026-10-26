import { describe, it, expect } from "vitest";
import { resolveAnnotationPositions } from "../health-chart/series-math";

/**
 * v1.4.20 — storyboard-annotation pinning.
 *
 * The chart maps incoming `{date, label, color}[]` annotations onto
 * the bucketed series so each annotation paints a vertical reference
 * line at the closest visible point. Annotations that fall outside the
 * visible window (or > 7 days from any bucket) silently drop.
 *
 * Helper is pure; the suite pins:
 *   - exact-match dates land on their bucket
 *   - close-by dates snap to the nearest bucket within ±7 days
 *   - far-off dates drop entirely
 *   - labels longer than 24 chars truncate on the small-viewport line
 *   - empty / malformed input never throws
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function makeSeries(
  start: number,
  count: number,
): Array<{ timestamp: number }> {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: start + i * DAY_MS,
  }));
}

describe("resolveAnnotationPositions", () => {
  // 30 daily points starting 2026-04-15 (UTC noon).
  const startMs = Date.UTC(2026, 3, 15, 12, 0, 0);
  const dailySeries = makeSeries(startMs, 30);

  it("returns empty when annotations is undefined", () => {
    expect(resolveAnnotationPositions(undefined, dailySeries)).toEqual([]);
  });

  it("returns empty when chartData is empty", () => {
    expect(
      resolveAnnotationPositions(
        [{ date: "2026-04-15", label: "x", color: "#fff" }],
        [],
      ),
    ).toEqual([]);
  });

  it("returns empty when chartData is undefined", () => {
    expect(
      resolveAnnotationPositions(
        [{ date: "2026-04-15", label: "x", color: "#fff" }],
        undefined,
      ),
    ).toEqual([]);
  });

  it("pins an exact-day annotation to its visible bucket", () => {
    const positions = resolveAnnotationPositions(
      [{ date: "2026-04-15", label: "Started Ramipril", color: "#ff79c6" }],
      dailySeries,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0].pointIndex).toBe(0);
    expect(positions[0].label).toBe("Started Ramipril");
    expect(positions[0].color).toBe("#ff79c6");
  });

  it("snaps to the nearest visible bucket within 7 days", () => {
    // 2026-04-19 sits between visible day 4 (2026-04-19) and 5; exact match.
    const positions = resolveAnnotationPositions(
      [{ date: "2026-04-19", label: "Sustained dip", color: "#8be9fd" }],
      dailySeries,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0].pointIndex).toBe(4);
  });

  it("drops annotations more than 7 days off any visible bucket", () => {
    // 2026-06-15 is 31 days past the visible window's end (2026-05-14).
    const positions = resolveAnnotationPositions(
      [{ date: "2026-06-15", label: "Out of range", color: "#fff" }],
      dailySeries,
    );
    expect(positions).toHaveLength(0);
  });

  it("drops malformed dates silently", () => {
    const positions = resolveAnnotationPositions(
      [
        { date: "not-a-date", label: "x", color: "#fff" },
        { date: "2026-04-15", label: "ok", color: "#0f0" },
      ],
      dailySeries,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0].label).toBe("ok");
  });

  it("truncates labels > 24 chars on the small-viewport line", () => {
    const longLabel = "Started new medication regimen with extra notes";
    expect(longLabel.length).toBeGreaterThan(24);
    const positions = resolveAnnotationPositions(
      [{ date: "2026-04-15", label: longLabel, color: "#fff" }],
      dailySeries,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0].truncatedLabel).toHaveLength(24);
    expect(positions[0].truncatedLabel.endsWith("…")).toBe(true);
    // Full label preserved on the wide-viewport line.
    expect(positions[0].label).toBe(longLabel);
  });

  it("does not truncate labels at exactly 24 chars", () => {
    const exact24 = "x".repeat(24);
    const positions = resolveAnnotationPositions(
      [{ date: "2026-04-15", label: exact24, color: "#fff" }],
      dailySeries,
    );
    expect(positions[0].truncatedLabel).toBe(exact24);
    expect(positions[0].truncatedLabel).not.toContain("…");
  });

  it("preserves multiple in-window annotations in input order", () => {
    const positions = resolveAnnotationPositions(
      [
        { date: "2026-04-15", label: "A", color: "#fff" },
        { date: "2026-04-22", label: "B", color: "#fff" },
        { date: "2026-05-01", label: "C", color: "#fff" },
      ],
      dailySeries,
    );
    expect(positions.map((p) => p.label)).toEqual(["A", "B", "C"]);
    expect(positions.map((p) => p.pointIndex)).toEqual([0, 7, 16]);
  });

  it("handles a sparse weekly-bucket series", () => {
    // 12 weekly buckets spanning ~84 days from 2026-04-15.
    const weeklySeries = makeSeries(startMs, 12).map((p, i) => ({
      timestamp: startMs + i * 7 * DAY_MS,
    }));
    // 2026-04-22 is 7 days from start → bucket 1.
    const positions = resolveAnnotationPositions(
      [{ date: "2026-04-22", label: "Hit", color: "#fff" }],
      weeklySeries,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0].pointIndex).toBe(1);
  });
});

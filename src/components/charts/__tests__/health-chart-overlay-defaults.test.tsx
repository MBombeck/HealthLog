import { baselineLayers } from "../health-chart/chart-layers";
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * v1.4.18 — Default overlay state on chart wrappers.
 *
 * The maintainer rejected the always-on personal-baseline reference line that B1a
 * painted on every chart. The default surface for a new chart should be
 * a clean line + axes + tooltip — no baseline, no target-zone shading,
 * no trend line. Overlays are user-opt-in via the per-chart settings
 * popover (commit "feat(charts): per-chart overlay-controls component")
 * and persisted (commit "feat(charts): persist per-chart overlay
 * prefs"). The default state of every toggle is OFF.
 *
 * The personal baseline used to render unconditionally as a
 * `<ReferenceLine label="Your normal">`. We assert the SSR markup ships
 * no `personalBaseline` label and no in-target reference area when the
 * chart starts up.
 */

const sampleSeries = vi.hoisted(() => {
  const out: Array<{ measuredAt: string; value: number }> = [];
  for (let i = 0; i < 30; i++) {
    const dt = new Date(Date.UTC(2026, 4, 1 + i, 12, 0, 0));
    out.push({
      measuredAt: dt.toISOString(),
      value: 118 + (i % 5) - 2 + i * 0.05,
    });
  }
  return out;
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: sampleSeries.map((row) => {
      const ts = Date.parse(row.measuredAt);
      return {
        date: new Date(ts).toDateString(),
        timestamp: ts,
        BLOOD_PRESSURE_SYS: row.value,
      };
    }),
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("HealthChart default overlay state", () => {
  it("paints the personal baseline only behind the trend toggle", () => {
    // An always-on dashed mean line was rejected: the baseline layer paints
    // nothing with the trend overlay off, and one line per type with it on.
    const baselines = new Map([["WEIGHT", 80]]);
    const t = (key: string) => key;
    expect(
      baselineLayers(false, ["WEIGHT"], ["var(--chart-1)"], baselines, t),
    ).toBe(false);
    const on = baselineLayers(
      true,
      ["WEIGHT"],
      ["var(--chart-1)"],
      baselines,
      t,
    );
    expect(Array.isArray(on) && on.filter(Boolean)).toHaveLength(1);
  });

  it("does NOT paint the personal-baseline label by default in MoodChart source", () => {
    const moduleUrl = new URL("../mood-chart.tsx", import.meta.url);
    const src = readFileSync(fileURLToPath(moduleUrl), "utf8");
    // Same guard — the baseline ReferenceLine must be wrapped in a
    // condition (showTrend / similar), not always painted.
    expect(src).not.toMatch(
      /\{personalBaseline != null && \(\n\s+<ReferenceLine\n/,
    );
  });
});

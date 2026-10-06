/**
 * v1.41 — the compare chart: two periods overlaid on one axis, or two
 * metrics with two axes whose grid lines meet. Recharts is replaced by
 * pass-through parts so the props the chart hands it can be read without a
 * browser layout.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  yAxis: [] as Array<Record<string, unknown>>,
  line: [] as Array<Record<string, unknown>>,
}));

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Leaf = () => null;
  return {
    ResponsiveContainer: Pass,
    LineChart: Pass,
    BarChart: Pass,
    CartesianGrid: Leaf,
    Bar: Leaf,
    Tooltip: Leaf,
    XAxis: Leaf,
    Line: (props: Record<string, unknown>) => {
      calls.line.push(props);
      return null;
    },
    YAxis: (props: Record<string, unknown>) => {
      calls.yAxis.push(props);
      return null;
    },
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import type { CoachChartSpec, CoachResultTable } from "@/lib/ai/coach/types";

import { CoachResultChart, alignedAxes, comparePoints } from "../result-chart";

function table(
  chart: Extract<CoachChartSpec, { kind: "compare" }>,
  rows: CoachResultTable["rows"],
  labels: [string, string],
): CoachResultTable {
  return {
    ref: "r1",
    source: {
      tool: "compare_series" as never,
      domain: "resting_hr",
      window: "last30days",
      period: "current",
    },
    shape: "timeSeries",
    titleKey: "k",
    title: "Resting heart rate and sleep",
    rowCount: rows.length,
    chartKind: "compare",
    displayed: true,
    columns: [
      { key: "period", kind: "category", labelKey: "k", label: "Day" },
      {
        key: "a",
        kind: "number",
        labelKey: "k",
        label: labels[0],
        unit: "bpm",
      },
      { key: "b", kind: "number", labelKey: "k", label: labels[1], unit: "h" },
    ],
    rows,
    truncated: false,
    chart,
  };
}

const METRICS = table(
  { kind: "compare", mode: "metrics", x: "period", a: "a", b: "b", axes: 2 },
  [
    ["1", 58, 7.5],
    ["2", 61, 6.1],
    ["3", null, 6.8],
    ["4", 59, 8.0],
  ],
  ["Resting HR", "Sleep"],
);
const PERIODS = table(
  { kind: "compare", mode: "periods", x: "period", a: "a", b: "b", axes: 1 },
  [
    ["1", 58, 60],
    ["2", 61, 62],
  ],
  ["This month", "Last month"],
);

function render(result: CoachResultTable) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CoachResultChart result={result} otherLabel="Other" label="Chart" />
    </I18nProvider>,
  );
}

beforeEach(() => {
  calls.yAxis.length = 0;
  calls.line.length = 0;
});

describe("compare chart", () => {
  it("renders, where the placeholder rendered nothing", () => {
    const html = render(METRICS);
    expect(html).toContain('data-slot="coach-result-chart-compare"');
    expect(html).toContain('role="img"');
    // A legend button per series, both shown.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain("Resting HR");
    expect(html).toContain("Sleep");
  });

  it("draws two metrics on two axes whose grid lines meet", () => {
    render(METRICS);
    const [left, right] = calls.yAxis;
    expect(left.yAxisId).toBe("left");
    expect(right.yAxisId).toBe("right");
    expect(right.orientation).toBe("right");
    expect((left.ticks as number[]).length).toBe(
      (right.ticks as number[]).length,
    );
    expect(calls.line.map((l) => [l.dataKey, l.yAxisId, l.stroke])).toEqual([
      ["a", "left", "var(--chart-1)"],
      ["b", "right", "var(--chart-2)"],
    ]);
    // A gap stays a gap.
    expect(calls.line.every((l) => l.connectNulls === false)).toBe(true);
  });

  it("overlays two periods on one axis, the earlier one dashed, named a vs b", () => {
    const html = render(PERIODS);
    expect(calls.yAxis).toHaveLength(1);
    expect(calls.line.map((l) => l.strokeDasharray)).toEqual([
      undefined,
      "5 4",
    ]);
    expect(html).toContain('aria-label="This month vs Last month"');
  });

  it("reads its rows by the spec's columns", () => {
    expect(comparePoints(METRICS, METRICS.chart as never)[2]).toEqual({
      x: "3",
      a: null,
      b: 6.8,
    });
  });

  it("widens the second axis until its ticks line up with the first", () => {
    const axes = alignedAxes([50, 90], [6, 7]);
    expect(axes).not.toBeNull();
    expect(axes?.right.ticks.length).toBe(axes?.left.ticks.length);
    const steps = axes!.right.ticks
      .slice(1)
      .map((v, i) => v - axes!.right.ticks[i]);
    expect(new Set(steps.map((s) => s.toFixed(6))).size).toBe(1);
    expect(alignedAxes([], [1])).toBeNull();
  });
});

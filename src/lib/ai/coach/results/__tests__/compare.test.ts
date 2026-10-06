/**
 * v1.41 — comparisons: two periods of one metric overlaid, two metrics side
 * by side, the `compare` chart the server keeps for them, and the tool that
 * reads both sides through the metric table tool.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";

const executeCoachTool = vi.fn<(args: unknown) => Promise<CoachToolResult>>();
vi.mock("@/lib/ai/coach/tools/executor", () => ({
  executeCoachTool: (args: unknown) => executeCoachTool(args),
}));

import type { CoachResultTable, CoachScopeSource } from "@/lib/ai/coach/types";
import { projectCompare } from "@/lib/ai/coach/results/projections";
import { deriveChartSpec } from "@/lib/ai/coach/results/chart-spec";
import { createResultRefAllocator } from "@/lib/ai/coach/results/refs";
import { runCompareSeries } from "@/lib/ai/coach/tools/compare-series";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";

function dayTable(
  metric: CoachScopeSource,
  rows: Array<[string, number | null]>,
  unit: string,
  period: "current" | "previous" | "yearAgo" = "current",
): CoachResultTable {
  return {
    ref: "r1",
    source: {
      tool: "get_metric_table",
      domain: metric,
      window: "last7days",
      period,
      granularity: "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.byDay",
    title: `${metric} by day`,
    rowCount: rows.length,
    chartKind: null,
    displayed: false,
    columns: [
      {
        key: "day",
        kind: "period",
        labelKey: "coach.result.column.day",
        label: "Day",
      },
      {
        key: "mean",
        kind: "number",
        labelKey: "coach.result.column.mean",
        label: "Average",
        unit,
        decimals: 1,
      },
      {
        key: "readings",
        kind: "count",
        labelKey: "coach.result.column.readings",
        label: "Readings",
      },
    ],
    rows: rows.map(([day, value]) => [day, value, value === null ? null : 1]),
    truncated: false,
    chart: null,
  };
}

const CURRENT = dayTable(
  "weight",
  [
    ["2026-10-01", 80.1],
    ["2026-10-02", 80.0],
    ["2026-10-03", null],
    ["2026-10-04", 79.6],
  ],
  "kg",
);
const PREVIOUS = dayTable(
  "weight",
  [
    ["2026-09-24", 81.0],
    ["2026-09-25", 80.8],
    ["2026-09-26", 80.7],
    ["2026-09-27", 80.5],
  ],
  "kg",
  "previous",
);
const SLEEP = dayTable(
  "sleep",
  [
    ["2026-10-01", 420],
    ["2026-10-02", 380],
    ["2026-10-04", 455],
  ],
  "min",
);

describe("projectCompare", () => {
  it("overlays two periods position by position, on one axis", () => {
    const table = projectCompare({
      mode: "periods",
      a: CURRENT,
      b: PREVIOUS,
      basis: "previous",
      ref: "r3",
      locale: "en",
    })!;
    expect(table.columns.map((c) => c.key)).toEqual(["day", "a", "b"]);
    expect(table.rows).toEqual([
      ["2026-10-01", 80.1, 81.0],
      ["2026-10-02", 80.0, 80.8],
      ["2026-10-03", null, 80.7],
      ["2026-10-04", 79.6, 80.5],
    ]);
    expect(table.chart).toEqual({
      kind: "compare",
      mode: "periods",
      x: "day",
      a: "a",
      b: "b",
      axes: 1,
    });
    expect(table.chartKind).toBe("compare");
    expect(table.columns[1].labelKey).toBe("coach.step.period.current");
    expect(table.columns[2].labelKey).toBe("coach.step.period.previous");
    expect(table.title).toContain(" vs ");
    expect(table.ref).toBe("r3");
  });

  it("joins two metrics on their days, on two axes when the units differ", () => {
    const table = projectCompare({
      mode: "metrics",
      a: CURRENT,
      b: SLEEP,
      ref: "r1",
      locale: "en",
    })!;
    expect(table.rows).toEqual([
      ["2026-10-01", 80.1, 420],
      ["2026-10-02", 80.0, 380],
      ["2026-10-03", null, null],
      ["2026-10-04", 79.6, 455],
    ]);
    expect(table.chart).toMatchObject({ mode: "metrics", axes: 2 });
    expect(table.columns[2].unit).toBe("min");
    expect(table.title).toBe("Weight vs Sleep");
  });

  it("keeps one axis for two metrics in the same unit", () => {
    const fat = dayTable(
      "fat_mass",
      [
        ["2026-10-01", 20],
        ["2026-10-02", 19.8],
      ],
      "kg",
    );
    const table = projectCompare({
      mode: "metrics",
      a: CURRENT,
      b: fat,
      ref: "r1",
      locale: "en",
    })!;
    expect(table.chart).toMatchObject({ axes: 1 });
  });

  it("gives no comparison with fewer than two shared points", () => {
    const lone = dayTable("sleep", [["2026-10-01", 420]], "min");
    expect(
      projectCompare({
        mode: "metrics",
        a: CURRENT,
        b: lone,
        ref: "r1",
        locale: "en",
      }),
    ).toBeNull();
  });
});

describe("deriveChartSpec on a comparison", () => {
  it("keeps the compare chart while its columns hold what it names", () => {
    const table = projectCompare({
      mode: "metrics",
      a: CURRENT,
      b: SLEEP,
      ref: "r1",
      locale: "en",
    })!;
    expect(deriveChartSpec(table)).toEqual(table.chart);
    const broken = { ...table, columns: table.columns.slice(0, 2) };
    expect(deriveChartSpec(broken)).toBeNull();
  });

  it("leaves the existing chart kinds as they were", () => {
    expect(deriveChartSpec(CURRENT)).toEqual({
      kind: "line",
      x: "day",
      series: ["mean"],
    });
  });
});

describe("runCompareSeries", () => {
  const turn = () => ({
    conversationId: "c1",
    locale: "en" as const,
    priorResults: [],
    refs: createResultRefAllocator(),
  });

  beforeEach(() => {
    executeCoachTool.mockReset();
  });

  it("reads both sides through the metric table tool and names one joined table", async () => {
    executeCoachTool.mockImplementation(async (args) => {
      const raw = JSON.parse((args as { rawArguments: string }).rawArguments);
      const table = raw.period === "previous" ? PREVIOUS : CURRENT;
      return {
        present: true,
        data: { period: raw.period },
        resultRef: "r1",
        table,
      };
    });
    const t = turn();
    const out = await runCompareSeries({
      userId: "u1",
      rawArguments: JSON.stringify({
        mode: "periods",
        metric: "weight",
        window: "last7days",
      }),
      reach: UNBOUNDED_REACH,
      turn: t,
    });
    const calls = executeCoachTool.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(calls.map((c) => c.name)).toEqual([
      "get_metric_table",
      "get_metric_table",
    ]);
    expect(
      calls.map((c) => JSON.parse(c.rawArguments as string).period),
    ).toEqual(["current", "previous"]);
    // The sides take names of their own; the turn names only the comparison.
    expect(calls[0].turn).not.toBe(t);
    expect(out.resultRef).toBe("r1");
    expect(out.table?.chart).toMatchObject({
      kind: "compare",
      mode: "periods",
    });
    expect(out.data).toMatchObject({
      mode: "periods",
      basis: "previous",
      a: { period: "current" },
      b: { period: "previous" },
    });
    expect(t.refs.next()).toBe("r2");
  });

  it("reports the first side's miss as it is", async () => {
    executeCoachTool.mockResolvedValue({
      present: false,
      reason: "outside_reach",
    });
    const out = await runCompareSeries({
      userId: "u1",
      rawArguments: JSON.stringify({
        mode: "metrics",
        metric: "weight",
        metricB: "sleep",
      }),
      reach: UNBOUNDED_REACH,
      turn: turn(),
    });
    expect(out).toEqual({ present: false, reason: "outside_reach" });
  });

  it("refuses two identical metrics, all time against an earlier period, and unknown keys", async () => {
    for (const args of [
      { mode: "metrics", metric: "weight", metricB: "weight" },
      { mode: "metrics", metric: "weight" },
      { mode: "periods", metric: "weight", window: "allTime" },
      { mode: "periods", metric: "weight", userId: "someone-else" },
    ]) {
      expect(
        await runCompareSeries({
          userId: "u1",
          rawArguments: JSON.stringify(args),
          reach: UNBOUNDED_REACH,
          turn: turn(),
        }),
      ).toEqual({ present: false, reason: "invalid_arguments" });
    }
    expect(executeCoachTool).not.toHaveBeenCalled();
  });
});

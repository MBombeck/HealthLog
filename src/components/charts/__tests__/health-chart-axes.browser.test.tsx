import { CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { computeTickPositions } from "@/lib/charts/x-axis-density";
import { computePaddedYDomain, niceYAxis } from "@/lib/insights/chart-y-domain";

import {
  baselineLayers,
  rightLabelRoom,
  targetZoneLayers,
} from "../health-chart/chart-layers";
import { labelsBesidePlot, xTickLayout } from "../health-chart/series-math";

/**
 * The value chart's axes and its baseline label, drawn by Recharts with the
 * props HealthChart hands it: the y ticks are round and evenly spaced and all
 * of them drawn, the x ticks fall on the calendar grid, and the "your
 * average" and target zone labels sit whole beside the plot, covering no
 * reading. On a phone the plot keeps no room beside it: the labels are drawn
 * whole inside it, and a 90-day chart still gets its month grid.
 */

const DAY = 86_400_000;
const START = Date.parse("2026-07-23T12:00:00.000Z");
const MISSING = new Set([10, 11, 12, 40, 41, 70, 71, 72, 73, 80]);
const POINTS = Array.from({ length: 90 }, (_, day) => day)
  .filter((day) => !MISSING.has(day))
  .map((day, pointIndex) => ({
    pointIndex,
    timestamp: START + day * DAY,
    BLOOD_PRESSURE_SYS: 118 + 14 * Math.sin(day / 5) + (day % 7),
  }));

const t = (key: string) =>
  key === "charts.personalBaseline" ? "Your average" : key;
const label = "Your average";
const zoneLabel = "Systolic target";

const PHONE_WIDTH = 324;
// HealthChart's default y axis width.
const Y_AXIS_WIDTH = 76;

function Chart({ width = 720 }: { width?: number }) {
  const besidePlot = labelsBesidePlot(width);
  const rightRoom = besidePlot ? rightLabelRoom([label, zoneLabel]) : 0;
  const ticks = besidePlot
    ? computeTickPositions(POINTS, 1440)
    : computeTickPositions(
        POINTS,
        390,
        xTickLayout(width, Y_AXIS_WIDTH, rightRoom, "12/31/2000"),
      );
  const padded = computePaddedYDomain(
    POINTS.map((p) => p.BLOOD_PRESSURE_SYS),
    ["BLOOD_PRESSURE_SYS"],
  )!;
  const y = niceYAxis(padded);
  return (
    <ComposedChart
      width={width}
      height={260}
      data={POINTS}
      margin={{
        top: 10,
        right: 8 + rightRoom,
        bottom: 8,
        left: 8,
      }}
    >
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis
        type="number"
        dataKey="pointIndex"
        domain={[0, POINTS.length - 1]}
        tick={{ fontSize: 11 }}
        ticks={ticks}
        tickFormatter={(value: number) =>
          new Date(POINTS[Math.round(value)]!.timestamp)
            .toISOString()
            .slice(5, 10)
        }
        padding={{ left: 10, right: 10 }}
      />
      <YAxis
        tick={{ fontSize: 11 }}
        domain={y.domain}
        ticks={y.ticks}
        width={Y_AXIS_WIDTH}
      />
      <Line dataKey="BLOOD_PRESSURE_SYS" isAnimationActive={false} dot />
      {targetZoneLayers(
        [
          {
            key: "sys",
            low: 110,
            high: 130,
            color: "#c44",
            opacity: 0.1,
            lineOpacity: 0.5,
            topPct: 0,
            heightPct: 0,
            label: zoneLabel,
            textColor: undefined,
            labelInside: !besidePlot,
          },
        ],
        POINTS.length - 1,
      )}
      {baselineLayers(
        true,
        ["BLOOD_PRESSURE_SYS"],
        ["#888"],
        new Map([["BLOOD_PRESSURE_SYS", 121]]),
        t,
        besidePlot,
      )}
    </ComposedChart>
  );
}

async function settle() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

function tickTexts(root: HTMLElement, axis: "xAxis" | "yAxis"): string[] {
  return [
    ...root.querySelectorAll(
      `.recharts-${axis}-tick-labels .recharts-cartesian-axis-tick-value`,
    ),
  ].map((node) => node.textContent ?? "");
}

describe("value chart axes", () => {
  it("draws every round y tick, evenly spaced", async () => {
    const screen = await render(<Chart />);
    await settle();
    const values = tickTexts(screen.container, "yAxis").map(Number);
    expect(values).toEqual([100, 110, 120, 130, 140, 150]);
  });

  it("puts the x ticks on the two-week grid of Mondays", async () => {
    const screen = await render(<Chart />);
    await settle();
    expect(tickTexts(screen.container, "xAxis")).toEqual([
      "08-01",
      "08-17",
      "08-31",
      "09-14",
      "09-28",
      "10-12",
    ]);
  });

  it("draws a target zone's label whole, beside the plot", async () => {
    const screen = await render(<Chart />);
    await settle();
    const root = screen.container;
    const plot = root
      .querySelector(".recharts-cartesian-grid")!
      .getBoundingClientRect();
    const svg = root
      .querySelector("svg.recharts-surface")!
      .getBoundingClientRect();
    const text = [...root.querySelectorAll(".recharts-label")].find(
      (node) => node.textContent === zoneLabel,
    )!;
    expect(text).toBeDefined();
    const box = text.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(plot.right);
    expect(box.right).toBeLessThanOrEqual(svg.right);
  });

  it("draws the average's label outside the plot, clear of every reading", async () => {
    const screen = await render(<Chart />);
    await settle();
    const root = screen.container;
    const plot = root
      .querySelector(".recharts-cartesian-grid")!
      .getBoundingClientRect();
    const text = [...root.querySelectorAll(".recharts-label")].find(
      (node) => node.textContent === label,
    )!;
    expect(text).toBeDefined();
    const box = text.getBoundingClientRect();
    const svg = root
      .querySelector("svg.recharts-surface")!
      .getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(plot.right);
    expect(box.right).toBeLessThanOrEqual(svg.right);
    for (const dot of root.querySelectorAll(".recharts-line-dot")) {
      const d = dot.getBoundingClientRect();
      const overlaps =
        d.left < box.right &&
        d.right > box.left &&
        d.top < box.bottom &&
        d.bottom > box.top;
      expect(overlaps).toBe(false);
    }
  });

  it("on a phone keeps no room beside the plot and draws both labels whole inside it", async () => {
    const screen = await render(<Chart width={PHONE_WIDTH} />);
    await settle();
    const root = screen.container;
    const plot = root
      .querySelector(".recharts-cartesian-grid")!
      .getBoundingClientRect();
    const svg = root
      .querySelector("svg.recharts-surface")!
      .getBoundingClientRect();
    // The plot reaches the chart's right margin (8 px) and nothing more.
    expect(svg.right - plot.right).toBeLessThanOrEqual(8 + 10 + 1);
    for (const text of [label, zoneLabel]) {
      const node = [...root.querySelectorAll(".recharts-label")].find(
        (n) => n.textContent === text,
      )!;
      expect(node).toBeDefined();
      const box = node.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(plot.left);
      expect(box.right).toBeLessThanOrEqual(plot.right + 1);
    }
  });

  it("on a phone labels a 90-day chart on the month grid, three dates", async () => {
    const screen = await render(<Chart width={PHONE_WIDTH} />);
    await settle();
    // September 1 and October 1 have no reading, so their ticks take the
    // nearest day that has one.
    expect(tickTexts(screen.container, "xAxis")).toEqual([
      "08-01",
      "08-31",
      "09-30",
    ]);
  });
});

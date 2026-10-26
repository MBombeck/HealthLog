/**
 * v1.20.1 — regression cover for the dashboard chart-row render loop.
 *
 * A user reported the dashboard crashing (blank error card) on returning
 * to a backgrounded tab. The snapshot query refetches on window focus,
 * re-rendering the page; every chart was handed an inline
 * `() => markChartReady(id)` closure, so the chart's `onDataReady` notify
 * effect — keyed on that ever-changing prop — re-fired on every commit.
 * That per-commit passive effect kept the tile strip's Radix-Popper
 * anchors re-committing until React tripped its update-depth guard
 * (minified React error #185).
 *
 * The fix latches the notify behind a ref so it fires exactly once on the
 * first non-loading commit and depends on `isLoading` alone. This pins the
 * pure decision and the charts' wiring so the latch cannot silently revert
 * to the per-render notify.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { shouldFireDataReady } from "@/lib/charts/data-ready-latch";

describe("shouldFireDataReady", () => {
  it("holds while the chart's initial query is still loading", () => {
    expect(shouldFireDataReady({ isLoading: true, alreadyFired: false })).toBe(
      false,
    );
  });

  it("fires once on the first non-loading commit", () => {
    expect(shouldFireDataReady({ isLoading: false, alreadyFired: false })).toBe(
      true,
    );
  });

  it("never re-fires after it has fired once, even though the chart keeps re-rendering", () => {
    // Models the tab-resume path: the parent re-renders repeatedly (a new
    // `onDataReady` closure each time) while `isLoading` stays false. The
    // latch must decline every subsequent commit so the notify cannot
    // drive an unbounded render loop.
    let fired = false;
    let fireCount = 0;
    for (let commit = 0; commit < 60; commit += 1) {
      if (shouldFireDataReady({ isLoading: false, alreadyFired: fired })) {
        fired = true;
        fireCount += 1;
      }
    }
    expect(fireCount).toBe(1);
  });

  it("a chart that never loaded data still fires once the moment it settles", () => {
    // Loading first, then settled — fires on the settle commit, then holds.
    expect(shouldFireDataReady({ isLoading: true, alreadyFired: false })).toBe(
      false,
    );
    expect(shouldFireDataReady({ isLoading: false, alreadyFired: false })).toBe(
      true,
    );
    expect(shouldFireDataReady({ isLoading: false, alreadyFired: true })).toBe(
      false,
    );
  });
});

describe("chart notify wiring", () => {
  const charts = [
    "src/components/charts/health-chart/use-health-chart-series.ts",
    "src/components/charts/mood-chart.tsx",
    "src/components/charts/medication-compliance-chart.tsx",
  ];

  for (const rel of charts) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");

    it(`${rel} latches the data-ready notify once, not per render`, () => {
      // Routes through the pure latch.
      expect(src).toContain("shouldFireDataReady(");
      // Reads the handler through a ref so a changing prop identity never
      // re-arms the effect.
      expect(src).toContain("onDataReadyRef.current");
      // The notify effect depends on `isLoading` ALONE — never on the
      // unstable `onDataReady` prop (the loop trigger).
      expect(src).not.toMatch(/\}, \[isLoading, onDataReady\]\)/);
    });
  }
});

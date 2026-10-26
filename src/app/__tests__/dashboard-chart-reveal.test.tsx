/**
 * v1.16.0 — dashboard first-load choreography.
 *
 * Two complaints from the maintainer's first-load walk-through:
 *
 *   1. The tile strip painted EMPTY dark cards while the primary query
 *      was in flight — no inner structure previewing the final tile.
 *   2. The chart row popped in one chart at a time: every chart owns
 *      its own query, `/api/mood/analytics` is a single cheap read, so
 *      the mood chart reliably painted first and the measurement
 *      charts trickled in afterwards.
 *
 * The fix: structured `<TrendCardSkeleton>` silhouettes for every tile
 * slot, plus a shared reveal gate (`useDashboardChartReveal` /
 * `<DashboardChartCell>`) that holds every gated chart on its
 * layout-stable skeleton until every chart's data settled — or the 2 s
 * fallback fires so one slow widget cannot block the row.
 *
 * Project convention is SSR-only tests (vitest `node` environment, no
 * DOM test runner): the gate logic is pinned through the pure
 * `resolveChartRevealState` resolver, the markup through
 * `renderToStaticMarkup`, and the page wiring through textual pins.
 */
import type { ReactElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import {
  CHART_TILES,
  revealChartIds,
  type ChartTileContext,
} from "@/components/dashboard/tiles/chart-tiles";

import {
  CHART_REVEAL_TIMEOUT_MS,
  DashboardChartCell,
  resolveChartRevealState,
} from "@/components/dashboard/chart-reveal";
import { TrendCardSkeleton } from "@/components/charts/trend-card-skeleton";
import { I18nProvider } from "@/lib/i18n/context";

describe("resolveChartRevealState", () => {
  it("stays hidden while the gate is not armed (no visible charts yet)", () => {
    expect(
      resolveChartRevealState({
        expectedIds: [],
        readyIds: new Set(),
        timedOut: false,
      }),
    ).toBe(false);
    // Even a stale timeout cannot reveal an empty row.
    expect(
      resolveChartRevealState({
        expectedIds: [],
        readyIds: new Set(),
        timedOut: true,
      }),
    ).toBe(false);
  });

  it("holds the skeletons while any gated chart is still loading", () => {
    expect(
      resolveChartRevealState({
        expectedIds: ["weight-chart", "mood-chart"],
        readyIds: new Set(["mood-chart"]),
        timedOut: false,
      }),
    ).toBe(false);
  });

  it("reveals once every gated chart reported ready (the Promise.all moment)", () => {
    expect(
      resolveChartRevealState({
        expectedIds: ["weight-chart", "mood-chart"],
        readyIds: new Set(["weight-chart", "mood-chart"]),
        timedOut: false,
      }),
    ).toBe(true);
  });

  it("reveals on timeout so a slow widget cannot block the row", () => {
    expect(
      resolveChartRevealState({
        expectedIds: ["weight-chart", "mood-chart"],
        readyIds: new Set(),
        timedOut: true,
      }),
    ).toBe(true);
  });

  it("pins the 1.2 s fallback budget", () => {
    // v1.16.1 — lowered from 2 s: the timeout is only the worst-case cap
    // on how long fast charts wait for the slowest sibling (there is no
    // minimum delay — the row reveals the moment every gated query
    // settles). 1.2 s keeps the synchronized reveal without making one
    // cold widget hold the whole row on skeletons for 2 s.
    expect(CHART_REVEAL_TIMEOUT_MS).toBe(1_200);
  });
});

describe("DashboardChartCell", () => {
  const render = (revealed: boolean) =>
    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <DashboardChartCell revealed={revealed}>
          <div data-slot="probe-chart">chart body</div>
        </DashboardChartCell>
      </I18nProvider>,
    );

  it("hidden state: keeps the chart mounted but invisible under a skeleton overlay", () => {
    const html = render(false);
    expect(html).toContain('data-revealed="false"');
    // Chart stays mounted (its query must fire) but is layout-only.
    expect(html).toContain('data-slot="probe-chart"');
    expect(html).toContain("invisible");
    expect(html).toContain('aria-hidden="true"');
    // Layout-stable skeleton overlays the same box.
    expect(html).toContain('data-slot="chart-skeleton"');
    expect(html).toContain("absolute inset-0");
  });

  it("revealed state: drops the skeleton and fades the content in (motion-safe)", () => {
    const html = render(true);
    expect(html).toContain('data-revealed="true"');
    expect(html).not.toContain('data-slot="chart-skeleton"');
    expect(html).not.toContain("invisible");
    expect(html).toContain("motion-safe:animate-in");
    expect(html).toContain("motion-safe:fade-in");
  });
});

describe("TrendCardSkeleton", () => {
  it("renders a structured silhouette, not an empty card", () => {
    const html = renderToStaticMarkup(<TrendCardSkeleton />);
    expect(html).toContain('data-slot="trend-card-skeleton"');
    expect(html).toContain('aria-hidden="true"');
    // Structured: heading row + headline value + sub-row blocks.
    const skeletonBlocks = html.match(/data-slot="skeleton"/g) ?? [];
    expect(skeletonBlocks.length).toBeGreaterThanOrEqual(5);
    // Same outer chrome + min-height floor as the real TrendCard slot.
    expect(html).toContain("rounded-xl");
    expect(html).toContain("min-h-[8rem]");
    // Reduced motion honoured via the Skeleton primitive's shimmer class
    // (its prefers-reduced-motion guard lives beside the keyframes in
    // globals.css).
    expect(html).toContain("skeleton-shimmer");
  });
});

describe("dashboard chart-reveal wiring (the chart registry)", () => {
  const GATED = [
    "weight-chart",
    "bmi-chart",
    "bp-chart",
    "pulse-chart",
    "bodyFat-chart",
    "mood-chart",
    "sleep-chart",
    "steps-chart",
    "medications",
  ];

  it("derives the gated id list from the visible chart cards", () => {
    expect(revealChartIds(CHART_TILES)).toEqual(GATED);
    // A hidden card drops out of the list the reveal waits for.
    expect(
      revealChartIds(CHART_TILES.filter((tile) => tile.id !== "bp-chart")),
    ).toEqual(GATED.filter((id) => id !== "bp-chart"));
    expect(dashboardSource()).toMatch(
      /useDashboardChartReveal\(revealChartIds\(chartTiles\)\)/,
    );
  });

  it("every data-backed chart reports through onDataReady", () => {
    const markChartReady = vi.fn();
    const ctx = {
      t: (key: string) => key,
      unitDisplay: {
        unitFor: () => "kg",
        transformFor: () => ({ factor: 1, offset: 0 }),
      },
      user: { heightCm: 180, timezone: "Europe/Berlin" },
      summaries: {},
      compareBaseline: "none",
      preloadedSeries: undefined,
      markChartReady,
    } as unknown as ChartTileContext;
    for (const tile of CHART_TILES.filter((t) => GATED.includes(t.id))) {
      const node = tile.render(ctx) as ReactElement<{
        onDataReady?: () => void;
      }>;
      node.props.onDataReady?.();
      expect(markChartReady).toHaveBeenLastCalledWith(tile.id);
    }
    expect(markChartReady).toHaveBeenCalledTimes(GATED.length);
  });

  it("gated entries render inside DashboardChartCell", () => {
    expect(dashboardSource()).toMatch(
      /entry\.revealGated\s*\?[\s\S]*?<DashboardChartCell revealed=\{chartsRevealed\}>/,
    );
  });

  it("self-skeletoning cards (achievements / workouts) stay outside the gate", () => {
    for (const id of ["achievements", "recentWorkouts", "vorsorge"]) {
      const tile = CHART_TILES.find((t) => t.id === id);
      expect(tile, id).toBeDefined();
      expect(tile?.revealGated, id).toBeUndefined();
    }
  });
});

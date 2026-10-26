import { describe, it, expect } from "vitest";

import {
  resolveChartRowPlaceholderCount,
  resolveConfiguredTileCount,
  resolveDashboardFirstPaintGate,
} from "@/components/dashboard/dashboard-gates";
import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

/**
 * v1.4.43 — dashboard tile-strip skeleton during slow first
 * paint.
 *
 * Pre-fix the strip only painted once `trendCards.length > 0`. When the
 * driving query lagged (cache eviction, cold start) the user saw the
 * page header + zero tiles + then a burst of tiles seconds later. The
 * fix paints a layout-stable silhouette keyed off the user's configured
 * tile count (`layout.widgets.filter(w => w.tileVisible ?? w.visible).length`)
 * while the primary query is still in flight, so the page reserves the
 * strip's footprint immediately and swaps to the real tiles the moment
 * the query resolves.
 *
 * v1.7.0 — the gate now keys off `primaryLoading`, which resolves to
 * the snapshot cell under `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=true` and the
 * slim analytics cell otherwise. A disabled TanStack query reports
 * `isLoading: false`, so keying off the slim query in snapshot mode
 * (where it is `enabled: false`) flashed the empty state for the whole
 * snapshot fetch. The pure `resolveDashboardFirstPaintGate` carries the
 * behaviour; textual pins keep the wiring honest.
 */

describe("resolveDashboardFirstPaintGate", () => {
  const base = {
    trendCardCount: 0,
    chartCount: 0,
    configuredTileCount: 3,
    primaryLoading: false,
  };

  it("shows the skeleton (not the empty state) while the primary query loads", () => {
    const gate = resolveDashboardFirstPaintGate({
      ...base,
      primaryLoading: true,
    });
    expect(gate.showTileStripSkeleton).toBe(true);
    expect(gate.showEmptyState).toBe(false);
  });

  it("snapshot mode: a loading snapshot query suppresses the empty-state flash", () => {
    // Snapshot mode passes snapshotQuery.isLoading as primaryLoading.
    // While in flight there are zero trend cards / charts, but the
    // empty state must NOT fire — the skeleton carries the footprint.
    const gate = resolveDashboardFirstPaintGate({
      trendCardCount: 0,
      chartCount: 0,
      configuredTileCount: 7,
      primaryLoading: true,
    });
    expect(gate.showEmptyState).toBe(false);
    expect(gate.showTileStripSkeleton).toBe(true);
  });

  it("shows the empty state only once loading settles with no data", () => {
    const gate = resolveDashboardFirstPaintGate(base);
    expect(gate.showTileStripSkeleton).toBe(false);
    expect(gate.showEmptyState).toBe(true);
  });

  it("does not show the empty state when tiles resolved", () => {
    const gate = resolveDashboardFirstPaintGate({
      ...base,
      trendCardCount: 4,
    });
    expect(gate.showEmptyState).toBe(false);
    expect(gate.showTileStripSkeleton).toBe(false);
  });

  it("does not skeleton when no tiles are configured", () => {
    const gate = resolveDashboardFirstPaintGate({
      ...base,
      configuredTileCount: 0,
      primaryLoading: true,
    });
    expect(gate.showTileStripSkeleton).toBe(false);
    // No configured tiles and no charts while loading: still no empty
    // state until loading settles (avoids the flash).
    expect(gate.showEmptyState).toBe(false);
  });

  it("does not show the empty state when a chart has data", () => {
    const gate = resolveDashboardFirstPaintGate({
      ...base,
      chartCount: 1,
    });
    expect(gate.showEmptyState).toBe(false);
  });
});

describe("resolveConfiguredTileCount (v1.16.8)", () => {
  it("counts only widgets that paint a strip tile, with bp counting double", () => {
    // Default layout: weight, bp, pulse, bodyFat, mood, bpInTarget, vo2Max
    // plus the v1.20.0 sleep / steps / glucose flips are tile-visible AND
    // tile-capable; medications + recentWorkouts are tile-visible in the
    // stored layout but paint NO strip tile, so they must not inflate the
    // silhouette. bp paints sys + dia = 2. v1.28.52 added seven vitals +
    // body-composition strip tiles (hrv, oxygenSaturation, respiratoryRate,
    // wristTemperature, muscleMass, totalBodyWater, boneMass), each
    // single-count: 11 + 7 = 18. v1.29 added the fluid-intake strip tile
    // (waterIntake), single-count: 18 + 1 = 19.
    expect(resolveConfiguredTileCount(DEFAULT_DASHBOARD_LAYOUT)).toBe(19);
  });

  it("ignores chart-only and iOS-pin-only widget ids", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        { id: "medications", visible: true, tileVisible: true, order: 0 },
        { id: "recentWorkouts", visible: true, tileVisible: true, order: 1 },
        { id: "achievements", visible: true, tileVisible: true, order: 2 },
        { id: "cardioRecovery", visible: true, tileVisible: true, order: 3 },
      ],
    };
    expect(resolveConfiguredTileCount(layout)).toBe(0);
  });

  it("falls back to `visible` for legacy entries without tileVisible", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        { id: "weight", visible: true, order: 0 },
        { id: "pulse", visible: false, order: 1 },
      ],
    };
    expect(resolveConfiguredTileCount(layout)).toBe(1);
  });
});

describe("resolveChartRowPlaceholderCount (v1.16.8)", () => {
  it("reserves one cell per chart-visible chart-capable widget", () => {
    // Default layout chart row: weight, bp, pulse, bodyFat, mood,
    // medications are `visible`, plus the v1.20.0 vorsorge flip
    // (chart-row only); bpInTarget / achievements / recentWorkouts carry
    // no chart-shaped footprint.
    expect(resolveChartRowPlaceholderCount(DEFAULT_DASHBOARD_LAYOUT)).toBe(7);
  });

  it("adds the BMI cell riding the weight gate when a height is known", () => {
    expect(
      resolveChartRowPlaceholderCount(DEFAULT_DASHBOARD_LAYOUT, {
        hasHeightCm: true,
      }),
    ).toBe(8);
  });

  it("respects a trimmed layout", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        { id: "weight", visible: true, tileVisible: true, order: 0 },
        { id: "bp", visible: false, tileVisible: true, order: 1 },
        { id: "steps", visible: true, tileVisible: false, order: 2 },
      ],
    };
    expect(resolveChartRowPlaceholderCount(layout)).toBe(2);
  });
});

describe("v1.4.43 W11 — dashboard tile-strip skeleton (wiring)", () => {
  it("derives `configuredTileCount` through the tile-capable resolver", () => {
    const src = dashboardSource();
    expect(src).toMatch(
      /const\s+configuredTileCount\s*=\s*resolveConfiguredTileCount\(layout\);/,
    );
  });

  it("reserves the chart row while the primary query loads", () => {
    const src = dashboardSource();
    // The placeholder count keys off the layout config minus the
    // already-mounted (layout-gated) cells, and only while loading.
    // `mounted &&` pins the hydration render to the SSR output — the
    // auth query can settle before the page boundary hydrates, and an
    // extra BMI silhouette then mismatched the server HTML (React #418).
    expect(src).toMatch(
      /const\s+chartRowPlaceholderCount\s*=\s*primaryLoading[\s\S]*?resolveChartRowPlaceholderCount\(layout,[\s\S]*?hasHeightCm:\s*mounted\s*&&\s*Boolean\(user\?\.heightCm\)/,
    );
    expect(src).toMatch(/-\s*chartEntries\.length/);
    // The reserved cells render as aria-hidden ChartSkeletons in their
    // own slot.
    const skeletonBlock = src.match(
      /chartRowPlaceholderCount\s*>\s*0\s*&&\s*\([\s\S]*?dashboard-chart-row-skeleton[\s\S]*?\)\}/,
    );
    expect(skeletonBlock).not.toBeNull();
    expect(skeletonBlock?.[0]).toContain('aria-hidden="true"');
    expect(skeletonBlock?.[0]).toContain("<ChartSkeleton");
  });

  it("derives `primaryLoading` from the snapshot vs slim query", () => {
    const src = dashboardSource();
    // v1.16.4 — `!mounted` pins SSR + the hydration render to the
    // skeleton branch so a late-hydrating boundary can't disagree with
    // the server HTML (React #418); see `useMounted`.
    expect(src).toMatch(
      /const\s+primaryLoading\s*=\s*!mounted\s*\|\|\s*\(snapshotEnabled\s*\?\s*snapshotQuery\.isLoading\s*:\s*analyticsSlimQuery\.isLoading\);/,
    );
  });

  it("routes the gate through `resolveDashboardFirstPaintGate`", () => {
    const src = dashboardSource();
    expect(src).toMatch(
      /resolveDashboardFirstPaintGate\(\{[\s\S]*?primaryLoading,[\s\S]*?\}\)/,
    );
  });

  it("renders the skeleton with the same auto-fit grid track the real strip uses", () => {
    const src = dashboardSource();
    expect(src).toMatch(
      /showTileStripSkeleton\s*&&\s*\(\s*<div[\s\S]*?\[grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,11rem\),1fr\)\)\]/,
    );
  });

  it("keys the skeleton card count off configuredTileCount", () => {
    const src = dashboardSource();
    expect(src).toMatch(
      /Array\.from\(\{\s*length:\s*configuredTileCount\s*\}\)/,
    );
  });

  it("marks the skeleton aria-hidden + renders structured silhouettes", () => {
    // v1.16.0 — the strip silhouettes are structured `<TrendCardSkeleton>`
    // cards (label + headline value + sub-row), not empty pulsing divs.
    // Reduced motion moved into the component (the `<Skeleton>` primitive
    // carries `motion-reduce:animate-none`); the per-component test in
    // `dashboard-chart-reveal.test.tsx` pins that.
    const src = dashboardSource();
    const skeletonBlock = src.match(
      /showTileStripSkeleton\s*&&[\s\S]*?<\/div>\s*\)\}/,
    );
    expect(skeletonBlock).not.toBeNull();
    const block = skeletonBlock?.[0] ?? "";
    expect(block).toContain('aria-hidden="true"');
    expect(block).toContain("<TrendCardSkeleton");
  });

  it("uses the structured silhouette as the per-tile Suspense fallback", () => {
    const src = dashboardSource();
    expect(src).toMatch(/<Suspense fallback=\{<TrendCardSkeleton \/>\}>/);
  });

  it("gates the EmptyState on the resolved `showEmptyState` flag", () => {
    const src = dashboardSource();
    expect(src).toMatch(/if\s*\(showEmptyState\)\s*\{/);
  });
});

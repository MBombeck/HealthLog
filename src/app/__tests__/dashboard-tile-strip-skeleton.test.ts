import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDashboardFirstPaintGate } from "../page";

/**
 * v1.4.43 W11-M5 — dashboard tile-strip skeleton during slow first
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
const PAGE_PATH = join(process.cwd(), "src/app/page.tsx");

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

describe("v1.4.43 W11 — dashboard tile-strip skeleton (wiring)", () => {
  it("derives `configuredTileCount` from the resolved layout", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(
      /const\s+configuredTileCount\s*=\s*layout\.widgets\.filter\([\s\S]*?w\.tileVisible\s*\?\?\s*w\.visible[\s\S]*?\)\.length;/,
    );
  });

  it("derives `primaryLoading` from the snapshot vs slim query", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(
      /const\s+primaryLoading\s*=\s*snapshotEnabled\s*\?\s*snapshotQuery\.isLoading\s*:\s*analyticsSlimQuery\.isLoading;/,
    );
  });

  it("routes the gate through `resolveDashboardFirstPaintGate`", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(
      /resolveDashboardFirstPaintGate\(\{[\s\S]*?primaryLoading,[\s\S]*?\}\)/,
    );
  });

  it("renders the skeleton with the same auto-fit grid track the real strip uses", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(
      /showTileStripSkeleton\s*&&\s*\(\s*<div[\s\S]*?\[grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,11rem\),1fr\)\)\]/,
    );
  });

  it("keys the skeleton card count off configuredTileCount", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(
      /Array\.from\(\{\s*length:\s*configuredTileCount\s*\}\)/,
    );
  });

  it("marks the skeleton aria-hidden + carries motion-reduce", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    const skeletonBlock = src.match(
      /showTileStripSkeleton\s*&&[\s\S]*?<\/div>\s*\)\}/,
    );
    expect(skeletonBlock).not.toBeNull();
    const block = skeletonBlock?.[0] ?? "";
    expect(block).toContain('aria-hidden="true"');
    expect(block).toContain("motion-reduce:animate-none");
  });

  it("gates the EmptyState on the resolved `showEmptyState` flag", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(/if\s*\(showEmptyState\)\s*\{/);
  });
});

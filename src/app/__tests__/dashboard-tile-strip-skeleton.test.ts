import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.43 W11-M5 — dashboard tile-strip skeleton during slow slim
 * fetches.
 *
 * Pre-fix the strip only painted once `trendCards.length > 0`. When
 * both slim + thick `/api/analytics` slices lagged (cache eviction,
 * cold start) the user saw the page header + zero tiles + then a
 * burst of tiles 9 s later. The fix paints a layout-stable silhouette
 * keyed off the user's configured tile count
 * (`layout.widgets.filter(w => w.tileVisible ?? w.visible).length`)
 * while `analyticsSlimQuery.isLoading` is still in flight, so the
 * page reserves the strip's footprint immediately and swaps to the
 * real tiles the moment slim resolves.
 *
 * Textual pins keep the contract honest — render-mounting the
 * dashboard page would haul in TanStack-Query, auth, i18n, layout
 * and analytics scaffolding for a guard a substring scan already
 * proves.
 */
const PAGE_PATH = join(process.cwd(), "src/app/page.tsx");

describe("v1.4.43 W11 — dashboard tile-strip skeleton", () => {
  it("derives `configuredTileCount` from the resolved layout", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(
      /const\s+configuredTileCount\s*=\s*layout\.widgets\.filter\([\s\S]*?w\.tileVisible\s*\?\?\s*w\.visible[\s\S]*?\)\.length;/,
    );
  });

  it("gates the skeleton on slim-analytics loading + empty trend cards + configured tiles", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(
      /const\s+showTileStripSkeleton\s*=\s*[\s\S]*?trendCards\.length\s*===\s*0[\s\S]*?analyticsSlimQuery\.isLoading[\s\S]*?configuredTileCount\s*>\s*0/,
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

  it("suppresses the EmptyState while the skeleton is showing", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toMatch(
      /trendCards\.length\s*===\s*0\s*&&\s*charts\.length\s*===\s*0\s*&&\s*!showTileStripSkeleton/,
    );
  });
});

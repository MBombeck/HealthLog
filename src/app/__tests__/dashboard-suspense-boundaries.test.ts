import { describe, it, expect } from "vitest";
import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import { readSource } from "@/__tests__/helpers/source-files";

/**
 * v1.4.40 — dashboard Suspense boundaries.
 *
 * Audit-H2 flagged "no `<Suspense>` boundaries anywhere in the app".
 * The v1.4.40 W-RSC wave wraps every dashboard tile cell and every
 * chart cell in a per-cell `<Suspense>` boundary so the composition
 * reads as a grid of independently-suspending islands rather than a
 * flat client tree with shared loading semantics.
 *
 * Today the boundary is a structural no-op for the dynamic-loaded
 * charts because their loading skeleton lives inside the
 * `next/dynamic({ loading: <ChartSkeleton/> })` contract. The benefit
 * is future-proofing: any descendant that later suspends (an
 * `useSuspenseQuery` migration, an RSC hoist of a static legend) gets
 * its own fallback without re-architecting the row.
 *
 * The test pins the structural presence by greppig the page source —
 * a future refactor that drops the boundary lands a failing test
 * rather than silently regressing the streaming-composition contract.
 */

describe("v1.4.40 — dashboard per-cell Suspense boundaries", () => {
  it("imports Suspense from React", () => {
    const src = dashboardSource();
    expect(src).toMatch(/from\s+"react"/);
    expect(src).toMatch(/\bSuspense\b/);
  });

  it("wraps the chart-row cell in a `<Suspense fallback={<ChartSkeleton />}>` boundary", () => {
    const src = dashboardSource();
    // `<Suspense fallback={<ChartSkeleton />}>{entry.node}</Suspense>`
    // exact contract: the chart row's per-cell fallback uses the same
    // ChartSkeleton primitive the dynamic-loaded charts already paint
    // during JS chunk resolution.
    expect(src).toMatch(
      /<Suspense\s+fallback=\{<ChartSkeleton\s*\/>\}>\s*\{entry\.node\}\s*<\/Suspense>/,
    );
  });

  it("wraps each tile-strip cell in a `<Suspense>` boundary with a layout-stable placeholder", () => {
    const src = dashboardSource();
    // v1.4.41 W-FRONTEND-FACTORY (UX M1) swapped the prior `null`
    // fallback for an `aria-hidden` placeholder div; v1.16.0 upgraded
    // it to the structured `<TrendCardSkeleton>` silhouette (the
    // aria-hidden + trend-card chrome now live inside the component,
    // see `trend-card-skeleton.tsx`). The tile body is synchronous
    // today so the fallback rarely paints, but a future RSC hoist of
    // any tile slot would otherwise leave the grid track empty and
    // trigger CLS as the cell paints in. The structural pin guards the
    // contract.
    expect(src).toMatch(
      /<Suspense\s+fallback=\{<TrendCardSkeleton\s*\/>\}>\s*\{entry\.node\}\s*<\/Suspense>/,
    );
  });

  it("hoists DASHBOARD_QUERY_OPTS to module scope (audit-M2)", () => {
    const src = readSource(
      "src/components/dashboard/tiles/use-dashboard-data.ts",
      "export function useDashboardData",
    );
    // Module-scope declaration — search outside the hook body. Declared
    // inside it, every render would create a fresh `{}` reference.
    const moduleSliceEnd = src.indexOf("export function useDashboardData");
    expect(moduleSliceEnd).toBeGreaterThan(0);
    const moduleSlice = src.slice(0, moduleSliceEnd);
    expect(moduleSlice).toMatch(/const\s+DASHBOARD_QUERY_OPTS\s*=\s*\{/);
  });

  it("keeps the per-render Intl hour walk off the page (audit-H4 successor)", () => {
    const src = dashboardSource();
    // The audit-H4 `useMemo(getHourForTimeZone, [userTimezone])` pin
    // moved off the page with the greeting itself: the greeting now
    // lives in the header (`dashboard-header.tsx`), so the page no
    // longer instantiates any `Intl.DateTimeFormat` for the greeting —
    // per render or otherwise.
    expect(src).not.toContain("getHourForTimeZone");
    expect(src).not.toContain("welcomeText");
  });
});

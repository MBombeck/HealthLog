import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.40 W-RSC — dashboard Suspense boundaries.
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
const ROOT = join(__dirname, "../../..");
const PAGE_PATH = join(ROOT, "src/app/page.tsx");

function load(path: string): string {
  return readFileSync(path, "utf8");
}

describe("v1.4.40 — dashboard per-cell Suspense boundaries", () => {
  it("imports Suspense from React", () => {
    const src = load(PAGE_PATH);
    expect(src).toMatch(/from\s+"react"/);
    expect(src).toMatch(/\bSuspense\b/);
  });

  it("wraps the chart-row cell in a `<Suspense fallback={<ChartSkeleton />}>` boundary", () => {
    const src = load(PAGE_PATH);
    // `<Suspense fallback={<ChartSkeleton />}>{entry.node}</Suspense>`
    // exact contract: the chart row's per-cell fallback uses the same
    // ChartSkeleton primitive the dynamic-loaded charts already paint
    // during JS chunk resolution.
    expect(src).toMatch(
      /<Suspense\s+fallback=\{<ChartSkeleton\s*\/>\}>\s*\{entry\.node\}\s*<\/Suspense>/,
    );
  });

  it("wraps each tile-strip cell in a `<Suspense>` boundary", () => {
    const src = load(PAGE_PATH);
    // `<Suspense fallback={null}>{entry.node}</Suspense>` — the tile
    // body is synchronous today so a `null` fallback never paints,
    // but the boundary primes the row for a future RSC hoist of any
    // tile slot. Pinning the literal keeps the structural contract
    // visible in CI.
    expect(src).toMatch(
      /<Suspense\s+fallback=\{null\}>\s*\{entry\.node\}\s*<\/Suspense>/,
    );
  });

  it("hoists DASHBOARD_QUERY_OPTS to module scope (audit-M2)", () => {
    const src = load(PAGE_PATH);
    // Module-scope declaration — search outside the component body.
    // Pre-fix the const was declared inside `DashboardPage` so every
    // render created a fresh `{}` reference.
    const moduleSliceEnd = src.indexOf("export default function DashboardPage");
    expect(moduleSliceEnd).toBeGreaterThan(0);
    const moduleSlice = src.slice(0, moduleSliceEnd);
    expect(moduleSlice).toMatch(/const\s+DASHBOARD_QUERY_OPTS\s*=\s*\{/);
  });

  it("memoises the hour-of-day derivation against user.timezone (audit-H4)", () => {
    const src = load(PAGE_PATH);
    // The greeting hour only changes when the user's timezone changes
    // — a `useMemo` keyed on the lifted `userTimezone` local keeps the
    // `Intl.DateTimeFormat` instantiation off the per-render hot path.
    // Post-W-INFRA Thread 2: `user?.timezone` is lifted to a `userTimezone`
    // local one line above the `useMemo` so the dep array stays stable.
    expect(src).toMatch(
      /const\s+hour\s*=\s*useMemo\([\s\S]*?\[\s*userTimezone\s*\][\s\S]*?\);/,
    );
  });
});

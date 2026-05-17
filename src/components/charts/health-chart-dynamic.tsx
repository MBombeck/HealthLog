"use client";

import dynamic from "next/dynamic";

import { ChartSkeleton } from "@/components/charts/chart-skeleton";

/**
 * v1.4.28 (BK-F-M2) — single `next/dynamic` boundary for the
 * canonical `<HealthChart>` component.
 *
 * Pre-fix, eight call sites (`src/app/page.tsx`, five insights
 * sub-pages, `sleep-duration-chart.tsx`, `trends-row.tsx`, and
 * `vo2-max-chart-row.tsx`) duplicated the same
 * `dynamic(() => import("@/components/charts/health-chart"), { ... })`
 * incantation. The duplication meant the loading skeleton + `ssr: false`
 * flag had to be re-wired on every caller.
 *
 * Re-exporting through this module gives every consumer the same
 * pre-configured `<ChartSkeleton>`-backed lazy boundary. Consumers
 * still forward the same props they did before — the type contract
 * mirrors `<HealthChart>` exactly via `dynamic()`'s own inference.
 */
export const HealthChartDynamic = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

/**
 * v1.4.36 W2 — mini variant for the trends-row 140 px chart slot. Same
 * underlying `<HealthChart>` import, but the loading shell renders the
 * `mini` `<ChartSkeleton>` so the loading box matches the painted
 * chart's footprint instead of inflating past the row contract.
 *
 * Consumers inside a fixed-height row (BP + weight cards in
 * `trends-row.tsx`) pass `mini` on the chart itself; this wrapper
 * ensures the next/dynamic loader paints the matching skeleton.
 */
export const HealthChartDynamicMini = dynamic(
  () =>
    import("@/components/charts/health-chart").then((mod) => ({
      default: mod.HealthChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton mini /> },
);

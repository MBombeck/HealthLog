"use client";

import dynamic from "next/dynamic";

import { ChartSkeleton } from "@/components/charts/chart-skeleton";

/**
 * v1.4.28 R3d (BK-F-M2) — single `next/dynamic` boundary for the
 * canonical `<HealthChart>` component.
 *
 * Pre-fix, six call sites (`src/app/page.tsx`, the five insights
 * sub-pages, and `sleep-duration-chart.tsx`) duplicated the same
 * `dynamic(() => import("@/components/charts/health-chart"), { ... })`
 * incantation. The duplication meant the loading skeleton + `ssr: false`
 * flag had to be re-wired on every caller (R1.2 H4 paid for this once;
 * this commit prevents future regressions).
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

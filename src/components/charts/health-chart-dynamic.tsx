"use client";

import dynamic from "next/dynamic";
import type { ComponentProps, ReactElement } from "react";

import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { importWithRetry } from "@/lib/retry-import";

/**
 * v1.4.28 (BK-F-M2) — single `next/dynamic` boundary for the
 * canonical `<HealthChart>` component.
 *
 * Pre-fix, eight call sites (`src/app/page.tsx`, five insights
 * sub-pages, `sleep-duration-chart.tsx`, `trends-row.tsx`, and
 * `vo2-max-chart-row.tsx`) duplicated the same
 * `dynamic(() => import("@/components/charts/chart-runtime"), { ... })`
 * incantation. The duplication meant the loading skeleton + `ssr: false`
 * flag had to be re-wired on every caller.
 *
 * Re-exporting through this module gives every consumer the same
 * pre-configured `<ChartSkeleton>`-backed lazy boundary. Consumers
 * still forward the same props they did before.
 *
 * v1.16.8 — the loader retries a rejected chunk import once (a lazy
 * import caches its rejection permanently, so a transient 404 from a
 * stale shell used to brick the card for the session) and every mount
 * wraps in `<ChartErrorBoundary>` so a chunk that still fails degrades
 * to ONE error card with a reload affordance instead of bubbling to the
 * route-level `error.tsx`.
 */
const loadHealthChart = () =>
  importWithRetry(() => import("@/components/charts/chart-runtime")).then(
    (mod) => ({ default: mod.HealthChart }),
  );

// One lazy boundary per footer shape: `next/dynamic`'s loading slot gets no
// props, so the shell that must match a day-linked chart with its data table
// is its own boundary. All four resolve the same chunk.
const HealthChartLazy = dynamic(loadHealthChart, {
  ssr: false,
  loading: () => <ChartSkeleton />,
});
const HealthChartLazyDay = dynamic(loadHealthChart, {
  ssr: false,
  loading: () => <ChartSkeleton dayLinks />,
});
const HealthChartLazyTable = dynamic(loadHealthChart, {
  ssr: false,
  loading: () => <ChartSkeleton dataTable />,
});
const HealthChartLazyDayTable = dynamic(loadHealthChart, {
  ssr: false,
  loading: () => <ChartSkeleton dayLinks dataTable />,
});

export function HealthChartDynamic(
  props: ComponentProps<typeof HealthChartLazy>,
): ReactElement {
  const Lazy = props.mini
    ? HealthChartLazy
    : props.dayLinks
      ? props.showDataTable
        ? HealthChartLazyDayTable
        : HealthChartLazyDay
      : props.showDataTable
        ? HealthChartLazyTable
        : HealthChartLazy;
  return (
    <ChartErrorBoundary>
      <Lazy {...props} />
    </ChartErrorBoundary>
  );
}

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
const HealthChartLazyMini = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.HealthChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton mini /> },
);

export function HealthChartDynamicMini(
  props: ComponentProps<typeof HealthChartLazyMini>,
): ReactElement {
  return (
    <ChartErrorBoundary>
      <HealthChartLazyMini {...props} />
    </ChartErrorBoundary>
  );
}

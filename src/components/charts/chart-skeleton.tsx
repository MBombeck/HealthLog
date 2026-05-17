"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.28 R3d (R1.2 H4) — layout-stable loading shell for every
 * `next/dynamic` chart import on the dashboard and the insights
 * sub-pages.
 *
 * The chart components (`<HealthChart>`, `<MoodChart>`, …) live behind
 * `dynamic(() => import("…"), { ssr: false })`. Pre-fix, the loading
 * slot was empty: the page hydrated, the Recharts chunk fetched, and
 * the layout collapsed/expanded as the chart arrived. On a cold visit
 * over a slow network the gap was visible for several seconds (R1.2
 * H4).
 *
 * This skeleton mirrors the same container that `health-chart.tsx`
 * paints (rounded card, border, `p-4 md:p-6`) plus a faux header row
 * (title + range tabs) and a chart band sized to the CSS variable the
 * chart itself reads (`--chart-height` → 240 px mobile / 280 px md+).
 * The cumulative box matches the loaded chart's height to within a
 * pixel so the page does not jump on hydration.
 *
 * v1.4.36 W2 — `mini` variant for the trends-row 140 px chart slot.
 * The default skeleton's rounded-xl border + p-4/p-6 padding inflated
 * past the 140 px wrapper and pushed the row taller than the loaded
 * chart, re-introducing the very layout shift the wrapper now
 * eliminates. The mini variant trades the card chrome for
 * `rounded-md p-2` and pins the inner band at 140 px so the loading
 * shell occupies the same visible box as the painted chart.
 *
 * `prefers-reduced-motion` is honoured automatically — the `<Skeleton>`
 * primitive's `animate-pulse` is suppressed via Tailwind's
 * `motion-reduce:animate-none` modifier.
 */
export function ChartSkeleton({
  className,
  mini = false,
}: {
  className?: string;
  /**
   * When true, render the compact variant used inside the trends-row
   * chart slot (140 px band, lighter chrome). Defaults to false for
   * the dashboard hero / sub-page charts.
   */
  mini?: boolean;
}) {
  const { t } = useTranslations();
  if (mini) {
    return (
      <div
        data-slot="chart-skeleton"
        data-mini="true"
        role="status"
        aria-busy="true"
        aria-live="polite"
        className={cn("bg-card border-border rounded-md border p-2", className)}
      >
        <span className="sr-only">{t("charts.loadingLabel")}</span>
        <Skeleton className="h-[140px] w-full" />
      </div>
    );
  }
  return (
    <div
      data-slot="chart-skeleton"
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(
        "bg-card border-border rounded-xl border p-4 md:p-6",
        className,
      )}
    >
      {/* v1.4.34 IW-G — sr-only announcement now reads the locale's
          `charts.loadingLabel` key instead of literal English. */}
      <span className="sr-only">{t("charts.loadingLabel")}</span>

      {/* Header row — title + range tabs match the real chart's
          `mb-4 flex flex-col gap-2 sm:flex-row` chrome. */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-4 w-32" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-6 w-12" />
        </div>
      </div>

      {/* Chart band — mirrors the same `h-[var(--chart-height,…)]`
          contract `health-chart.tsx` paints at line 1087-1089. */}
      <Skeleton className="h-[var(--chart-height,240px)] w-full md:h-[var(--chart-height-md,280px)]" />
    </div>
  );
}

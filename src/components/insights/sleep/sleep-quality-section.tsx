"use client";

import { Activity, Gauge, Moon, Repeat, Target, Waves } from "lucide-react";

import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { SectionHeading } from "@/components/ui/section-heading";
import { DeviceScoreTile } from "@/components/insights/device-score-tile";
import { DeviceScoreGridSkeleton } from "@/components/insights/device-score-tile-skeleton";

/**
 * v1.17.1 — "Sleep quality" block on `/insights/sleep`.
 *
 * Surfaces the WHOOP / Oura nightly sleep-quality scores that were ingested
 * end-to-end but rendered nowhere: efficiency, performance, consistency, need,
 * disturbance count, and the Oura headline sleep score. Each tile is gated on
 * the metric having data (`<DeviceScoreTile>` returns null at count 0), so a
 * non-wearable user never sees an empty card and the whole section collapses
 * when none of the six has readings.
 *
 * Reads the shared `["analytics", "summaries"]` slice — the same cache the
 * page's duration gate already populated, so this adds no network round-trip.
 * Server-authoritative: the tiles render the stored values, never a recompute.
 */
export function SleepQualitySection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const { data, isLoading } = useInsightsAnalytics("SLEEP_DURATION");

  if (!enabled) return null;

  const summaries = data?.summaries;

  // While the shared slice loads, paint the tile-shaped Skeleton grid (same
  // primitive the recovery + labs surfaces use) rather than nothing, so the
  // section does not pop in. Once data lands the section either renders its
  // present tiles or collapses to null — an in-page sub-section never shows a
  // standalone empty card (the page-level empties on /insights/recovery and
  // /labs own that treatment via <EmptyState>).
  if (isLoading || !summaries) {
    return (
      <section data-slot="sleep-quality-loading" className="space-y-3">
        <SectionHeading icon={Moon} title={t("insights.sleepQuality.title")} />
        <DeviceScoreGridSkeleton count={2} />
      </section>
    );
  }

  const tiles: Array<{
    type: string;
    title: string;
    icon: typeof Moon;
    color: string;
    unit?: string;
  }> = [
    {
      type: "SLEEP_SCORE",
      title: t("measurements.typeSleepScore"),
      icon: Moon,
      color: "var(--chart-1)",
      unit: t("insights.deviceScore.unitScore"),
    },
    {
      type: "SLEEP_PERFORMANCE",
      title: t("measurements.typeSleepPerformance"),
      icon: Target,
      color: "var(--chart-4)",
      unit: "%",
    },
    {
      type: "SLEEP_EFFICIENCY",
      title: t("measurements.typeSleepEfficiency"),
      icon: Gauge,
      color: "var(--chart-2)",
      unit: "%",
    },
    {
      type: "SLEEP_CONSISTENCY",
      title: t("measurements.typeSleepConsistency"),
      icon: Repeat,
      color: "var(--chart-5)",
      unit: "%",
    },
    {
      type: "SLEEP_NEED",
      title: t("measurements.typeSleepNeed"),
      icon: Waves,
      color: "var(--chart-5)",
      unit: t("insights.deviceScore.unitMinutes"),
    },
    {
      type: "SLEEP_DISTURBANCE_COUNT",
      title: t("measurements.typeSleepDisturbanceCount"),
      icon: Activity,
      color: "var(--chart-3)",
    },
  ];

  const present = tiles.filter(
    (tile) => (summaries[tile.type]?.count ?? 0) > 0,
  );
  if (present.length === 0) return null;

  return (
    <section data-slot="sleep-quality-section" className="space-y-3">
      <SectionHeading
        icon={Moon}
        title={t("insights.sleepQuality.title")}
        action={
          <p className="text-muted-foreground text-xs">
            {t("insights.sleepQuality.subtitle")}
          </p>
        }
      />
      <div
        className={cn(
          "grid gap-4",
          // Two-up only when more than one metric has data; a lone tile spans
          // the full row rather than leaving a half-width orphan.
          present.length > 1 && "sm:grid-cols-2",
        )}
      >
        {present.map((tile) => (
          <DeviceScoreTile
            key={tile.type}
            type={tile.type}
            summary={summaries[tile.type]}
            title={tile.title}
            icon={tile.icon}
            color={tile.color}
            unit={tile.unit}
          />
        ))}
      </div>
    </section>
  );
}

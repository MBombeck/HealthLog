"use client";

import {
  Activity,
  Battery,
  Flame,
  Gauge,
  Heart,
  HeartPulse,
  TrendingUp,
} from "lucide-react";

import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useTranslations } from "@/lib/i18n/context";
import { EmptyState } from "@/components/ui/empty-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { RestModeBanner } from "@/components/insights/rest-mode-banner";
import type { RestModeAnnotation } from "@/lib/analytics/score/types";
import type { ChartOverlayKey } from "@/lib/dashboard-layout";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import { RecoveryMetricBlock } from "@/components/insights/recovery/recovery-metric-block";
import { ResilienceTile } from "@/components/insights/recovery/resilience-tile";

interface BlockSpec {
  type: string;
  chartKey: ChartOverlayKey;
  statusMetric: MetricStatusMetricId;
  title: string;
  explainer: string;
  icon: typeof Activity;
  color: string;
  unit: string;
  fractionDigits?: number;
}

interface BlockGroup {
  key: string;
  blocks: BlockSpec[];
}

/**
 * v1.17.1 → rebuilt v1.18.1 (B1–B3) — body of the `/insights/recovery`
 * sub-page.
 *
 * The page now reads exactly like every other metric page: each present
 * device-native signal (WHOOP / Polar / Oura recharge, strain, load, and
 * whole-day cardiac / energy figures) renders as a canonical block — a
 * short explanatory line, the max / median / mean stat strip, the same
 * `<HealthChartDynamic>` chart with the identical 7 / 30 / 90 / All toggle,
 * and a per-chart AI assessment (`<MetricStatusCard>`). The composite
 * RECOVERY_SCORE keeps its anatomy view at `/insights/scores/recovery`.
 *
 * B3 — the redundant "Recovery score" link block that used to lead the
 * page is gone: this surface is reached from the overview already, so the
 * cross-link was duplicate ("doppelt gemoppelt").
 *
 * Each block is data-gated (a signal with zero readings is dropped) and a
 * group with no present block hides entirely, so a non-wearable account
 * sees only the calm empty note. Reads the shared analytics summaries slice
 * (no extra round-trip); server-authoritative throughout.
 */
export function RecoverySection() {
  const { t } = useTranslations();
  const { data, isLoading } = useInsightsAnalytics("SLEEP_DURATION");
  // v1.18.1 — Rest Mode parity. The annotation rides the thick analytics
  // payload's `healthScore` block (server-authoritative; iOS mirrors it). We
  // read it off the same `["analytics"]` cache the insights mother page
  // primes, so navigating in is a free hit and a direct URL load pays one
  // thick fetch. Read-only — the score itself stays untouched.
  const analyticsQuery = useAnalyticsQuery();
  const restMode = ((
    analyticsQuery.data?.healthScore as { restMode?: RestModeAnnotation } | null
  )?.restMode ?? null) as RestModeAnnotation | null;

  const summaries = data?.summaries;
  const unitScore = t("insights.deviceScore.unitScore");
  const unitBpm = t("insights.deviceScore.unitBpm");
  const unitKj = t("insights.deviceScore.unitKj");

  const groups: BlockGroup[] = [
    {
      key: "recharge",
      blocks: [
        {
          type: "ANS_CHARGE",
          chartKey: "ansCharge",
          statusMetric: "ANS_CHARGE",
          title: t("measurements.typeAnsCharge"),
          explainer: t("insights.recovery.block.ansChargeExplainer"),
          icon: Battery,
          color: "var(--chart-2)",
          unit: unitScore,
          fractionDigits: 1,
        },
      ],
    },
    {
      key: "strain",
      blocks: [
        {
          type: "DAY_STRAIN",
          chartKey: "dayStrain",
          statusMetric: "DAY_STRAIN",
          title: t("measurements.typeDayStrain"),
          explainer: t("insights.recovery.block.dayStrainExplainer"),
          icon: Gauge,
          color: "var(--chart-5)",
          unit: unitScore,
          fractionDigits: 1,
        },
        {
          type: "WORKOUT_STRAIN",
          chartKey: "workoutStrain",
          statusMetric: "WORKOUT_STRAIN",
          title: t("measurements.typeWorkoutStrain"),
          explainer: t("insights.recovery.block.workoutStrainExplainer"),
          icon: Activity,
          color: "var(--chart-3)",
          unit: unitScore,
          fractionDigits: 1,
        },
        {
          type: "CARDIO_LOAD",
          chartKey: "cardioLoad",
          statusMetric: "CARDIO_LOAD",
          title: t("measurements.typeCardioLoad"),
          explainer: t("insights.recovery.block.cardioLoadExplainer"),
          icon: TrendingUp,
          color: "var(--chart-1)",
          unit: unitScore,
        },
      ],
    },
    {
      key: "cardio",
      blocks: [
        {
          type: "AVERAGE_HEART_RATE",
          chartKey: "averageHeartRate",
          statusMetric: "AVERAGE_HEART_RATE",
          title: t("measurements.typeAverageHeartRate"),
          explainer: t("insights.recovery.block.averageHeartRateExplainer"),
          icon: Heart,
          color: "var(--chart-4)",
          unit: unitBpm,
        },
        {
          type: "MAX_HEART_RATE",
          chartKey: "maxHeartRate",
          statusMetric: "MAX_HEART_RATE",
          title: t("measurements.typeMaxHeartRate"),
          explainer: t("insights.recovery.block.maxHeartRateExplainer"),
          icon: HeartPulse,
          color: "var(--chart-3)",
          unit: unitBpm,
        },
        {
          type: "ENERGY_EXPENDITURE_KJ",
          chartKey: "energyExpenditureKj",
          statusMetric: "ENERGY_EXPENDITURE_KJ",
          title: t("measurements.typeEnergyExpenditureKj"),
          explainer: t("insights.recovery.block.energyExpenditureKjExplainer"),
          icon: Flame,
          color: "var(--chart-5)",
          unit: unitKj,
        },
      ],
    },
  ];

  // v1.19.2 — resilience is an ordinal band (limited … exceptional), surfaced
  // as a calm dedicated tile rather than a chart block, so it counts toward the
  // data gate independently of `groups` (a chart-block list).
  const hasResilience = (summaries?.["RESILIENCE"]?.count ?? 0) > 0;

  const hasAny =
    summaries != null &&
    (hasResilience ||
      groups.some((group) =>
        group.blocks.some((block) => (summaries[block.type]?.count ?? 0) > 0),
      ));

  if (isLoading || summaries == null) {
    return (
      <div className="space-y-3" data-slot="recovery-loading">
        <ChartSkeleton />
      </div>
    );
  }

  if (!hasAny) {
    return (
      <EmptyState
        data-slot="recovery-empty"
        icon={<Heart className="size-6" />}
        title={t("insights.recovery.emptyTitle")}
        description={t("insights.recovery.empty")}
      />
    );
  }

  // v1.18.6 — the per-group sub-headings ("Recharge" / "Strain & load" /
  // "Daily heart & energy") are gone: read next to the page's "Erholung"
  // heading they were redundant chrome. The groups still drive ORDER + the
  // data gate (a group with no present block contributes nothing); their
  // present blocks now render as one flat, evenly-spaced stack, each block
  // carrying its own title + explainer so nothing loses context.
  const presentBlocks = groups.flatMap((group) =>
    group.blocks.filter((block) => (summaries[block.type]?.count ?? 0) > 0),
  );

  return (
    <div className="space-y-8" data-slot="recovery-section">
      {/* v1.18.1 — calm Rest Mode cue at the head of the recovery surface.
          Self-gating: renders nothing unless an episode is active. */}
      <RestModeBanner annotation={restMode} />
      {/* v1.19.2 — Oura resilience band, self-gating (renders nothing without
          a reading). A calm ordinal readout, not a chart block. */}
      <ResilienceTile />
      {presentBlocks.map((block) => (
        <RecoveryMetricBlock
          key={block.type}
          type={block.type}
          chartKey={block.chartKey}
          statusMetric={block.statusMetric}
          title={block.title}
          explainer={block.explainer}
          icon={block.icon}
          color={block.color}
          unit={block.unit}
          summary={summaries[block.type] ?? null}
          fractionDigits={block.fractionDigits}
        />
      ))}
    </div>
  );
}

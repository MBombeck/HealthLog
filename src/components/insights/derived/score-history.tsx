"use client";

import dynamic from "next/dynamic";
import { History } from "lucide-react";

import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { useAuth } from "@/hooks/use-auth";
import type { ChartOverlayKey } from "@/lib/dashboard-layout";
import { useTranslations } from "@/lib/i18n/context";
import { importWithRetry } from "@/lib/retry-import";
import { RING_GRADIENT, type RingHue } from "./ring-hues";

/**
 * v1.42 — a score's course over time on its page, directly under the score
 * card.
 *
 * The three nightly scores (recovery, stress, strain) are stored readings, so
 * they get the full metric chart every measured page carries. The health
 * score, readiness and the sleep score are not stored as readings; their
 * daily course comes from the score-history route and draws in
 * `<ScoreTrendChart>`. Both offer the same range tabs (7 / 30 / 90 / All),
 * remembered per score page, and open each day from its point.
 */

/** The health score, readiness and sleep score history, loaded with Recharts. */
export const ScoreTrendChartDynamic = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.ScoreTrendChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton dayLinks dataTable /> },
);

export function ScoreHistoryChart({
  type,
  hue,
  chartKey,
}: {
  /** The stored measurement type the score is written as — or, for a strain
   *  score served from the device, the device's own `DAY_STRAIN`. */
  type: "RECOVERY_SCORE" | "STRESS_SCORE" | "STRAIN_SCORE" | "DAY_STRAIN";
  hue: RingHue;
  /** The slot the range tab is remembered under. */
  chartKey: ChartOverlayKey;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  return (
    <div data-slot="score-history-chart" data-type={type}>
      <HealthChartDynamic
        types={[type]}
        title={t("insights.derived.scores.historyTitle")}
        titleIcon={History}
        colors={[RING_GRADIENT[hue][1]]}
        unit={t("insights.deviceScore.unitScore")}
        userTimezone={user?.timezone}
        chartKey={chartKey}
        overlayControls={false}
        dayLinks
      />
    </div>
  );
}

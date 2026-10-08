"use client";

import dynamic from "next/dynamic";
import { History } from "lucide-react";

import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { RING_GRADIENT, type RingHue } from "./ring-hues";

/**
 * v1.42 — a score's course over time on its detail page, directly under the
 * score card.
 *
 * The three nightly scores (recovery, stress, strain) are stored readings, so
 * they get the full metric chart every measured page carries: the 7 / 30 / 90
 * / All switch, the tooltip, and each day opening its day view. The two
 * composites (sleep score, readiness) are computed rather than stored, so the
 * course they carry on their value is drawn as a compact line over its window.
 */

const DeltaSparkline = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.DeltaSparkline,
    })),
  { ssr: false, loading: () => null },
);

export function ScoreHistoryChart({
  type,
  hue,
}: {
  /** The stored measurement type the score is written as — or, for a strain
   *  score served from the device, the device's own `DAY_STRAIN`. */
  type: "RECOVERY_SCORE" | "STRESS_SCORE" | "STRAIN_SCORE" | "DAY_STRAIN";
  hue: RingHue;
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
        dayLinks
      />
    </div>
  );
}

export function ScoreHistoryCard({
  series,
  windowDays,
  hue,
}: {
  series: number[];
  windowDays: number;
  hue: RingHue;
}) {
  const { t } = useTranslations();
  return (
    <Card data-slot="score-history-card" className="gap-2 py-3 md:py-4">
      <CardHeader>
        <TileHeader
          icon={History}
          title={t("insights.derived.scores.historyTitle")}
          right={
            <span className="text-muted-foreground text-xs">
              {t("insights.derived.scores.historyWindow", { days: windowDays })}
            </span>
          }
        />
      </CardHeader>
      <CardContent>
        <div className="h-24 w-full" aria-hidden="true">
          <DeltaSparkline
            data={series.map((v, i) => ({ i, v }))}
            strokeVar={RING_GRADIENT[hue][1]}
            domain={[0, 100]}
          />
        </div>
      </CardContent>
    </Card>
  );
}
